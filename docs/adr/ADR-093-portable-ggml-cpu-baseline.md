# ADR-093: Portable ggml CPU Baseline for Whisper Builds

> **Status:** Accepted
> **Context:** Windows Desktop crashed with `0xc000001d` (STATUS_ILLEGAL_INSTRUCTION) on the first use of the ggml CPU backend on a Core Ultra 7 165H, at an AVX-512 instruction in `speedwave-desktop.exe` (SPEED-802). whisper-rs-sys builds ggml with CMake and links it statically[^1], and ggml defaults `GGML_NATIVE` to ON for every build that is not a cross-compile and has no `SOURCE_DATE_EPOCH`[^2]. Under MSVC, `GGML_NATIVE` includes `FindSIMD.cmake`, which runs probe programs on the build machine and turns on `GGML_AVX512` when they pass; the CPU backend is then compiled with `/arch:AVX512`[^3][^4]. The installer's instruction set followed the CPU of the GitHub-hosted runner that built it.

## Decision

The repo-level `.cargo/config.toml` sets `GGML_NATIVE = "OFF"` under `[env]`. whisper-rs-sys forwards every `GGML_*` environment variable to CMake as a define[^1], so the pin reaches ggml without patching the crate. With `GGML_NATIVE` off, ggml enables SSE4.2, AVX, AVX2, BMI2, FMA and F16C and leaves AVX-512 off[^2]; MSVC gets `/arch:AVX2`[^3][^5]. On aarch64 macOS the build drops `-mcpu=native` and uses the compiler's default for the target[^3]; x86_64 macOS builds are cross-compiled and were never native.

`crates/speedwave-runtime/tests/cargo_env_ggml_portable_guard.rs` checks that the pin is present, that no `GGML_AVX512*` is set, and that `GGML_NATIVE=OFF` reaches processes cargo starts.

The desktop bundle's Rust cache key (`rust-cache-shared-key` in `lane-build.yml` and `build-publish.yml`) is renamed whenever a `GGML_*` flag changes. whisper-rs-sys declares no `rerun-if-env-changed` for `GGML_*`, so cargo does not rerun its build script when the flag changes[^1][^6]. swatinem/rust-cache drops the `key` input when `shared-key` is set and keeps the `.cargo/config.toml` hash out of its restore key[^7], so a cache written before the change would restore the old ggml objects through the restore-key prefix match.

## Why

- The baseline is the one ggml itself selects with `GGML_NATIVE` off[^2], so the shipped build matches the configuration upstream treats as portable, and the build machine's CPU no longer decides what runs on the user's.
- Runtime selection between CPU variants (`GGML_CPU_ALL_VARIANTS`) needs `GGML_BACKEND_DL`[^2], which loads backends as shared libraries, and whisper-rs-sys hard-codes `BUILD_SHARED_LIBS=OFF`[^1]. Using it means forking whisper-rs-sys and shipping extra DLLs, each of which ADR-086's signing pass would have to cover.
- An env pin in `.cargo/config.toml` applies to developer builds and CI alike, unlike a CI-only variable.

## Known limitations

- Hosts with AVX-512 run the AVX2 kernels; ggml has no runtime dispatch in this build.
- `GGML_NATIVE` is not forced: a `GGML_NATIVE` exported in the build environment overrides the config value[^8]. The guard test catches this for `cargo test` runs only.
- A local target dir that already built whisper-rs-sys keeps the old objects until `cargo clean -p whisper-rs-sys`.

[^1]: whisper-rs-sys 0.15.0 `build.rs`: `.define("BUILD_SHARED_LIBS", "OFF")`, the loop forwarding `WHISPER_*`, `GGML_*` and `CMAKE_*` env vars to CMake, and the `rerun-if-env-changed` lines (none for `GGML_*`): <https://docs.rs/crate/whisper-rs-sys/0.15.0/source/build.rs>.

[^2]: ggml `CMakeLists.txt` vendored by whisper-rs-sys 0.15.0: `GGML_NATIVE_DEFAULT`, the `INS_ENB` defaults for the x86 instruction options, `GGML_AVX512` defaulting to OFF, and `GGML_CPU_ALL_VARIANTS` requiring `GGML_BACKEND_DL`: <https://docs.rs/crate/whisper-rs-sys/0.15.0/source/whisper.cpp/ggml/CMakeLists.txt>.

[^3]: ggml-cpu `CMakeLists.txt` vendored by whisper-rs-sys 0.15.0: MSVC includes `FindSIMD.cmake` when `GGML_NATIVE` is on, maps `GGML_AVX512` to `/arch:AVX512` and `GGML_AVX2` to `/arch:AVX2`; the ARM branch adds `-mcpu=native` only when `GGML_NATIVE` is on: <https://docs.rs/crate/whisper-rs-sys/0.15.0/source/whisper.cpp/ggml/src/ggml-cpu/CMakeLists.txt>.

[^4]: `FindSIMD.cmake` probes each instruction set with `check_c_source_runs` and sets `GGML_AVX512` ON when the AVX-512 probe runs: <https://docs.rs/crate/whisper-rs-sys/0.15.0/source/whisper.cpp/ggml/src/ggml-cpu/cmake/FindSIMD.cmake>.

[^5]: MSVC `/arch` (x64) options, including `/arch:AVX2` and `/arch:AVX512`: <https://learn.microsoft.com/en-us/cpp/build/reference/arch-x64>.

[^6]: Cargo reruns a build script on an environment change only for variables named by `cargo::rerun-if-env-changed`: <https://doc.rust-lang.org/cargo/reference/build-scripts.html>.

[^7]: swatinem/rust-cache key construction at the pinned commit: `shared-key` replaces the `key` input, and the `.cargo/config.toml` hash is appended to `cacheKey` after `restoreKey` is taken: <https://github.com/Swatinem/rust-cache/blob/6323deb102c322ba6fcbdcafc7e3dddab59af2b6/src/config.ts>.

[^8]: Cargo `[env]` values do not override variables already set in the environment unless `force = true`: <https://doc.rust-lang.org/cargo/reference/config.html#env>.
