# ADR-032: Nested Virtualization Resilience

## Status

Accepted

## Context

When running Speedwave Setup on Windows inside a virtual machine (VMware Workstation, VirtualBox, QEMU/KVM), the WSL2 distribution uses Hyper-V for its own virtualization layer — resulting in _nested virtualization_ (a hypervisor running inside a hypervisor). This configuration degrades I/O performance significantly because `fsync()` calls must flush through two virtualization layers[^1].

During the "Build Images" setup step, the `apt-get install` phase in `Containerfile.claude` calls `dpkg` to unpack packages. `dpkg` uses `fsync()` extensively by default to ensure crash-safe package installation[^2]. In nested-virt environments, these `fsync()` calls can timeout or stall, causing the container image build to fail with "Input/output error" during package extraction.

This was reported in [#322](https://github.com/speednet-software/speedwave/issues/322): a user running Windows 11 inside VMware Workstation hit a reproducible build failure at the `apt-get install` step of `Containerfile.claude`.

## Decision

We apply a four-layer resilience strategy:

### 1. Containerfile apt-get hardening

- **`Acquire::Retries=3`** on `apt-get update` — retries network fetches up to 3 times, handling transient mirror connectivity issues[^3].
- **`--force-unsafe-io`** on `apt-get install` — tells `dpkg` to skip `fsync()` calls during package unpacking[^2]. This eliminates the I/O bottleneck in nested-virt. The resulting installed files are byte-identical — only the crash-safety guarantee during build is relaxed, which is acceptable because container image layers are disposable (if a build crashes, we rebuild from scratch).

### 2. Transient build error retry

`build_all_images_for_bundle()` in `build.rs` already retries on containerd snapshotter corruption errors. We extend this with a second retry path for transient I/O errors (case-insensitive matching):

- `"i/o timeout"`, `"input/output error"`, `"connection reset"`, `"temporary failure"`, `"resource temporarily unavailable"`

If the first build attempt fails with a transient error, it retries once without any recovery action (the error is often a one-off I/O hiccup). If the retry also fails, the error is enriched with VM-specific troubleshooting guidance.

### 3. Proactive nested-virt detection

On Windows, `check_os_warnings()` runs `Get-CimInstance Win32_ComputerSystem`[^4] via PowerShell and checks the `Model` and `Manufacturer` fields against known VM vendor strings (VMware, VirtualBox, Hyper-V, QEMU/KVM). We use `Get-CimInstance` rather than the deprecated `Get-WmiObject` for compatibility with both Windows PowerShell 5.1 and PowerShell 7+[^5].

If a VM is detected, a non-blocking warning is logged via `log::warn!` (visible in Desktop log files and CLI stderr via `speedwave check`). The warning does not block setup or container operations.

### 4. Parallelized image builds with bounded concurrency

`try_build_all()` in `build.rs` builds all images concurrently via `std::thread::scope` with a bounded worker pool. Worker count is capped at `min(available_parallelism, IMAGES.len())` with a fallback of `DEFAULT_BUILD_WORKER_FALLBACK` when `available_parallelism` cannot determine CPU count.

**Why bounded, not unbounded:** Running N concurrent `nerdctl build` subprocesses in nested-VM hosts amplifies two pathologies:

- I/O amplification: VMware, VirtualBox, and QEMU hosts already exhibit `input/output error` and `i/o timeout` failures under single-image builds (this ADR's primary motivation). Concurrent subprocesses multiply disk-I/O contention roughly linearly; bounding the pool caps the amplification factor.
- BuildKit snapshotter race window: concurrent overlayfs snapshotter preparation is the source of `apply layer error` and `failed to rename: file exists` errors[^6]. More parallel `Prepare` calls widens the race window; bounding limits concurrent snapshot operations.

**Error-classification contract:** `try_build_all` collects every worker's error and returns one classified error — snapshotter-class errors take priority over transient-class (because snapshotter errors require `system_prune` before retry, whereas transient errors need only a plain retry), falling back to the lowest image-index error when no class match is found. This preserves the upstream retry branches in `build_all_images_for_bundle` (snapshotter → `system_prune` + retry; transient → retry without prune) and guarantees a deterministic return value regardless of thread-scheduling order.

**Error logging:** all per-image failures are logged via `log::error!` within the worker at failure time. After the scope joins, non-chosen errors are additionally logged via `log::error!` with their full chain; the chosen error is returned as `Err` without a join-time log (the caller is responsible for logging it).

## Consequences

### Positive

- Users in nested-virt environments are more likely to complete initial setup without manual intervention.
- Build failures include actionable guidance (increase VM memory, enable nested VT-x/EPT).
- `speedwave check` proactively warns about potential issues before the build starts.
- Parallel image builds reduce wall-clock time for initial setup and `speedwave update` on hosts with available parallelism.

### Negative

- `--force-unsafe-io` reduces crash-safety during the build step. Acceptable because container layers are disposable.
- PowerShell invocation adds ~2-3s to system check on Windows (dominated by PowerShell startup). Runs only during explicit `speedwave check` and before container start — not on hot paths.
- The first attempt always builds all images in parallel before returning an error; the retry costs approximately one parallel build pass. On nested-VM hosts where parallelism amplifies I/O pressure, the bounded worker pool limits but does not eliminate this overhead.

### Neutral

- The existing `PrereqViolation` contract and all 9 call sites are unchanged. Warnings use a separate `check_os_warnings()` function.
- No new container mounts, ports, environment variables, or credential flows.
- No frontend/Angular changes needed.

## References

[^1]: VMware. "Running Nested VMs" — nested virtualization requires VT-x/EPT passthrough, which adds I/O latency. https://docs.vmware.com/en/VMware-vSphere/8.0/vsphere-resource-management/GUID-3B0A741E-5F82-4B85-A0A8-2C7E39FFC724.html

[^2]: Debian `dpkg` manpage — `--force-unsafe-io` disables fsync on unpack for faster installs. https://manpages.debian.org/bookworm/dpkg/dpkg.1.en.html

[^3]: Debian `apt.conf` manpage — `Acquire::Retries` controls the number of retry attempts for failed downloads. https://manpages.debian.org/bookworm/apt/apt.conf.5.en.html

[^4]: Microsoft Learn — `Win32_ComputerSystem` WMI/CIM class, `Model` and `Manufacturer` properties. https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-computersystem

[^5]: Microsoft Learn — `Get-CimInstance` replaces deprecated `Get-WmiObject` in PowerShell 3.0+; `Get-WmiObject` is not available in PowerShell 7+. https://learn.microsoft.com/en-us/powershell/scripting/learn/ps101/07-working-with-wmi?view=powershell-7.4

[^6]: containerd issue tracker — snapshotter `apply layer error` / `failed to rename: file exists` race on concurrent overlayfs Prepare calls. https://github.com/containerd/containerd/issues/11719
