//! Guards the vendored whisper.cpp diarization code in `native/whisper-diarization/`: ggml calls
//! match the vendored headers, the C API is declared in its own header, logs go only to the callback.

#![expect(
    clippy::expect_used,
    reason = "test file uses expect() only, never unwrap()"
)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const VENDOR_DIR: &str = "native/whisper-diarization";
const GGML_HEADERS: [&str; 4] = ["ggml.h", "ggml-alloc.h", "ggml-backend.h", "gguf.h"];
const OFFLINE_GEOMETRY: [(&str, i64); 6] = [
    ("spkcache_len", 264),
    ("fifo_len", 0),
    ("chunk_len", 264),
    ("spkcache_batch_len", 188),
    ("left_context", 1),
    ("right_context", 1),
];

fn vendor_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(VENDOR_DIR)
}

fn read_vendor_file(rel: &str) -> String {
    std::fs::read_to_string(vendor_dir().join(rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

fn read_repo_file(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

fn vendored_sources() -> String {
    read_vendor_file("whisper-diarization.cpp") + &read_vendor_file("whisper-diarization-arch.h")
}

fn called_identifiers(source: &str, prefix: &str) -> BTreeSet<String> {
    let re = regex::Regex::new(&format!(r"\b({prefix}[a-z0-9_]+)\s*\(")).expect("valid regex");
    re.captures_iter(source).map(|c| c[1].to_owned()).collect()
}

fn defined_c_functions(source: &str) -> BTreeSet<String> {
    let re = regex::Regex::new(r"(?m)^(?:extern .C. )?[A-Za-z_][A-Za-z0-9_ *]* \*?((?:whisper|speedwave)_diar_[a-z0-9_]+)\(")
        .expect("valid regex");
    re.captures_iter(source)
        .filter(|c| !c[0].starts_with("static"))
        .map(|c| c[1].to_owned())
        .collect()
}

fn cache_params(source: &str) -> Option<Vec<(String, i64)>> {
    let body = source
        .split("struct whisper_diar_cache_params {")
        .nth(1)?
        .split("};")
        .next()?;
    let re =
        regex::Regex::new(r"(?m)^\s*int\s+([a-z_]+)\s*=\s*(-?[0-9]+)\s*;").expect("valid regex");
    Some(
        re.captures_iter(body)
            .map(|c| (c[1].to_owned(), c[2].parse().expect("an int literal")))
            .collect(),
    )
}

fn whisper_rs_sys_version_in(lockfile: &str) -> String {
    read_repo_file(lockfile)
        .split("[[package]]")
        .find(|pkg| pkg.contains("name = \"whisper-rs-sys\""))
        .and_then(|pkg| {
            pkg.lines()
                .find_map(|l| l.trim().strip_prefix("version = "))
                .map(|v| v.trim_matches('"').to_owned())
        })
        .expect("whisper-rs-sys is in the lockfile")
}

#[test]
fn every_ggml_call_is_declared_in_the_vendored_headers() {
    let headers: String = GGML_HEADERS
        .iter()
        .map(|h| read_vendor_file(&format!("ggml/{h}")))
        .collect();
    let declared = |name: &str| {
        regex::Regex::new(&format!(r"\b{name}\b"))
            .expect("valid regex")
            .is_match(&headers)
    };
    let sources = vendored_sources();
    let called: BTreeSet<String> = called_identifiers(&sources, "ggml_")
        .into_iter()
        .chain(called_identifiers(&sources, "gguf_"))
        .collect();
    assert!(
        called.len() > 50,
        "expected the diarization code to call the ggml API, found {called:?}"
    );
    let missing: Vec<_> = called.iter().filter(|name| !declared(name)).collect();
    assert!(
        missing.is_empty(),
        "{VENDOR_DIR} calls ggml/gguf functions its vendored headers do not declare (absent \
         in the ggml whisper-rs-sys links): {missing:?}"
    );
}

#[test]
fn the_check_catches_the_upstream_call_missing_from_ggml_1_8_3() {
    let headers = read_vendor_file("ggml/gguf.h");
    assert!(
        called_identifiers("x = gguf_get_tensor_ne(meta, id);", "gguf_")
            .contains("gguf_get_tensor_ne")
    );
    assert!(
        !headers.contains("gguf_get_tensor_ne"),
        "the vendored gguf.h now declares gguf_get_tensor_ne: drop local change 1 from \
         {VENDOR_DIR}/UPSTREAM and restore the upstream line"
    );
}

#[test]
fn the_source_includes_the_vendored_api_header_instead_of_whisper_h() {
    let cpp = read_vendor_file("whisper-diarization.cpp");
    assert!(cpp.contains("#include \"whisper-diarization.h\""));
    assert!(
        !cpp.contains("#include \"whisper.h\""),
        "whisper.h comes from whisper-rs-sys's whisper.cpp, which has no diarization API"
    );
}

#[test]
fn every_exported_function_is_declared_in_the_vendored_api_header() {
    let defined = defined_c_functions(&read_vendor_file("whisper-diarization.cpp"));
    assert!(defined.contains("whisper_diar_init_from_file_with_params"));
    assert!(defined.contains("speedwave_diar_log_set"));
    let header = read_vendor_file("whisper-diarization.h");
    let declared = called_identifiers(&header, "whisper_diar_")
        .into_iter()
        .chain(called_identifiers(&header, "speedwave_diar_"))
        .collect::<BTreeSet<_>>();
    let undeclared: Vec<_> = defined.difference(&declared).collect();
    assert!(
        undeclared.is_empty(),
        "whisper-diarization.cpp exports functions whisper-diarization.h does not declare: \
         {undeclared:?}"
    );
}

#[test]
fn the_definition_scan_skips_file_local_functions() {
    let source = "static void whisper_diar_log_internal(int level) {\n\
                  int whisper_diar_n_speakers(const whisper_diar_context * ctx) {\n\
                  extern \"C\" void speedwave_diar_log_set(ggml_log_callback cb, void * u) {\n";
    let defined = defined_c_functions(source);
    assert_eq!(
        defined,
        BTreeSet::from([
            "speedwave_diar_log_set".to_owned(),
            "whisper_diar_n_speakers".to_owned()
        ])
    );
}

#[test]
fn the_vendored_code_never_writes_to_stderr() {
    let sources = vendored_sources();
    for needle in ["stderr", "stdout", "printf(", "fputs("] {
        assert!(
            !sources
                .lines()
                .any(|l| l.contains(needle) && !l.contains("snprintf(")),
            "{VENDOR_DIR} writes to the console ({needle}); its log goes only through the \
             callback set with speedwave_diar_log_set"
        );
    }
}

#[test]
fn the_vendored_code_loads_no_backend_library() {
    let source = vendored_sources();
    assert!(
        !source.contains("ggml_backend_load"),
        "ggml_backend_load_all and ggml_backend_load search the executable's directory and the \
         working directory for backend libraries and load every match; the linked backends are \
         registered statically (UPSTREAM, local change 7)"
    );
}

#[test]
fn the_chunk_loop_reads_the_abort_callback_before_every_chunk() {
    let source = read_vendor_file("whisper-diarization.cpp");
    let detect = source
        .split("bool whisper_diar_detect_speakers(")
        .nth(1)
        .expect("whisper_diar_detect_speakers is defined");
    let body = &detect[..detect.find("\n}\n").expect("the function ends")];
    assert!(
        body.contains("ggml_abort_callback abort_callback, void * abort_callback_data"),
        "the function takes the abort callback and its data (UPSTREAM, local change 8)"
    );
    let chunk_loop = body
        .find("for (int64_t i = 0; i < n_mel_frames;")
        .expect("the chunk loop");
    let check = body
        .find("if (abort_callback && abort_callback(abort_callback_data))")
        .expect("the loop reads the abort callback");
    assert!(
        check > chunk_loop,
        "the abort check sits inside the chunk loop"
    );
    assert!(
        body.contains("ggml_abort_callback abort_callback, void * abort_callback_data"),
        "the header declaration carries the same two parameters"
    );
    assert!(read_vendor_file("whisper-diarization.h")
        .contains("ggml_abort_callback abort_callback, void * abort_callback_data"));
}

#[test]
fn upstream_names_the_whisper_rs_sys_version_the_crate_pins() {
    let upstream = read_vendor_file("UPSTREAM");
    let named = upstream
        .lines()
        .find_map(|l| l.strip_prefix("ggml-headers-source: whisper-rs-sys "))
        .and_then(|rest| rest.split(',').next())
        .map(str::trim)
        .expect("UPSTREAM names the whisper-rs-sys version its ggml headers come from");
    let manifest = read_repo_file("crates/speedwave-runtime/Cargo.toml");
    let pin = manifest
        .lines()
        .find_map(|l| l.trim().strip_prefix("whisper-rs-sys = { version = \"="))
        .and_then(|rest| rest.split('"').next())
        .expect("speedwave-runtime pins whisper-rs-sys with `=`");
    assert_eq!(
        named, pin,
        "UPSTREAM's ggml-headers-source must name the whisper-rs-sys version the crate pins"
    );
}

#[test]
fn the_cache_geometry_is_the_offline_one_upstream_lists() {
    let params = cache_params(&read_vendor_file("whisper-diarization.cpp"))
        .expect("whisper-diarization.cpp defines whisper_diar_cache_params");
    let expected: Vec<_> = OFFLINE_GEOMETRY
        .iter()
        .map(|(name, value)| ((*name).to_owned(), *value))
        .collect();
    assert_eq!(
        params, expected,
        "the cache geometry is local change 6 in {VENDOR_DIR}/UPSTREAM; update both together"
    );
    assert!(read_vendor_file("UPSTREAM").contains("\n  6. "));
}

#[test]
fn the_geometry_scan_reads_every_field_and_rejects_a_missing_struct() {
    let source = "struct other { int a = 1; };\nstruct whisper_diar_cache_params {\n    int fifo_len           = 0;\n    int left_context = -1;\n};\nint after = 5;";
    assert_eq!(
        cache_params(source),
        Some(vec![
            ("fifo_len".to_owned(), 0),
            ("left_context".to_owned(), -1)
        ])
    );
    assert_eq!(
        cache_params("struct whisper_diar_cache { int n = 0; };"),
        None
    );
}

#[test]
fn upstream_names_the_source_commit_and_the_ggml_version() {
    let upstream = read_vendor_file("UPSTREAM");
    let commit = upstream
        .lines()
        .find_map(|l| l.strip_prefix("source-commit:"))
        .map(str::trim)
        .expect("UPSTREAM has a source-commit line");
    assert_eq!(commit.len(), 40, "source-commit is a full SHA-1: {commit}");
    assert!(commit.chars().all(|c| c.is_ascii_hexdigit()));

    let versions: Vec<_> = upstream
        .lines()
        .filter_map(|l| l.trim().strip_prefix("ggml-headers-whisper-cpp-version:"))
        .map(str::trim)
        .collect();
    assert_eq!(
        versions.len(),
        1,
        "build.rs reads exactly one ggml-headers-whisper-cpp-version line: {versions:?}"
    );
    let parts: Vec<_> = versions[0].split('.').collect();
    assert_eq!(parts.len(), 3, "a semver: {}", versions[0]);
    assert!(parts.iter().all(|p| p.parse::<u32>().is_ok()));
}

#[test]
fn the_vendored_ggml_headers_are_the_ones_upstream_lists() {
    let upstream = read_vendor_file("UPSTREAM");
    let mut on_disk: Vec<_> = std::fs::read_dir(vendor_dir().join("ggml"))
        .expect("read ggml dir")
        .map(|e| {
            e.expect("dir entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    on_disk.sort();
    let mut expected: Vec<_> = GGML_HEADERS.iter().map(|h| (*h).to_owned()).collect();
    expected.sort();
    assert_eq!(on_disk, expected);
    for header in GGML_HEADERS {
        assert!(upstream.contains(header), "UPSTREAM lists {header}");
    }
}

#[test]
fn whisper_rs_sys_is_pinned_exactly_to_the_locked_version() {
    let manifest = read_repo_file("crates/speedwave-runtime/Cargo.toml");
    let pin = manifest
        .lines()
        .find_map(|l| l.trim().strip_prefix("whisper-rs-sys = { version = \"="))
        .and_then(|rest| rest.split('"').next())
        .expect("speedwave-runtime pins whisper-rs-sys with `=`");
    for lockfile in ["Cargo.lock", "desktop/src-tauri/Cargo.lock"] {
        assert_eq!(
            whisper_rs_sys_version_in(lockfile),
            pin,
            "{lockfile}: whisper-rs-sys must be the exact version speedwave-runtime pins, since \
             build.rs checks the vendored ggml headers against the whisper.cpp it ships"
        );
    }
}

#[test]
fn the_vendored_code_carries_the_whisper_cpp_license() {
    let license = read_vendor_file("LICENSE");
    assert!(license.starts_with("MIT License"));
    assert!(license.contains("The ggml authors"));
}
