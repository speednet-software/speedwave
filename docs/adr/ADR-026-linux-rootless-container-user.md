# ADR-026: Linux Rootless nerdctl — Per-Platform Container User

> **Status:** Superseded by [ADR-059](ADR-059-drop-linux-support.md) — Linux as a host platform was dropped, so the per-platform UID logic this ADR introduced no longer applies.
> **Context:** When Linux was a supported host, rootless nerdctl remapped container UIDs, breaking bind-mount access for the hardcoded `user: "1000:1000"`.

## Decision

Replace the hardcoded `user: "1000:1000"` in the compose template with a `${CONTAINER_USER}` placeholder, resolved per-platform at compose render time. At the time: Linux → `"0:0"` (root inside the rootless user namespace maps to the unprivileged host UID, so it can reach bind mounts), macOS/Lima and Windows/WSL2 → `"1000:1000"` (containerd runs as real root inside the VM, no UID remapping, so an unprivileged in-container user is preserved as defense-in-depth).

## Why (historical, while Linux was supported)

- On rootless Linux, user namespaces remapped container UID 1000 to a high subordinate host UID (~101000) that could not read or write the host-owned bind mounts (workspace, claude-home, tokens, ide-bridge). Container UID 0 mapped back to the real host user, restoring access.
- On macOS/Windows, containerd ran as root inside the VM and UID 1000 mapped 1:1, so the unprivileged user could be kept with no downside.
- A single `${CONTAINER_USER}` template variable kept the platform split in one place and let plugin services inherit the same value.

## What changed after ADR-059

- Linux host support was dropped. Only macOS (Lima) and Windows (WSL2) remain — both run containerd as root in a VM with no UID remapping.
- `compose::container_user()` is now unconditional and always returns `consts::CONTAINER_USER_UNPRIVILEGED` (`"1000:1000"`). The Linux `"0:0"` branch and the `CONTAINER_USER_ROOTLESS` constant were removed.
- The runtime no longer has a `NerdctlRuntime` with a rootless-verification `ensure_ready()`. Container orchestration goes through `LockedRuntime` over the crate-internal `LimaRuntime`/`WslRuntime` (see [ADR-066](ADR-066-locked-runtime-per-project-compose-lock.md)).
- The defense-in-depth concern from this ADR (running as UID 0 on Linux) is moot: every service now runs as the unprivileged 1000:1000, and a container escape lands inside the Lima/WSL2 VM, not on the host.

## Where it lives in code

- Per-platform user resolver — `crates/speedwave-runtime/src/compose.rs` (`container_user()`).
- The single UID constant — `crates/speedwave-runtime/src/consts.rs` (`CONTAINER_USER_UNPRIVILEGED`).
- `${CONTAINER_USER}` placeholder on every service — `containers/compose.template.yml`; substituted by `render_compose()` in `crates/speedwave-runtime/src/compose.rs`.
- Plugin services inherit the same value — `crates/speedwave-runtime/src/plugin.rs` (`generate_plugin_service`, via `container_user()`).
- Security check that every service's `user:` matches the expected value (blocks plugins from overriding it) — `crates/speedwave-runtime/src/compose.rs` (`check_container_user`, `SecurityRule::ContainerUser`).
- Runtime façade replacing the old NerdctlRuntime — `crates/speedwave-runtime/src/runtime/mod.rs`, `runtime/lima.rs`, `runtime/wsl.rs`.

## Rejected alternatives (as evaluated at the time)

- **`--userns=keep-id`** — Podman-only; not supported by nerdctl/containerd, which Speedwave uses on all platforms.
- **`chmod 777` / `chmod g+rwx` on host bind mounts** — would let the remapped UID reach the directories, but makes workspace files, tokens, and IDE-bridge lock files world/group-writable to any host process. Violates minimal exposure.
- **Selective `0:0` only for services with bind mounts** — every built-in service needs bind mounts (claude: workspace/claude-home/ide-bridge; hub: resources; each worker: its own tokens + resources), so selective application added complexity without shrinking the attack surface.
- **`--uidmap` / `--gidmap`** — nerdctl supports these on `run`, but `nerdctl compose` has no per-service UID-mapping directive, and Speedwave orchestrates everything through compose.

## References

- [rootlesscontaine.rs — containerd getting started](https://rootlesscontaine.rs/getting-started/containerd/) and [user namespaces](https://rootlesscontaine.rs/how-it-works/userns/)
- [Linux man-pages — user_namespaces(7)](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)
- [Linux kernel — no_new_privs](https://www.kernel.org/doc/html/latest/userspace-api/no_new_privs.html)
- [runc CVE-2025-31133 — GHSA-9493-h29p-rfm2](https://github.com/opencontainers/runc/security/advisories/GHSA-9493-h29p-rfm2)
