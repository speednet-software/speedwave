# ADR-061: Windows CRT Runtime Alignment for sherpa-onnx + whisper.cpp

**Status:** Accepted

**Date:** 2026-05-19

## Context

[ADR-056](ADR-056-host-side-audio-transcription.md) added two native C/C++ dependencies to `speedwave-runtime` (gated behind the `audio-transcription` feature): `whisper-rs` (`whisper-rs-sys` compiles whisper.cpp from a vendored submodule via `cmake-rs`) and `sherpa-onnx` (the official Rust crate by csukuangfj; `sherpa-onnx-sys` does **not** build sherpa-onnx from source — it downloads a prebuilt static-lib archive from k2-fsa's GitHub releases at build time).[^1][^2][^3]

On Windows (MSVC), every native library and every Rust crate must agree on the **C runtime (CRT) link mode**: static (`/MT`, `libcpmt.lib`) vs dynamic (`/MD`, `msvcprt.lib` → `MSVCP140.dll`). Mixing them produces `LNK2038 RuntimeLibrary mismatch` plus duplicate-symbol `LNK2005`/`LNK1169` failures because both libraries export the same C++ standard-library symbols.[^4]

The Windows `Desktop Build` job on `dev` has failed on every push since 2026-05-13 (commit `2b4b6ced`, PR #658), which introduced `whisper-rs-sys` and `sherpa-onnx-sys` to the build. The root cause is asymmetric default CRT selection:

- `sherpa-onnx-sys 1.13.2` **hard-codes** the prebuilt archive name: on Windows x64 it downloads `sherpa-onnx-v1.13.2-win-x64-static-MT-Release-lib.tar.bz2` (the `MT` variant). It then links those static libs into the binary via `cargo:rustc-link-search=native=<lib>` + `cargo:rustc-link-lib=static=<each-lib>`. The variant is not configurable through a feature or env var: `build.rs` hard-codes the asset name and only `SHERPA_ONNX_LIB_DIR` can override the download path.[^5][^6]
- `whisper-rs-sys 0.15.0` calls into `cmake-rs`, which on MSVC ≥ 3.15 selects `CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL` (i.e., `/MD`) by default. `whisper-rs-sys` forwards every env variable matching `CMAKE_*` / `WHISPER_*` / `GGML_*` to cmake, so the runtime selection can be steered through env vars but is `/MD` if unset.[^7][^8]
- Rust `std` on `x86_64-pc-windows-msvc` links against `/MD` by default (no `crt-static` target feature).[^9]

Net effect: sherpa pulls `/MT` symbols into the link, everything else expects `/MD` → MSVC linker rejects the mix.

**Prior workaround (E2E only).** `scripts/e2e-vm.sh` (Step 4/5 PowerShell heredoc) set `CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded` + `CMAKE_POLICY_DEFAULT_CMP0091=NEW` to force whisper.cpp onto `/MT` so it matched sherpa. This made E2E succeed, but the same fix was never applied to `desktop-build.yml` / `desktop-release.yml`, so the CI matrix kept failing.

**Discovery.** k2-fsa publishes the same v1.13.2 prebuilt archive in **both** `MT-Release` and `MD-Release` variants, with SHA256 listed in a single `checksum.txt` per release.[^10] `sherpa-onnx-sys 1.13.2 build.rs:100-110` honors `SHERPA_ONNX_LIB_DIR` as an override — if set to a directory containing the `.lib` files, the build script skips the upstream download entirely and links against that directory's static libs.[^5]

## Decision

Pre-fetch the **MD-Release** prebuilt for Windows on every Windows build path, set `SHERPA_ONNX_LIB_DIR` to point at the extracted `lib/` subdirectory, and let the rest of the toolchain keep its `/MD` default. This means:

- **`whisper-rs-sys`** stays on cmake-rs's default `/MD` — no `CMAKE_MSVC_RUNTIME_LIBRARY` override anywhere.
- **`sherpa-onnx-sys`** sees `SHERPA_ONNX_LIB_DIR` pointing at the MD-Release `.lib`s and skips its own MT-Release download.
- **Rust `std`** keeps its `/MD` default — no `RUSTFLAGS=-C target-feature=+crt-static`.

All Windows CRT-affecting code (`scripts/e2e-vm.sh` PowerShell heredoc) is reverted to no overrides: the E2E path now uses the same `scripts/lib/fetch-sherpa-onnx-md.sh` as CI.

Operationally:

- `.sherpa-onnx-version` (root SSOT, value `1.13.2`) pinning is exact (`Cargo.toml`: `sherpa-onnx = "=1.13.2"`).
- `scripts/lib/fetch-sherpa-onnx-md.sh` is the single download script — bash, idempotent, SHA-verified from upstream `checksum.txt`, prints the absolute `lib/` path on stdout. Used by `.github/actions/download-sherpa-onnx` (CI) and `scripts/e2e-vm.sh` (E2E, invoked via WSL bash + `wslpath` for the env var).
- Two workflows include the prefetch step gated on `windows-latest`: `desktop-build.yml` (PR + push CI) and `desktop-release.yml` (`publish-tauri` matrix job).

## Consequences

- **+~84 MiB** download per Windows CI run for the MD-Release tarball. The script is idempotent (skips download if extracted), so `swatinem/rust-cache` indirectly amortizes it across cache-hit runs.
- **SSOT-alignment chain** added to CLAUDE.md: `.sherpa-onnx-version` ↔ `crates/speedwave-runtime/Cargo.toml` (`=`-pinned `sherpa-onnx` version) ↔ `scripts/lib/fetch-sherpa-onnx-md.sh` (filename embeds the version) ↔ `scripts/e2e-vm.sh` (consumer) ↔ `.github/actions/download-sherpa-onnx/action.yml` (consumer). Bumping `sherpa-onnx` = edit `.sherpa-onnx-version`, run `cargo update -p sherpa-onnx --precise <new>` in both lockfiles, verify the new MD-Release archive still exists upstream, in a single commit.
- **Failure mode unchanged on upstream policy break.** If `sherpa-onnx-sys` ever stops respecting `SHERPA_ONNX_LIB_DIR`, or `cmake-rs` flips its MSVC default to `/MT`, the link fails in the same shape it did before this ADR. The fetch-script SHA verification fails closed (no silent linking against a tampered archive).
- **No bundle-size change.** The static `.lib`s are linked at build time and the prebuilt archive is discarded; the shipped Windows binary is unchanged in size and content (it always linked sherpa static — only the linkage CRT changed).
- **macOS / Linux unchanged.** macOS uses the upstream `osx-{arm64,x64}-static-lib` archive (no MT/MD axis on macOS). Linux as a host platform was dropped in [ADR-059](ADR-059-drop-linux-support.md).

## Alternatives considered

**A. Wymuś `/MT` wszędzie** — `RUSTFLAGS=-C target-feature=+crt-static` plus `CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded` for whisper. Equivalent to what `e2e-vm.sh` was doing. **Rejected** because static-CRT Rust binaries have known compatibility issues with native crates that expect dynamic CRT (Tauri's pulled-in C++ deps, future native crates) and produce larger binaries with no upside. The MD path keeps Speedwave on the platform-default CRT.

**B. Build sherpa-onnx from source with `/MD`** — fork or vendor `sherpa-onnx-sys`, swap its `download_prebuilt_libs` for a cmake build of sherpa-onnx C++ sources. **Rejected** as +5–15 min per Windows CI run, ongoing maintenance against k2-fsa's CMake structure, and a vendor patch is a load-bearing local fork.

**C. Drop `audio-transcription` on Windows** — feature-gate sherpa + whisper to `target_os = "macos"`. **Rejected** because it reverses the meeting-transcription delivery from PR #658 ([ADR-056](ADR-056-host-side-audio-transcription.md)) on Windows.

**D. Wait for upstream `sherpa-onnx-sys` to add an MT/MD env knob.** Tracked upstream but not landed. **Not blocking** — this ADR uses the already-existing `SHERPA_ONNX_LIB_DIR` knob, which fully solves the problem.

## Revisit

This ADR should be revisited when:

- `sherpa-onnx-sys` exposes a feature flag or env var to select MT vs MD prebuilt directly (Decision D landed). The prefetch script can then be removed and replaced by a feature in `Cargo.toml`.
- `audio-transcription` is dropped from Windows builds (e.g., shipping Windows as a transcription-less SKU). The prefetch step can then be removed entirely.

[^1]: https://github.com/tazz4843/whisper-rs — `whisper-rs` GitHub repo, MIT, wraps `whisper.cpp`.

[^2]: https://github.com/k2-fsa/sherpa-onnx — `sherpa-onnx` GitHub repo, Apache-2.0, official ONNX-runtime wrapper.

[^3]: https://docs.rs/crate/sherpa-onnx-sys/1.13.2/source/build.rs — `sherpa-onnx-sys` build script source (downloads prebuilt static-lib archive at build time).

[^4]: https://learn.microsoft.com/en-us/cpp/error-messages/tool-errors/linker-tools-error-lnk2038 — Microsoft Learn: LNK2038 mismatch detected for 'RuntimeLibrary'.

[^5]: https://docs.rs/crate/sherpa-onnx-sys/1.13.2/source/build.rs — `SHERPA_ONNX_LIB_DIR` env var handling (lines 100–110) and `rustc-link-search` emission (line 60).

[^6]: https://docs.rs/crate/sherpa-onnx-sys/1.13.2/source/build.rs — Windows archive name hard-coded as `sherpa-onnx-v{version}-win-x64-static-MT-Release-lib.tar.bz2` (lines 216–218).

[^7]: https://docs.rs/cmake/latest/cmake/ — `cmake` crate docs: on MSVC, the build script sets `CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL` by default.

[^8]: https://docs.rs/crate/whisper-rs-sys/0.15.0/source/build.rs — `whisper-rs-sys` build script forwards `CMAKE_*` / `WHISPER_*` / `GGML_*` env vars to cmake (around line 279).

[^9]: https://doc.rust-lang.org/reference/linkage.html#static-and-dynamic-c-runtimes — Rust reference on `crt-static` target feature; default on `x86_64-pc-windows-msvc` is dynamic CRT.

[^10]: https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.2 — k2-fsa sherpa-onnx v1.13.2 release page; lists both `win-x64-static-MD-Release-lib.tar.bz2` and `win-x64-static-MT-Release-lib.tar.bz2`, plus a single `checksum.txt`.
