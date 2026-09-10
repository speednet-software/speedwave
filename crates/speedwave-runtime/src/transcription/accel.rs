//! Which whisper.cpp acceleration backends this binary was compiled with, the runtime GPU class,
//! and the matching live/finalize models (ADR-056 Am. 11/12, ADR-085).

use std::sync::OnceLock;

use crate::transcription::model_catalog::{
    ModelRole, Quantization, WhisperModelInfo, WHISPER_MODELS,
};

/// The GPU backend whisper.cpp was compiled against, or `None` for a CPU-only build: Metal on
/// macOS, Vulkan on Windows (ADR-085). CUDA stays deferred (ADR-056). CPU is always compiled in.
fn compiled_gpu_backend() -> Option<&'static str> {
    #[cfg(all(feature = "audio-transcription", target_os = "macos"))]
    {
        Some("Metal")
    }
    #[cfg(all(feature = "audio-transcription", windows))]
    {
        Some("Vulkan")
    }
    #[cfg(not(all(feature = "audio-transcription", any(target_os = "macos", windows))))]
    {
        None
    }
}

/// What GPU the host actually offers (ADR-085) — a compiled-in backend is not a usable device.
/// Ordered weakest → strongest, so `live_floor` comparisons read naturally.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum GpuClass {
    /// No usable GPU (or only a software rasterizer) — CPU tiers, whisper `use_gpu` off.
    None,
    /// An integrated/virtual GPU: worth using for compute, not fast enough for GPU-tier models.
    Integrated,
    /// A discrete GPU (or Apple Metal): GPU-tier models for both passes.
    Discrete,
}

/// The host's GPU class, probed once per process (hardware does not change mid-session).
/// macOS reports `Discrete` (Metal is compiled in and Apple GPUs carry the GPU-tier models).
pub fn gpu_class() -> GpuClass {
    static CLASS: OnceLock<GpuClass> = OnceLock::new();
    *CLASS.get_or_init(|| {
        #[cfg(all(feature = "audio-transcription", target_os = "macos"))]
        {
            GpuClass::Discrete
        }
        #[cfg(all(feature = "audio-transcription", windows))]
        {
            super::gpu_probe::probe()
        }
        #[cfg(not(all(feature = "audio-transcription", any(target_os = "macos", windows))))]
        {
            GpuClass::None
        }
    })
}

/// Acceleration label for the UI: the runtime truth, not the compile-time hope — a Vulkan build
/// with no usable device says `CPU`.
pub fn accel_label() -> String {
    match (gpu_class(), compiled_gpu_backend()) {
        (GpuClass::Discrete, Some(name)) => format!("{name} (GPU)"),
        (GpuClass::Integrated, Some(name)) => format!("{name} (integrated GPU)"),
        _ => "CPU".to_string(),
    }
}

/// Ceiling on whisper decode threads. Scaling flattens well before this on laptop CPUs, and
/// Speedwave also runs a VM full of containers that must not be starved of cores.
const MAX_DECODE_THREADS: usize = 8;

/// Threads to give whisper.cpp. It is matmul- and bandwidth-bound, so SMT siblings add no
/// throughput; its own default of `min(4, logical)` leaves most of a modern laptop idle.
pub fn decode_threads() -> i32 {
    num_cpus::get_physical().clamp(1, MAX_DECODE_THREADS) as i32
}

/// The full-precision catalogue entry for `role`, falling back to the first entry so a catalogue
/// edit can never leave the pipeline without a model.
fn full_model_with_role(role: ModelRole) -> &'static WhisperModelInfo {
    WHISPER_MODELS
        .iter()
        .find(|m| m.role == role && matches!(m.quantization, Quantization::Full))
        .unwrap_or(&WHISPER_MODELS[0])
}

/// The live-pass model for a host GPU `class`: `large-v3-turbo` where a discrete GPU carries
/// it, `small` everywhere else (an iGPU cannot hold the GPU-tier model at live cadence).
pub(super) fn live_model_for_class(class: GpuClass) -> &'static WhisperModelInfo {
    full_model_with_role(match class {
        GpuClass::Discrete => ModelRole::GpuLive,
        GpuClass::Integrated | GpuClass::None => ModelRole::CpuLive,
    })
}

/// The finalize-pass model for `class`: `large-v3` on a discrete GPU, else the turbo variant —
/// the largest that still finishes a long meeting (4 decoder layers against 32).
pub(super) fn finalize_model_for_class(class: GpuClass) -> &'static WhisperModelInfo {
    full_model_with_role(match class {
        GpuClass::Discrete => ModelRole::Finalize,
        GpuClass::Integrated | GpuClass::None => ModelRole::GpuLive,
    })
}

/// The live-pass model for this host, from the probed GPU class.
pub fn live_model_for_this_build() -> &'static WhisperModelInfo {
    live_model_for_class(gpu_class())
}

/// The finalize-pass model for this host, from the probed GPU class.
pub fn finalize_model_for_this_build() -> &'static WhisperModelInfo {
    finalize_model_for_class(gpu_class())
}

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::expect_used, reason = "test code")]
mod tests {
    use super::*;

    #[test]
    fn compiled_gpu_backend_matches_the_platform_this_build_targets() {
        let expected = if cfg!(all(feature = "audio-transcription", target_os = "macos")) {
            Some("Metal")
        } else if cfg!(all(feature = "audio-transcription", windows)) {
            Some("Vulkan")
        } else {
            None
        };
        assert_eq!(compiled_gpu_backend(), expected);
    }

