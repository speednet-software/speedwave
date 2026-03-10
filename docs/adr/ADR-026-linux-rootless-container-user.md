# ADR-026: Linux Rootless nerdctl — Per-Platform Container User

> **Status:** Accepted
> **Date:** 2026-03-10

---

## Context

On Linux, Speedwave uses rootless nerdctl (containerd running as the unprivileged host user).[^1] In rootless mode, Linux user namespaces remap UIDs between the container and the host:

- **UID 0** in the container maps to the host user's real UID (e.g., 1000).[^2]
- **UID 1000** in the container maps to a subordinate UID in the host's subuid range (e.g., ~101000).[^2]

This remapping is a fundamental property of user namespaces (`user_namespaces(7)`).[^3] A process running as UID 1000 inside a rootless container cannot access files owned by the host user, because from the host kernel's perspective it runs as UID ~101000.

The previous hardcoded `user: "1000:1000"` in `compose.template.yml` caused all containers on Linux rootless to run as a remapped UID (~101000) that cannot read or write bind-mounted host directories (workspace, claude-home, tokens, ide-bridge). This broke every Linux user.

On macOS (Lima) and Windows (WSL2), containerd runs as root inside a VM. Lima's default template starts containerd as a systemd service under root.[^4] WSL2 distributions run a full Linux kernel in a lightweight Hyper-V VM where containerd also runs as root.[^5] In both cases, UID 1000 maps directly to UID 1000 — no user namespace remapping occurs.

## Decision

Replace hardcoded `user: "1000:1000"` with a `${CONTAINER_USER}` template variable, resolved per-platform at compose render time:

| Platform | Value         | Reason                                                                      |
| -------- | ------------- | --------------------------------------------------------------------------- |
| Linux    | `"0:0"`       | Root in user namespace = host user UID; can access bind mounts              |
| macOS    | `"1000:1000"` | Lima VM runs containerd as real root; unprivileged user as defense-in-depth |
| Windows  | `"1000:1000"` | WSL2 runs containerd as real root; same as macOS                            |

## Security Analysis

Running as UID 0 inside rootless containers removes one defense-in-depth layer. The remaining security controls are:

| Control                           | Protection                                        | Status               |
| --------------------------------- | ------------------------------------------------- | -------------------- |
| User namespace (rootless nerdctl) | UID 0 in container = unprivileged host UID        | Active               |
| `cap_drop: ALL`                   | No Linux capabilities                             | Active               |
| `no-new-privileges: true`         | Cannot gain capabilities via execve               | Active               |
| `read_only: true`                 | Cannot modify filesystem                          | Active               |
| `tmpfs: /tmp:noexec,nosuid`       | Cannot execute from /tmp, setuid disabled         | Active               |
| **Non-root user (UID 1000)**      | **Kernel UID 0 special treatment does not apply** | **Removed on Linux** |
| Resource limits (CPU + memory)    | Prevents resource exhaustion                      | Active               |
| No tokens, no container socket    | Minimal attack surface                            | Active               |

Note: several of these controls are coupled. `cap_drop: ALL` and `no-new-privileges` work together to prevent capability acquisition, and `read_only` and `tmpfs: noexec` work together to prevent binary injection. They are listed separately because each addresses a distinct attack vector, but they are not fully independent layers.

The seccomp default profile in containerd is capability-gated, not UID-gated[^6] — the syscall filter is identical for UID 0 and UID 1000 when `cap_drop: ALL` is set.

With `no-new-privileges: true`, the kernel blocks the UID 0 special treatment during `execve()` that would normally grant all file capabilities.[^7] Combined with the empty capability bounding set from `cap_drop: ALL`, there is no path for UID 0 to regain capabilities.

The `read_only: true` filesystem and `tmpfs: /tmp:noexec,nosuid` prevent placing or executing setuid binaries. Any existing setuid binaries in the base image are inert due to `no-new-privileges`.

**Trade-off accepted:** Container escape CVEs (e.g., runc CVE-2025-31133[^8]) list non-root as a recommended mitigation alongside user namespaces. Removing non-root means relying on the remaining controls listed above. User namespace isolation remains active and provides host-level UID separation regardless of the in-container UID.

## Implementation

### Constants (`consts.rs`)

```rust
pub const CONTAINER_USER_UNPRIVILEGED: &str = "1000:1000";
pub const CONTAINER_USER_ROOTLESS: &str = "0:0";
```

### Platform dispatch (`compose.rs`)

```rust
pub fn container_user() -> &'static str {
    #[cfg(target_os = "linux")]
    { consts::CONTAINER_USER_ROOTLESS }    // "0:0"
    #[cfg(not(target_os = "linux"))]
    { consts::CONTAINER_USER_UNPRIVILEGED } // "1000:1000"
}
```

Follows the same `#[cfg(target_os)]` pattern as `host_gateway_ip()`.

### Template (`compose.template.yml`)

All 6 built-in services use `user: "${CONTAINER_USER}"` instead of `user: "1000:1000"`.

### Substitution sites

The `${CONTAINER_USER}` variable is resolved in three locations:

