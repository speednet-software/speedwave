//! SSOT catalogue of the Whisper transcription models the meeting-transcription
//! feature downloads on demand (ADR-056; speaker diarization removed — ADR-075).
//!
//! Bumping a model = editing one const here. Nothing else hard-codes a model
//! filename, URL, or hash. Mirrors the `defaults::ANTHROPIC_MODELS` pattern:
//! the frontend reads this via the `list_transcription_models` Tauri command
//! rather than hard-coding model names.
//!
//! URLs, sizes, and SHA256 values were established in ADR-056 spike 0C:
//! Whisper GGML models come from `ggerganov/whisper.cpp` on Hugging Face
//! (NOT `ggml-org/whisper.cpp`, which 401s anonymously). Sizes/SHA256 from
//! the HF API; `small`/`medium` SHA256 additionally confirmed by download.

/// Hugging Face repo path the Whisper GGML models are downloaded from.
pub const WHISPER_HF_REPO: &str = "ggerganov/whisper.cpp";

/// Builds the download URL for a Whisper GGML model file in [`WHISPER_HF_REPO`].
pub fn whisper_model_url(file: &str) -> String {
    format!("https://huggingface.co/{WHISPER_HF_REPO}/resolve/main/{file}")
}

/// Where in the live/offline transcription pipeline a Whisper model is meant
/// to be used. The default-download set for v1 (ADR-056 decision 8): `Small`
/// for CPU-only live, `LargeV3Turbo` for live when a GPU/Metal backend was
/// compiled in, `LargeV3` lazily for the higher-quality offline pass; `Medium`
/// is the middle ground if Polish quality on `Small`/`Turbo` disappoints;
/// `Tiny`/`Base` exist mainly for dev/tests and the smallest-footprint case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelRole {
    /// `tiny` — dev/test only; Polish quality is poor.
    DevTest,
    /// `base` — smallest "OK-ish" for Polish; not recommended for real use.
    SmallestUsable,
    /// `small` — the CPU-only live model.
    CpuLive,
    /// `medium` — middle ground; clearly better Polish than `small`.
    Mid,
    /// `large-v3-turbo` — the live model when a GPU/Metal backend is compiled in.
    GpuLive,
    /// `large-v3` — the higher-quality offline-pass model.
    Finalize,
}

/// Whether a model is a full-precision GGML model or a quantised variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Quantization {
    /// Full-precision (`ggml-<size>.bin`).
    Full,
    /// `q5_0` quantisation — present for `medium`/`large-v3`/`large-v3-turbo`.
    Q5_0,
    /// `q5_1` quantisation — present for `tiny`/`base`/`small` (the scheme is
    /// inconsistent across sizes; the catalogue stores the exact filename).
    Q5_1,
}

/// One entry in the Whisper model catalogue.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WhisperModelInfo {
    /// Stable catalogue key (e.g. `"small"`, `"large-v3-turbo-q5_0"`). Used in
    /// config and Tauri commands; never derived from the filename.
    pub key: &'static str,
    /// The GGML filename in [`WHISPER_HF_REPO`] (e.g. `"ggml-small.bin"`).
    pub file: &'static str,
    /// Human-readable label for the UI (e.g. `"Small (multilingual)"`).
    pub display_name: &'static str,
    /// Approximate download size in bytes (from the HF API; the SHA256 check
    /// is authoritative — this is for "do I have room?" UI).
    pub approx_bytes: u64,
    /// SHA256 of the file (lowercase hex, 64 chars). Verified on download.
    pub sha256: &'static str,
    /// Where this model fits in the pipeline.
    pub role: ModelRole,
    /// Full-precision vs quantised.
    pub quantization: Quantization,
    /// `true` for the models v1 considers "live-capable" on the relevant
    /// backend (`small` on CPU, `large-v3-turbo` on GPU/Metal).
    pub live_capable: bool,
    /// SPDX-ish licence string for the model weights.
    pub license: &'static str,
}

impl WhisperModelInfo {
    /// Download URL for this model.
    pub fn url(&self) -> String {
        whisper_model_url(self.file)
    }
}

