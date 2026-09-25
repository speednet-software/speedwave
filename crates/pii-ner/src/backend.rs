//! Backend selection: CPU via ndarray, GPU via wgpu, with a non-panicking probe.

use std::path::Path;

use burn::backend::ndarray::NdArrayDevice;
use burn::backend::wgpu::graphics::AutoGraphicsApi;
use burn::backend::wgpu::{init_setup, RuntimeOptions, WgpuDevice};

use crate::error::LoadError;
use crate::pipeline::Detector;
use crate::Detect;

/// CPU backend used for tests, CI and hosts without a usable GPU.
pub type CpuBackend = burn::backend::NdArray<f32>;
/// GPU backend: Metal on macOS, Vulkan or DirectX 12 on Windows, chosen by wgpu.
pub type GpuBackend = burn::backend::Wgpu<f32, i32>;

/// Where a detector runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Device {
    /// ndarray on the CPU.
    Cpu,
    /// wgpu on the default GPU adapter.
    Gpu,
}

/// Which device the caller wants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DevicePreference {
    /// GPU when an adapter exists, otherwise CPU.
    #[default]
    Auto,
    /// CPU only.
    Cpu,
    /// GPU only; loading fails without an adapter.
    Gpu,
}

/// Initializes the default wgpu adapter on a helper thread; `None` when wgpu finds no adapter.
pub fn gpu_device() -> Option<WgpuDevice> {
    std::thread::Builder::new()
        .name("pii-ner-gpu-probe".to_string())
        .spawn(|| {
            let device = WgpuDevice::DefaultDevice;
            init_setup::<AutoGraphicsApi>(&device, RuntimeOptions::default());
            device
        })
        .ok()?
        .join()
        .ok()
}

/// True when a GPU adapter can be initialized.
pub fn gpu_available() -> bool {
    gpu_device().is_some()
}

/// Loads the artifact on the preferred device, falling back to CPU under `Auto`.
pub fn load_auto(
    artifact_dir: &Path,
    preference: DevicePreference,
) -> Result<Box<dyn Detect>, LoadError> {
    match preference {
        DevicePreference::Cpu => load_cpu(artifact_dir),
        DevicePreference::Gpu => {
            let device = gpu_device().ok_or(LoadError::NoGpu)?;
            load_gpu(artifact_dir, device)
        }
        DevicePreference::Auto => match gpu_device() {
            Some(device) => load_gpu(artifact_dir, device),
            None => {
                log::info!(target: "pii_ner", "no GPU adapter found, running the detector on the CPU");
                load_cpu(artifact_dir)
            }
        },
    }
}

fn load_cpu(artifact_dir: &Path) -> Result<Box<dyn Detect>, LoadError> {
    Ok(Box::new(Detector::<CpuBackend>::load(
        artifact_dir,
        NdArrayDevice::Cpu,
        Device::Cpu,
    )?))
}

fn load_gpu(artifact_dir: &Path, device: WgpuDevice) -> Result<Box<dyn Detect>, LoadError> {
    Ok(Box::new(Detector::<GpuBackend>::load(
        artifact_dir,
        device,
        Device::Gpu,
    )?))
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::*;
    use crate::pipeline::test_support::write_tiny_artifact;

    #[test]
    fn cpu_preference_loads_on_the_cpu() {
        let dir = tempfile::tempdir().unwrap();
        write_tiny_artifact(dir.path());
        let detector = load_auto(dir.path(), DevicePreference::Cpu).unwrap();
        assert_eq!(detector.device(), Device::Cpu);
    }

    #[test]
    fn device_serializes_snake_case() {
        assert_eq!(serde_json::to_string(&Device::Gpu).unwrap(), "\"gpu\"");
        assert_eq!(DevicePreference::default(), DevicePreference::Auto);
    }
}
