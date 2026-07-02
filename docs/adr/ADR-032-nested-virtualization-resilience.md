# ADR-032: Nested Virtualization Resilience

> **Status:** Accepted
> **Context:** On Windows inside a VM (VMware, VirtualBox, QEMU/KVM), WSL2's Hyper-V layer creates nested virtualization, where `fsync()` must flush through two hypervisors — stalling or failing container image builds during package extraction.

## Decision

Apply a four-layer strategy so image builds survive nested-virt I/O degradation: relax `dpkg` fsync during the build, retry transient build errors with backoff, proactively warn when a VM host is detected, and build images in parallel with a bounded worker pool.

## Why

- The `apt-get install` phase in the claude image calls `dpkg`, which uses `fsync()` heavily for crash-safe installs. Under nested virt those calls time out, failing the build with "Input/output error". `--force-unsafe-io` skips the fsync — safe here because image layers are disposable (a crashed build just rebuilds).
- Transient I/O and boot-time DNS-fallback hiccups are usually one-off; a short backed-off retry clears them without user action. The same recovery ladder (`with_build_recovery`, shared by bundle and plugin builds) also covers disk-full and containerd snapshotter corruption — each prunes the relevant cache (`builder prune` for the BuildKit cache, plus `system prune` for snapshotter) and retries.
- Detecting a VM host up front lets `speedwave check` warn the user before a long build fails.
- Parallel builds cut wall-clock setup time, but the pool is **bounded** to avoid amplifying disk-I/O contention and the BuildKit overlayfs snapshotter race window on VM hosts.

## How it works

- **apt hardening** — `Acquire::Retries=3` on `apt-get update` plus `--force-unsafe-io` on install, set in the claude image (`containers/Containerfile.claude`).
- **Transient retry** — after the first build attempt fails with a transient error, it retries up to `TRANSIENT_BUILD_RETRIES = 2` times with a per-attempt backoff (so **3 total attempts**: 1 initial + 2 retries). Matched strings (case-insensitive) include `i/o timeout`, `input/output error`, `connection reset`, `temporary failure`, `resource temporarily unavailable`, plus DNS-shaped errors only when they name a base-image registry. If all attempts fail, the error is enriched with VM troubleshooting guidance (increase VM memory, enable nested VT-x/EPT).
- **Worker pool** — images build concurrently via `std::thread::scope`, worker count capped at `min(available_parallelism, IMAGES.len())`, falling back to `DEFAULT_BUILD_WORKER_FALLBACK` (4) when CPU count is unknown.
- **Error classification** — every worker's error is collected and one is returned by priority: snapshotter (needs `system_prune` first) > transient (plain retry) > lowest image-index. Outcomes are sorted by image index so the choice is deterministic regardless of thread scheduling.
- **VM detection** — on Windows, `check_os_warnings()` runs `Get-CimInstance Win32_ComputerSystem` and checks `Model`/`Manufacturer` against known VM vendor strings, logging a non-blocking warning. `Get-CimInstance` is used over the deprecated `Get-WmiObject` for PowerShell 5.1 and 7+ compatibility.

## Where it lives in code

- Build retry + worker pool + classifier — `crates/speedwave-runtime/src/build.rs` (`with_build_recovery` (recovery ladder, shared by bundle + plugin builds), `build_images_for_bundle_in`, `try_build_images`, `is_transient_build_error`, `is_snapshotter_error`, `is_disk_full_error`; constants `TRANSIENT_BUILD_RETRIES`, `TRANSIENT_BUILD_RETRY_BASE_DELAY`, `DEFAULT_BUILD_WORKER_FALLBACK`, `IMAGES`)
- VM-host warning — `crates/speedwave-runtime/src/os_prereqs.rs` (`check_os_warnings`, `parse_vm_info`), surfaced by `crates/speedwave-cli/src/main.rs` on `speedwave check`
- apt hardening — `containers/Containerfile.claude`

## Consequences

- `--force-unsafe-io` relaxes crash-safety only during the build — accepted, layers are disposable.
- The VM check adds ~2-3s of PowerShell startup on Windows, only on explicit `speedwave check` and before container start, never on hot paths.
- The first pass always builds all images before returning an error; each retry costs roughly one more pass. The bounded pool limits, but does not eliminate, I/O pressure on VM hosts.
- No new container mounts, ports, env vars, credential flows, or frontend changes.