    #[test]
    fn gpu_backend_features_are_pinned_in_the_manifest() {
        // compiled_gpu_backend() keys on cfg(platform), not on how whisper-rs was built — pin the
        // manifest so silently dropping a GPU feature cannot leave `accel_label` lying.
        fn target_deps<'a>(manifest: &'a str, header: &str) -> &'a str {
            let start = manifest.find(header).expect("target dep section present");
            let rest = &manifest[start + header.len()..];
            &rest[..rest.find("\n[").unwrap_or(rest.len())]
        }
        let manifest = include_str!("../../Cargo.toml");
        let windows = target_deps(manifest, "[target.'cfg(windows)'.dependencies]");
        let whisper_windows = windows
            .lines()
            .find(|l| l.trim_start().starts_with("whisper-rs"))
            .expect("windows whisper-rs dep");
        assert!(
            whisper_windows.contains("\"vulkan\""),
            "whisper-rs on Windows must carry the vulkan feature: {whisper_windows}"
        );
        let macos = target_deps(
            manifest,
            "[target.'cfg(target_os = \"macos\")'.dependencies]",
        );
        let whisper_macos = macos
            .lines()
            .find(|l| l.trim_start().starts_with("whisper-rs"))
            .expect("macos whisper-rs dep");
        assert!(
            whisper_macos.contains("\"metal\""),
            "whisper-rs on macOS must carry the metal feature: {whisper_macos}"
        );
    }

    #[test]
    fn live_model_is_turbo_on_discrete_and_small_elsewhere() {
        assert_eq!(
            live_model_for_class(GpuClass::Discrete).key,
            "large-v3-turbo"
        );
        assert_eq!(live_model_for_class(GpuClass::Integrated).key, "small");
        assert_eq!(live_model_for_class(GpuClass::None).key, "small");
    }

    #[test]
    fn finalize_model_is_large_v3_on_discrete_and_turbo_elsewhere() {
        assert_eq!(finalize_model_for_class(GpuClass::Discrete).key, "large-v3");
        assert_eq!(
            finalize_model_for_class(GpuClass::Integrated).key,
            "large-v3-turbo"
        );
        assert_eq!(
            finalize_model_for_class(GpuClass::None).key,
            "large-v3-turbo"
        );
    }

    #[test]
    fn the_live_model_is_always_live_capable_on_its_own_class() {
        // The catalogue owns that judgement per GPU class: a bare live_capable bool let a
        // re-inverted tier mapping (turbo on CPU-only hosts) pass; the floor comparison catches it.
        for class in [GpuClass::None, GpuClass::Integrated, GpuClass::Discrete] {
            let m = live_model_for_class(class);
            assert!(
                m.live_capable_on(class),
                "live model {} is not live-capable on {class:?}",
                m.key
            );
        }
        assert!(live_model_for_this_build().live_capable_on(gpu_class()));
    }

    #[test]
    fn both_passes_pick_full_precision_models_for_every_class() {
        for class in [GpuClass::None, GpuClass::Integrated, GpuClass::Discrete] {
            for m in [live_model_for_class(class), finalize_model_for_class(class)] {
                assert!(matches!(m.quantization, Quantization::Full));
            }
        }
    }

    #[test]
    fn this_build_models_follow_the_probed_class() {
        let class = gpu_class();
        assert_eq!(
            live_model_for_this_build().key,
            live_model_for_class(class).key
        );
        assert_eq!(
            finalize_model_for_this_build().key,
            finalize_model_for_class(class).key
        );
        // gpu_class is cached — repeated calls agree.
        assert_eq!(gpu_class(), class);
    }

    #[test]
    fn accel_label_reflects_runtime_class_not_compile_time_hope() {
        let label = accel_label();
        match gpu_class() {
            GpuClass::None => assert_eq!(label, "CPU"),
            GpuClass::Integrated => {
                assert!(label.contains("(integrated GPU)"), "got {label}")
            }
            GpuClass::Discrete => {
                assert!(label.ends_with("(GPU)"), "got {label}");
                assert!(
                    !label.contains("integrated"),
                    "discrete label must not say integrated: {label}"
                );
            }
        }
        // A GPU label always names the compiled backend, never a bare "GPU".
        if label != "CPU" {
            let name = compiled_gpu_backend().unwrap();
            assert!(label.starts_with(name), "got {label}");
        }
    }

    #[test]
    fn decode_threads_uses_physical_cores_within_the_cap() {
        let t = decode_threads();
        assert!(t >= 1, "at least one thread");
        assert!(
            t as usize <= MAX_DECODE_THREADS,
            "must stay under the cap, got {t}"
        );
        assert!(
            t as usize <= num_cpus::get_physical().max(1),
            "must never oversubscribe physical cores"
        );
        // The whole point: never the whisper.cpp default of 4 on a host with more cores.
        if num_cpus::get_physical() >= 8 {
            assert!(t >= 8, "an 8-core host should get 8 threads, got {t}");
        }
    }

    #[test]
    fn gpu_class_serde_matches_ts_union() {
        let src = include_str!("../../../../desktop/src/src/app/models/transcript.ts");
        for (c, tag) in [
            (GpuClass::None, "'none'"),
            (GpuClass::Integrated, "'integrated'"),
            (GpuClass::Discrete, "'discrete'"),
        ] {
            assert_eq!(
                serde_json::to_string(&c).unwrap(),
                tag.replace('\x27', "\"")
            );
            assert_eq!(
                serde_json::from_str::<GpuClass>(&tag.replace('\x27', "\"")).unwrap(),
                c
            );
            assert!(
                src.contains(tag),
                "models/transcript.ts GpuClass union must carry {tag}"
            );
        }
    }
}