/// Curated Whisper model catalogue (PL+EN multilingual models — the `.en`
/// English-only models are deliberately omitted). **Order matters** — the
/// frontend renders this list as-is. Sizes/SHA256 from ADR-056 spike 0C.
pub const WHISPER_MODELS: &[WhisperModelInfo] = &[
    WhisperModelInfo {
        key: "small",
        file: "ggml-small.bin",
        display_name: "Small (multilingual) — fast, OK for live",
        approx_bytes: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        role: ModelRole::CpuLive,
        quantization: Quantization::Full,
        live_capable: true,
        license: "MIT",
    },
    WhisperModelInfo {
        key: "small-q5_1",
        file: "ggml-small-q5_1.bin",
        display_name: "Small (quantised) — smallest live-capable",
        approx_bytes: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        role: ModelRole::CpuLive,
        quantization: Quantization::Q5_1,
        live_capable: true,
        license: "MIT",
    },
    WhisperModelInfo {
        key: "medium",
        file: "ggml-medium.bin",
        display_name: "Medium (multilingual) — better Polish",
        approx_bytes: 1_533_774_781,
        sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
        role: ModelRole::Mid,
        quantization: Quantization::Full,
        live_capable: false,
        license: "MIT",
    },
    WhisperModelInfo {
        key: "medium-q5_0",
        file: "ggml-medium-q5_0.bin",
        display_name: "Medium (quantised)",
        approx_bytes: 539_212_467,
        sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
        role: ModelRole::Mid,
        quantization: Quantization::Q5_0,
        live_capable: false,
        license: "MIT",
    },
    WhisperModelInfo {
        key: "large-v3-turbo",
        file: "ggml-large-v3-turbo.bin",
        display_name: "Large v3 Turbo — live on GPU/Metal",
        approx_bytes: 1_624_555_275,
        sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
        role: ModelRole::GpuLive,
        quantization: Quantization::Full,
        live_capable: true,
        license: "MIT",
    },
    WhisperModelInfo {
        key: "large-v3-turbo-q5_0",
        file: "ggml-large-v3-turbo-q5_0.bin",
        display_name: "Large v3 Turbo (quantised) — live on GPU/Metal, smaller",
        approx_bytes: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        role: ModelRole::GpuLive,
        quantization: Quantization::Q5_0,
        live_capable: true,
        license: "MIT",
    },
    WhisperModelInfo {
        key: "large-v3",
        file: "ggml-large-v3.bin",
        display_name: "Large v3 — best Polish (offline pass)",
        approx_bytes: 3_094_623_691,
        sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
        role: ModelRole::Finalize,
        quantization: Quantization::Full,
        live_capable: false,
        license: "MIT",
    },
    WhisperModelInfo {
        key: "large-v3-q5_0",
        file: "ggml-large-v3-q5_0.bin",
        display_name: "Large v3 (quantised) — offline pass, smaller",
        approx_bytes: 1_081_073_115,
        sha256: "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
        role: ModelRole::Finalize,
        quantization: Quantization::Q5_0,
        live_capable: false,
        license: "MIT",
    },
    WhisperModelInfo {
        key: "base",
        file: "ggml-base.bin",
        display_name: "Base (multilingual) — smallest, low accuracy",
        approx_bytes: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        role: ModelRole::SmallestUsable,
        quantization: Quantization::Full,
        live_capable: true,
        license: "MIT",
    },
    WhisperModelInfo {
        key: "tiny",
        file: "ggml-tiny.bin",
        display_name: "Tiny — dev/test only",
        approx_bytes: 77_691_713,
        sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
        role: ModelRole::DevTest,
        quantization: Quantization::Full,
        live_capable: true,
        license: "MIT",
    },
];

