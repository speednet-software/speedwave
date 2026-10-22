//! Build script: emits `SPEEDWAVE_VERSION` for the crate and, with `audio-transcription`,
//! compiles the vendored whisper.cpp diarization code against whisper-rs-sys's ggml.

use std::path::{Path, PathBuf};

const DIARIZATION_DIR: &str = "native/whisper-diarization";
const UPSTREAM_GGML_VERSION_KEY: &str = "ggml-headers-whisper-cpp-version:";

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string()));
    let repo_root = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest_dir.clone());

    speedwave_version::emit_cargo_version(&repo_root);

    if std::env::var_os("CARGO_FEATURE_AUDIO_TRANSCRIPTION").is_some() {
        build_diarization(&manifest_dir.join(DIARIZATION_DIR));
    }
}

fn build_diarization(dir: &Path) {
    println!("cargo:rerun-if-changed={}", dir.display());

    let vendored = vendored_ggml_version(&dir.join("UPSTREAM"));
    let shipped = std::env::var("DEP_WHISPER_WHISPER_CPP_VERSION").unwrap_or_else(|_| {
        panic!("whisper-rs-sys did not report DEP_WHISPER_WHISPER_CPP_VERSION")
    });
    if shipped != vendored {
        panic!(
            "whisper-rs-sys ships whisper.cpp {shipped}, vendored ggml headers are {vendored}; \
             update {DIARIZATION_DIR} (ggml/ headers and UPSTREAM)"
        );
    }

    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .opt_level(2)
        .warnings(false)
        .include(dir)
        .include(dir.join("ggml"))
        .file(dir.join("whisper-diarization.cpp"))
        .compile("speedwave_diarization");
}

fn vendored_ggml_version(upstream: &Path) -> String {
    let content = std::fs::read_to_string(upstream)
        .unwrap_or_else(|e| panic!("read {}: {e}", upstream.display()));
    content
        .lines()
        .find_map(|l| l.trim().strip_prefix(UPSTREAM_GGML_VERSION_KEY))
        .map(|v| v.trim().to_owned())
        .unwrap_or_else(|| {
            panic!(
                "{} has no `{UPSTREAM_GGML_VERSION_KEY}` line",
                upstream.display()
            )
        })
}
