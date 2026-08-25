//! Runtime Vulkan device probe (ADR-085): what GPU the host actually has, so model tiers and
//! whisper's `use_gpu` reflect hardware, not just the backends compiled into this binary.

#[cfg(any(windows, test))]
use super::accel::GpuClass;

/// Classifies raw `VkPhysicalDeviceType` values (the numeric wire values, so the logic is
/// unit-testable off-Windows): the best device wins; CPU/software implementations count as none.
#[cfg(any(windows, test))]
pub(super) fn classify_device_types(device_types: &[i32]) -> GpuClass {
    const INTEGRATED_GPU: i32 = 1;
    const DISCRETE_GPU: i32 = 2;
    const VIRTUAL_GPU: i32 = 3;
    if device_types.contains(&DISCRETE_GPU) {
        return GpuClass::Discrete;
    }
    if device_types
        .iter()
        .any(|t| *t == INTEGRATED_GPU || *t == VIRTUAL_GPU)
    {
        return GpuClass::Integrated;
    }
    GpuClass::None
}

/// Enumerates Vulkan devices via the dynamically loaded `vulkan-1.dll`. Every failure (no
/// loader, no ICD, no devices) degrades to `GpuClass::None`, never an error.
#[cfg(windows)]
#[expect(
    unsafe_code,
    reason = "Vulkan FFI boundary via ash; every block has a SAFETY comment"
)]
pub(super) fn probe() -> GpuClass {
    use ash::vk;
    // SAFETY: Entry::load dynamically loads vulkan-1.dll; failure returns Err (no loader).
    let Ok(entry) = (unsafe { ash::Entry::load() }) else {
        log::debug!(target: "transcription::gpu", "vulkan-1.dll not loadable — no GPU probe");
        return GpuClass::None;
    };
    let create_info = vk::InstanceCreateInfo::default();
    // SAFETY: valid default create-info; a loader without a usable ICD fails here cleanly.
    let Ok(instance) = (unsafe { entry.create_instance(&create_info, None) }) else {
        log::debug!(target: "transcription::gpu", "vkCreateInstance failed — no usable Vulkan driver");
        return GpuClass::None;
    };
    // SAFETY: `instance` is valid until the destroy below.
    let devices = match unsafe { instance.enumerate_physical_devices() } {
        Ok(d) => d,
        Err(e) => {
            // Distinguish "enumeration failed" from a genuine zero-device host in the logs.
            log::debug!(target: "transcription::gpu", "vkEnumeratePhysicalDevices failed: {e}");
            Vec::new()
        }
    };
    // SAFETY: `instance` is valid until the destroy below; `d` came from it.
    let device_types: Vec<i32> = unsafe {
        devices
            .into_iter()
            .map(|d| {
                instance
                    .get_physical_device_properties(d)
                    .device_type
                    .as_raw()
            })
            .collect()
    };
    // SAFETY: no child objects were created from this instance.
    unsafe { instance.destroy_instance(None) };
    let class = classify_device_types(&device_types);
    log::info!(
        target: "transcription::gpu",
        "vulkan probe: {} device(s) → {class:?}",
        device_types.len()
    );
    class
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_prefers_discrete_then_integrated_then_none() {
        // Discrete wins whatever else is present (the common iGPU + dGPU laptop).
        assert_eq!(classify_device_types(&[1, 2]), GpuClass::Discrete);
        assert_eq!(classify_device_types(&[2]), GpuClass::Discrete);
        // Integrated or virtual GPUs land in the middle tier.
        assert_eq!(classify_device_types(&[1]), GpuClass::Integrated);
        assert_eq!(classify_device_types(&[3]), GpuClass::Integrated);
        // Software rasterizers (CPU type 4) and OTHER (0) give no speedup — treated as none.
        assert_eq!(classify_device_types(&[4]), GpuClass::None);
        assert_eq!(classify_device_types(&[0]), GpuClass::None);
        assert_eq!(classify_device_types(&[]), GpuClass::None);
        // A software device never masks a real one.
        assert_eq!(classify_device_types(&[4, 1]), GpuClass::Integrated);
    }
}