/// Looks up a Whisper model by its catalogue [`key`](WhisperModelInfo::key).
pub fn whisper_model(key: &str) -> Option<&'static WhisperModelInfo> {
    WHISPER_MODELS.iter().find(|m| m.key == key)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn is_hex64(s: &str) -> bool {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    }

    #[test]
    fn whisper_catalogue_is_non_empty_and_well_formed() {
        assert!(
            !WHISPER_MODELS.is_empty(),
            "Whisper catalogue must not be empty"
        );
        let mut keys: HashSet<&str> = HashSet::new();
        let mut files: HashSet<&str> = HashSet::new();
        for m in WHISPER_MODELS {
            assert!(keys.insert(m.key), "duplicate Whisper key: {}", m.key);
            assert!(files.insert(m.file), "duplicate Whisper file: {}", m.file);
            assert!(
                m.file.starts_with("ggml-") && m.file.ends_with(".bin"),
                "bad GGML filename: {}",
                m.file
            );
            assert!(
                is_hex64(m.sha256),
                "Whisper {} sha256 must be 64 lowercase hex chars, got {:?}",
                m.key,
                m.sha256
            );
            assert!(
                m.approx_bytes > 1_000_000,
                "Whisper {} approx_bytes implausibly small: {}",
                m.key,
                m.approx_bytes
            );
            assert!(
                !m.display_name.is_empty(),
                "Whisper {} display_name empty",
                m.key
            );
            assert!(!m.license.is_empty(), "Whisper {} license empty", m.key);
            let url = m.url();
            assert!(
                url.starts_with("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"),
                "Whisper {} url not from the expected HF repo: {url}",
                m.key
            );
            assert!(
                url.ends_with(m.file),
                "Whisper {} url does not end with its file: {url}",
                m.key
            );
        }
    }

    #[test]
    fn whisper_catalogue_has_the_v1_default_set() {
        // Decision 8: a CPU-live model, a GPU/Metal-live model, a finalize
        // model. If any of these disappear, the v1 strategy breaks.
        assert!(
            whisper_model("small").is_some(),
            "v1 needs the `small` CPU-live model"
        );
        assert!(
            whisper_model("large-v3-turbo").is_some(),
            "v1 needs the `large-v3-turbo` GPU-live model"
        );
        assert!(
            whisper_model("large-v3").is_some(),
            "v1 needs the `large-v3` finalize model"
        );
        assert!(WHISPER_MODELS
            .iter()
            .any(|m| m.role == ModelRole::CpuLive && m.live_capable));
        assert!(WHISPER_MODELS
            .iter()
            .any(|m| m.role == ModelRole::GpuLive && m.live_capable));
        assert!(WHISPER_MODELS.iter().any(|m| m.role == ModelRole::Finalize));
    }

    #[test]
    fn lookups_work() {
        assert_eq!(
            whisper_model("medium").map(|m| m.file),
            Some("ggml-medium.bin")
        );
        assert!(whisper_model("nope").is_none());
    }

    #[test]
    fn enums_round_trip_through_serde() {
        for r in [
            ModelRole::DevTest,
            ModelRole::SmallestUsable,
            ModelRole::CpuLive,
            ModelRole::Mid,
            ModelRole::GpuLive,
            ModelRole::Finalize,
        ] {
            let j = serde_json::to_string(&r).unwrap();
            assert_eq!(serde_json::from_str::<ModelRole>(&j).unwrap(), r);
        }
        for q in [Quantization::Full, Quantization::Q5_0, Quantization::Q5_1] {
            let j = serde_json::to_string(&q).unwrap();
            assert_eq!(serde_json::from_str::<Quantization>(&j).unwrap(), q);
        }
    }

    #[test]
    fn a_realistic_model_set_fits_under_the_global_dome() {
        // A realistic worst case: keep one full-precision model per role (no
        // point keeping a `full` and its `q5_*` variant at once — that's the
        // redundant case). This must fit under the dome in consts.rs with room
        // to spare; if it doesn't, raise the dome (and revisit whether the
        // catalogue is getting too large).
        let total: u64 = WHISPER_MODELS
            .iter()
            .filter(|m| matches!(m.quantization, Quantization::Full))
            .map(|m| m.approx_bytes)
            .sum();
        assert!(
            total < crate::consts::MAX_TOTAL_TRANSCRIPTION_MODELS_BYTES,
            "realistic model set ({total} B = {:.1} GiB) exceeds the global dome ({} B = {:.1} GiB) — raise MAX_TOTAL_TRANSCRIPTION_MODELS_BYTES",
            total as f64 / 1_073_741_824.0,
            crate::consts::MAX_TOTAL_TRANSCRIPTION_MODELS_BYTES,
            crate::consts::MAX_TOTAL_TRANSCRIPTION_MODELS_BYTES as f64 / 1_073_741_824.0,
        );
        // And `large-v3` alone (the single biggest entry) must be allowed —
        // the dome can't be smaller than the largest model.
        let biggest = WHISPER_MODELS.iter().map(|m| m.approx_bytes).max().unwrap();
        assert!(biggest < crate::consts::MAX_TOTAL_TRANSCRIPTION_MODELS_BYTES);
    }
}
