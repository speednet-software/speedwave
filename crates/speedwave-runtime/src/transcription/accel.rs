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

/// The single best model to download for `backends`: `large-v3` on GPU, else
/// `large-v3-turbo`. One model serves both the live and offline passes; on a
/// weak CPU turbo may lag live, accepted (ADR-056).
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