1. **`render_compose()`** — main compose template rendering, where all `${CONTAINER_USER}` placeholders in `compose.template.yml` are replaced.
2. **`apply_llm_config()`** — dynamically created `llm-proxy` service, which injects `user: "{container_user}"` directly into the inline YAML.
3. **`merge_compose_fragment()`** — addon compose fragments, where `${CONTAINER_USER}` is resolved before merging addon services into the main compose document.

### SecurityCheck: `check_container_user`

A `CONTAINER_USER` security check in `SecurityCheck::run()` validates that every service in the generated compose YAML has a `user:` field matching the platform-expected value (`container_user()`). This prevents addons from overriding the container user to gain elevated access. Services with a missing or mismatched `user:` field trigger a `SecurityViolation` that blocks `compose_up`.

### Runtime rootless verification

`NerdctlRuntime::ensure_ready()` verifies that containerd is running in rootless mode by checking for the `"rootless"` string in `nerdctl info` output. If rootful containerd is detected, `ensure_ready()` returns an error and blocks container startup. This safeguards against accidental rootful usage, where UID 0:0 in containers would be real root on the host.

## Consequences

### Positive

- Linux rootless nerdctl works — containers can access bind-mounted host directories
- macOS and Windows security posture unchanged (UID 1000:1000 preserved)
- Addon authors can use `${CONTAINER_USER}` in compose fragments
- `check_container_user` SecurityCheck prevents addons from hardcoding a different user

### Negative

- One defense-in-depth layer (non-root user) removed on Linux
- If a future kernel bug bypasses `no-new-privileges` AND the capability bounding set, UID 0 could theoretically regain capabilities (UID 1000 could not)
- **Rootful containerd risk:** If `NerdctlRuntime::ensure_ready()` is bypassed or its rootless check fails to detect rootful mode, UID 0:0 in containers would be real root on the host. Mitigated by the explicit rootless verification in `ensure_ready()`, which checks `nerdctl info` output before any containers are started.
- **All services run as 0:0 on Linux**, including addon services. There is no per-service user override — the `check_container_user` SecurityCheck enforces a uniform user across all services.
- **Increased blast radius for container escapes on Linux vs macOS/Windows.** On macOS and Windows, a container escape lands in a VM (Lima or WSL2), adding a hypervisor boundary. On Linux, containers run natively — a container escape lands directly on the host, constrained only by the user namespace UID mapping.

### Neutral

- `Containerfile.claude` build-time `USER 1000` and `chown 1000:1000` unchanged — these are build-time operations; runtime `user:` in compose overrides the Dockerfile `USER`

## Rejected Alternatives

### 1. `--userns-keep-id` (Podman-only)

Podman supports `--userns=keep-id` which maps the host user's UID to the same UID inside the container, avoiding the UID 0 requirement.[^9] However, this flag is Podman-specific and not supported by nerdctl or containerd. Speedwave uses nerdctl as its container runtime on all platforms.

### 2. `chmod 777` / `chmod g+rwx` on bind-mounted directories

Making bind-mounted directories world-writable or group-writable on the host would allow UID 1000 (mapped to ~101000) to access them. This weakens host-level filesystem permissions — any process on the host could read or modify workspace files, tokens, and IDE bridge lock files. This violates the security principle of minimal exposure.

### 3. Selective 0:0 only for services needing bind mounts

Rather than applying `user: "0:0"` uniformly, only services with bind mounts could use 0:0 while others remain at 1000:1000. In practice, all 6 built-in services require bind mounts: `claude` mounts workspace, claude-home, and ide-bridge; `mcp-hub` mounts resources; each MCP worker mounts its own tokens directory and resources. Since every service needs bind-mount access, selective application adds complexity without reducing the attack surface.

### 4. `--uidmap` / `--gidmap` flags

nerdctl supports `--uidmap` and `--gidmap` flags for per-container UID mapping on `nerdctl run`.[^10] However, `nerdctl compose` does not support per-service UID mapping directives — there is no compose YAML equivalent of these flags. Speedwave uses compose for all container orchestration.

---

[^1]: [rootlesscontaine.rs — Getting Started with containerd](https://rootlesscontaine.rs/getting-started/containerd/)

[^2]: [rootlesscontaine.rs — User Namespaces](https://rootlesscontaine.rs/getting-started/common/userns/)

[^3]: [Linux man-pages — user_namespaces(7)](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)

[^4]: [Lima default template — containerd runs as root inside the VM](https://github.com/lima-vm/lima/blob/master/examples/default.yaml)

[^5]: [Microsoft — WSL2 architecture overview](https://learn.microsoft.com/en-us/windows/wsl/about#what-is-wsl-2)

[^6]: [containerd seccomp default profile — capability-gated syscall filtering](https://github.com/containerd/containerd/blob/main/contrib/seccomp/seccomp_default.go)

[^7]: [Linux kernel — no_new_privs](https://www.kernel.org/doc/html/latest/userspace-api/no_new_privs.html)

[^8]: [runc CVE-2025-31133 — GHSA-9493-h29p-rfm2](https://github.com/opencontainers/runc/security/advisories/GHSA-9493-h29p-rfm2)

[^9]: [Podman — `--userns=keep-id` documentation](https://docs.podman.io/en/latest/markdown/podman-run.1.html#userns-mode)

[^10]: [nerdctl run — `--uidmap` flag](https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md#nerdctl-run)
