# ADR-085: Windows Vulkan Backend for Whisper Transcription

> **Status:** Accepted
> **Context:** ADR-056 shipped whisper.cpp acceleration as CPU everywhere plus Metal on macOS, deferring CUDA/Vulkan. Field telemetry on a CPU-only Windows host (i7-11850H, 8 physical cores, whisper on 8 threads after ADR-056 Am. 11) measured the live pass at ~1.5× realtime against the ≥2.4× the 12 s window / 5 s cadence requires, and the offline pass at ~0.48× realtime — a one-hour meeting takes two hours to finalize. The CPU ceiling is structural; the deferral is reversed for Vulkan.

## Decision

Windows whisper builds carry the **Vulkan** backend (`whisper-rs` `vulkan` feature), wired as a target-specific dependency block in `crates/speedwave-runtime/Cargo.toml` — the mirror of the existing macOS `metal` block, deliberately **not** a cargo feature (cargo features are not target-conditional; a `whisper-rs/vulkan` feature would force the Vulkan SDK onto macOS builds). Vulkan is vendor-neutral (NVIDIA/AMD/Intel)[^1]; CUDA stays deferred.

The supporting sub-decisions:

- **A compiled-in backend is not a usable device.** A runtime probe (`transcription/gpu_probe.rs`, `ash` with dynamic loading[^2]) enumerates Vulkan physical devices once per process and classifies the host (`accel.rs::GpuClass`): `Discrete` / `Integrated` / `None` (software rasterizers count as none). Model tiers follow the class — discrete GPUs get the GPU-tier live/finalize models, integrated GPUs keep the CPU-tier models (a Tiger Lake iGPU cannot hold `large-v3-turbo` at live cadence) while still using the GPU for compute, and `None` sets whisper's `use_gpu` to false. macOS reports `Discrete` (Metal). The Settings acceleration label reports the probed truth, not the compiled hope.
- **The redistributable Vulkan loader is bundled next to the exe.** ggml registers its Vulkan backend eagerly on every whisper init — `ggml_backend_vk_reg()` calls `ggml_vk_instance_init()` inside a C++ try/catch (`ggml-vulkan.cpp`, vendored by `whisper-rs-sys`)[^4] — and the binary carries a load-time `vulkan-1.dll` import, so a host without GPU drivers would fail to _launch_. Delay-loading does not help: a missing-DLL delay-load failure raises an SEH exception the `catch` cannot see[^5]. With the loader present, `vkCreateInstance` on a driverless host fails as a catchable error and whisper falls back to CPU cleanly. The loader is redistributable under Apache-2.0[^3] (`desktop/src-tauri/licenses-static/VulkanRT-License.txt`); `scripts/stage-vulkan-runtime.sh` stages it from the SDK and it ships as a root-level bundle resource (`vulkan-1.dll`, validated by `bundle.rs::WINDOWS_BUNDLED_ASSETS` and `scripts/verify-bundled-assets.sh`).
- **Build dependency: the pinned LunarG Vulkan SDK.** `scripts/install-vulkan-sdk.ps1` pins the SDK version and the SHA256 of the installer, the runtime-components zip, and the extracted `x64\vulkan-1.dll`, and is the single install path for developers (`make setup-dev-windows`) and CI (`prepare-desktop-bundle` action, `desktop-windows-check` job). The `runtime-windows` CI job never builds `audio-transcription` and stays SDK-free; so does the CLI (it never enables the feature) and every macOS job.
- **whisper.cpp/ggml logs are routed into the `log` facade** (`whisper-rs` `log_backend`, hooks installed once at transcriber load) — a silent GPU-init fallback was previously invisible, which is how the inverted model mapping of ADR-056 Am. 11 went unnoticed.

## Why

- The transcription privacy invariant is untouched: inference stays fully local; Vulkan only changes which silicon runs it.
- On discrete-GPU hosts both passes move to GPU-tier models and the finalize pass drops from hours to minutes; on this integrated-GPU host the gain is modest — the honest expectation is set by the probe, not marketing.
- The `GpuClass` seam keeps a future CUDA/ROCm backend a one-enum-variant change (Open/Closed, the `ContainerRuntime` pattern).

## Known limitations

- The ggml-vulkan shader ExternalProject nests ~205 chars of CMake scratch below the cargo target dir, and `cl.exe` cannot open >260-char paths even with NTFS long paths enabled[^6]; `scripts/check-vulkan-path-budget.sh` gates Windows desktop builds, with a short crate-local `target-dir` as the escape (see cross-platform rules).
- macOS `GpuClass::Discrete` is asserted, not probed — Metal init failure would still fall back silently inside whisper.cpp (now at least visible in logs via the routed hooks).
- An integrated GPU is classified by Vulkan device type, not measured throughput; an unusually fast iGPU still gets CPU-tier models.

[^1]: Vulkan is the Khronos cross-vendor GPU API; ggml ships a Vulkan backend enabled with `GGML_VULKAN`: <https://github.com/ggml-org/whisper.cpp/blob/master/README.md#vulkan-gpu-support>.

[^2]: `ash::Entry::load()` loads `vulkan-1.dll` dynamically at runtime (no link-time import), returning an error when the loader is absent: <https://docs.rs/ash/0.38.0/ash/struct.Entry.html#method.load>.

[^3]: The LunarG Vulkan Runtime is redistributable; the loader is Apache-2.0 licensed: <https://vulkan.lunarg.com/software/license/vulkan-1.4.357.0-windows-license-summary.txt>.

[^4]: `ggml_backend_vk_reg()` wraps `ggml_vk_instance_init()` in `try { ... } catch (const vk::SystemError&) / catch (const std::exception&) / catch (...)`: <https://github.com/ggml-org/whisper.cpp/blob/master/ggml/src/ggml-vulkan/ggml-vulkan.cpp>.

[^5]: Delay-load failures are reported as structured exceptions (`VcppException(ERROR_SEVERITY_ERROR, ERROR_MOD_NOT_FOUND)` for a `LoadLibrary` failure), which a C++ `catch` does not handle: <https://learn.microsoft.com/en-us/cpp/build/reference/error-handling-and-notification>.

[^6]: MSVC fails with fatal error C1081 when a file pathname exceeds `_MAX_PATH` (260 chars) regardless of the `LongPathsEnabled` registry value: <https://learn.microsoft.com/en-us/cpp/error-messages/compiler-errors-1/fatal-error-c1081> and <https://developercommunity.visualstudio.com/t/clexe-compiler-driver-cannot-handle-long-file-path/975889>.
