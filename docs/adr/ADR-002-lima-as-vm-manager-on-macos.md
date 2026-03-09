# ADR-002: Lima as VM Manager on macOS

## Decision

Lima manages the VM on macOS using Apple Virtualization Framework (`vmType: vz`).

## Rationale

Lima[^8] is an open-source VM manager built specifically as a Docker Desktop alternative on macOS. It uses Apple VZ (the same hypervisor Docker Desktop has used since version 4.15+[^9]), which provides:

- Full performance on Apple Silicon (native ARM)
- Automatic port forwarding (`guestPortRange: [3000, 3010]`)
- Direct mount of `~/.speedwave` into the VM
- CLI management via `limactl`

Implemented in current codebase:

```rust
let vm_type = if cfg!(target_os = "macos") { "vz" } else { "qemu" };
```

## Distribution

Lima is bundled inside the application at `.app/Contents/Resources/lima/` (see ADR-021). The user does not need to install Lima separately — there is no `brew install lima` step.

Release artifacts include the Lima binary for the target architecture (arm64 for Apple Silicon, amd64 for Intel). SHA256 checksums are verified during the build process.

## Isolation

Speedwave uses a dedicated Lima home directory to prevent conflicts with any user-installed Lima instance:

```
LIMA_HOME=~/.speedwave/lima
```

This means Speedwave's VM (`speedwave`) is invisible to a user's own `limactl list`, and vice versa. The two installations are completely independent.

## Binary Resolution

The runtime resolves the `limactl` binary path using the following order:

1. `SPEEDWAVE_RESOURCES_DIR` environment variable — used in development and testing to point to a custom Lima build
2. `.app/Contents/Resources/lima/bin/limactl` — production path, resolved relative to the running executable via `std::env::current_exe()`
3. System PATH fallback — development mode only, allows using a Homebrew-installed Lima during local development

---

[^8]: [Lima GitHub repository](https://github.com/lima-vm/lima)

[^9]: [Docker Desktop 4.15 - Apple Virtualization Framework](https://docs.docker.com/desktop/release-notes/#4150)
