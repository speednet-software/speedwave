//! Which whisper.cpp acceleration backends this binary was compiled with, and
//! the matching "live" Whisper model. Backends are compile-time (ADR-056 §6);
//! v1 = CPU everywhere + Metal on macOS.

use crate::transcription::model_catalog::{
    ModelRole, Quantization, WhisperModelInfo, WHISPER_MODELS,
};

/// A whisper.cpp acceleration backend compiled into this binary. v1 ships CPU
/// (all platforms) + Metal (macOS); CUDA/Vulkan are deferred (ADR-056).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Backend {
    /// CPU (always present).
    Cpu,
    /// Apple Metal GPU (macOS builds).
    Metal,
}

impl Backend {
    /// `true` for GPU backends (anything but `Cpu`).
    pub fn is_gpu(self) -> bool {
        !matches!(self, Backend::Cpu)
    }

    /// Short UI label.
    pub fn label(self) -> &'static str {
        match self {
            Backend::Cpu => "CPU",
            Backend::Metal => "Metal",
        }
    }
}

/// The acceleration backends compiled into this binary (not what the host
/// hardware supports — backends are a build-time choice).
pub fn compiled_backends() -> Vec<Backend> {
    #[cfg(all(feature = "audio-transcription", target_os = "macos"))]
    {
        vec![Backend::Cpu, Backend::Metal]
    }
    #[cfg(not(all(feature = "audio-transcription", target_os = "macos")))]
    {
        vec![Backend::Cpu]
    }
}

/// `true` if any GPU backend was compiled in.
pub fn has_gpu_backend() -> bool {
    compiled_backends().iter().any(|b| b.is_gpu())
}

/// The live-path Whisper model for `backends`: `large-v3-turbo` if a GPU
/// backend is present, else `small`.
pub fn recommended_live_model(backends: &[Backend]) -> &'static WhisperModelInfo {
    let want = if backends.iter().any(|b| b.is_gpu()) {
        ModelRole::GpuLive
    } else {
        ModelRole::CpuLive
    };
    WHISPER_MODELS
        .iter()
        .find(|m| m.role == want && m.live_capable && matches!(m.quantization, Quantization::Full))
        .or_else(|| {
            WHISPER_MODELS
                .iter()
                .find(|m| m.role == want && m.live_capable)
        })
        .or_else(|| WHISPER_MODELS.iter().find(|m| m.live_capable))
        .unwrap_or(&WHISPER_MODELS[0])
}

/// The live model for this build's compiled backends. Test-only — production
/// passes an explicit backend set to `recommended_live_model`.
#[cfg(test)]
pub fn recommended_live_model_for_this_build() -> &'static WhisperModelInfo {
    recommended_live_model(&compiled_backends())
}

/// The single best model to download for `backends`: `large-v3` (best Polish)
/// on a GPU build — the GPU keeps the live window real-time at full quality —
/// else `large-v3-turbo`, the best live-capable model on CPU.
pub fn best_model_for_backends(backends: &[Backend]) -> &'static WhisperModelInfo {
    let want = if backends.iter().any(|b| b.is_gpu()) {
        ModelRole::Finalize
    } else {
        ModelRole::GpuLive
    };
    WHISPER_MODELS
        .iter()
        .find(|m| m.role == want && matches!(m.quantization, Quantization::Full))
        .unwrap_or(&WHISPER_MODELS[0])
}

/// The best model to download for this build's compiled backends.
pub fn best_model_for_this_build() -> &'static WhisperModelInfo {
    best_model_for_backends(&compiled_backends())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn cpu_is_always_compiled_in() {
        assert!(compiled_backends().contains(&Backend::Cpu));
    }

    #[test]
    fn metal_is_present_on_macos_only() {
        let has_metal = compiled_backends().contains(&Backend::Metal);
        assert_eq!(has_metal, cfg!(target_os = "macos"));
    }

    #[test]
    fn has_gpu_backend_matches_compiled_backends() {
        assert_eq!(
            has_gpu_backend(),
            compiled_backends().iter().any(|b| b.is_gpu())
        );
    }

    #[test]
    fn recommended_live_model_gpu_vs_cpu() {
        assert_eq!(
            recommended_live_model(&[Backend::Cpu, Backend::Metal]).key,
            "large-v3-turbo"
        );
        assert_eq!(recommended_live_model(&[Backend::Cpu]).key, "small");
        assert_eq!(
            recommended_live_model(&[Backend::Metal]).role,
            ModelRole::GpuLive
        );
    }

    #[test]
    fn recommended_live_model_for_this_build_is_consistent() {
        let m = recommended_live_model_for_this_build();
        assert!(m.live_capable);
        assert_eq!(
            m.role,
            if has_gpu_backend() {
                ModelRole::GpuLive
            } else {
                ModelRole::CpuLive
            }
        );
    }

    #[test]
    fn best_model_gpu_is_large_v3_cpu_is_turbo() {
        assert_eq!(
            best_model_for_backends(&[Backend::Cpu, Backend::Metal]).key,
            "large-v3"
        );
        assert_eq!(
            best_model_for_backends(&[Backend::Cpu]).key,
            "large-v3-turbo"
        );
    }

    #[test]
    fn best_model_is_full_precision_and_consistent_with_this_build() {
        let m = best_model_for_this_build();
        assert!(matches!(m.quantization, Quantization::Full));
        assert_eq!(
            m.key,
            if has_gpu_backend() {
                "large-v3"
            } else {
                "large-v3-turbo"
            }
        );
    }

    #[test]
    fn backend_helpers() {
        assert!(!Backend::Cpu.is_gpu());
        assert!(Backend::Metal.is_gpu());
        assert_eq!(Backend::Cpu.label(), "CPU");
        assert_eq!(Backend::Metal.label(), "Metal");
    }

    #[test]
    fn backend_round_trips_through_serde() {
        for b in [Backend::Cpu, Backend::Metal] {
            assert_eq!(
                serde_json::from_str::<Backend>(&serde_json::to_string(&b).unwrap()).unwrap(),
                b
            );
        }
    }
}
