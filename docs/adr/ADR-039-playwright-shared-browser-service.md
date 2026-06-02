# ADR-039: Playwright Shared Browser Service

> **Status:** Superseded by [ADR-062](ADR-062-playwright-host-gateway-access.md) — ADR-062 adds a static `extra_hosts: host.docker.internal` entry to `mcp-playwright` and documents that the shipped Containerfile uses `--allowed-hosts "*"` (NOT `mcp-hub`, as § Decision 2 below originally claimed). This document records the original design; the corrected facts are noted inline.
> **Context:** Adding browser automation as a built-in MCP worker that carries no credentials — the first credential-less service in Speedwave.

## Decision

Ship Microsoft's `@playwright/mcp` as a built-in shared worker (`mcp-playwright`), not a plugin. It accesses only public URLs, carries no credentials, runs under the standard hardened compose profile with two Chromium-specific tweaks (larger `/dev/shm`, larger `/tmp`), and is always treated as configured (no setup wizard, no Desktop credentials form).

## Why

- **Shared infrastructure, not a domain integration.** Browser automation is general-purpose: multiple plugins and Claude directly benefit from one shared Chromium instance. A built-in worker keeps the multi-MB image out of every plugin ZIP and shares the compose network.
- **Credential-less contract.** Playwright contacts only URLs supplied at call time, so it must never receive a `/tokens` mount, must always report as configured, and must show no Desktop config form. The integration status check short-circuits to `true` when a service's `auth_fields` list is empty.
- **VM isolation replaces Chromium's in-process sandbox.** `--no-sandbox` is required because the container drops all capabilities. Chromium's namespace + `seccomp-bpf` sandbox would need `SYS_ADMIN` (or a `seccomp` profile permitting `clone(CLONE_NEWUSER)`), which conflicts with `cap_drop: ALL`. The hypervisor → container-runtime → `cap_drop: ALL` + `no-new-privileges` stack provides stronger isolation than Chromium's in-process sandbox would. macOS uses the Lima VM (ADR-002); Windows uses the WSL2 / Hyper-V boundary (ADR-004).
- **Headless shell over full Chromium.** The base image ships `chromium_headless_shell`, which omits the crashpad broker, dbus, GPU, and audio stack — none of which can start under `cap_drop: ALL` with `no-new-privileges`. Web platform APIs exposed to MCP tools are identical.
- **`shm_size: 2g`.** The 64 MiB default `/dev/shm` is too small for multi-page Playwright sessions; Chromium crashes at page load with `ENOMEM`. A 2 GiB RAM-backed region avoids that without a writable volume.
- **Larger `tmpfs /tmp` (`size=1g`, `noexec`, `nosuid`).** Chromium's user-data dir and screenshot compositing live in `/tmp` because the root filesystem is `read_only`. Restarting the container wipes `/tmp`, giving a fresh profile every session.
- **No `/workspace` mount in v1.** Screenshots and content return inline as base64 in the MCP tool response, reducing the blast radius of a compromised browser session to the current conversation rather than the project directory.

## Correction (per ADR-062)

The original § Decision 2 claimed the server runs with `--allowed-hosts mcp-hub` to restrict callers to the hub. That is **not** what shipped. The Containerfile launches with `--allowed-hosts "*"`, intentionally disabling the Host-header check. The Containerfile comment explains why the flag provides no real isolation here: the worker publishes no ports (enforced by `check_no_ports_on_workers`), and any container already on the compose network can forge an arbitrary Host header in one line. Real isolation comes from the compose network plus `cap_drop: ALL` plus the read-only rootfs — not from a hostname string match. Pinning a specific hostname would only break the hub's legitimate calls.

## Heartbeat patch as deliberate tech debt

`@playwright/mcp` 0.0.70 enables a Streamable-HTTP heartbeat by default (ping every 3 s, kill the session after 5 s with no ack). The hub uses a plain request-response cycle, so the ping has nowhere to land and the server closes the connection mid-response, truncating output to zero bytes. The build patches the compiled `playwright-core` JavaScript to flip that flag to `false`, with a `grep -q` guard on a later layer that fails the build with a clear FATAL message if a version bump renames the patched call. This is acknowledged tech debt; the long-term fix is an upstream `--no-heartbeat` flag, after which the patch is replaced by the CLI flag and the pin is bumped.

## Where it lives in code

- **Worker image + launch flags** — `mcp-servers/playwright/Containerfile` (`--allowed-hosts "*"`, `--no-sandbox`, headless-shell path, heartbeat `sed` + `grep -q` guard, `--user-data-dir`/`--output-dir` redirected to `/tmp`).
- **Compose service rendering** — `crates/speedwave-runtime/src/compose.rs` (`mcp-playwright` with `read_only: true`, `cap_drop: ALL`, `no-new-privileges`, `shm_size: 2g`, no `/tokens` and no `/workspace` mount; `extra_hosts` added by ADR-062).
- **Credential-less status** — `is_service_configured` in `desktop/src-tauri/src/integrations_cmd.rs` short-circuits to `true` on empty `auth_fields`.
- **Desktop UI** — `hasConfigurableFields` getter in `desktop/src/src/app/integrations/service-card/service-card.component.ts` suppresses the form when `auth_fields` is empty.
- **Credential-less tripwire** — `CREDENTIAL_LESS_SERVICES` constant in `crates/speedwave-runtime/src/consts.rs` (test module). Originally `["playwright"]`; `office` was later added under the same contract.

## Verification (actual test names)

- `test_every_service_has_auth_fields` (`consts.rs`) — every service NOT in `CREDENTIAL_LESS_SERVICES` must declare at least one `auth_fields` entry.
- `test_every_service_has_credential_files` (`consts.rs`) — same tripwire for `credential_files`.
- `is_service_configured_returns_true_for_credential_less_service` (`integrations_cmd.rs`) — `playwright` reports configured with an empty data dir.
- `test_render_compose_playwright_service_present` (`compose.rs`) — asserts `read_only: true`, `cap_drop: ALL`, `no-new-privileges`, and `shm_size: 2g`.
- `test_render_compose_playwright_no_token_mount` (`compose.rs`) — no `/tokens` volume.
- `test_render_compose_playwright_no_workspace_mount` (`compose.rs`) — no `/workspace` mount.

## Rejected alternatives

- **Ship Playwright as a plugin.** Rejected: browser automation is shared infrastructure, so bundling the multi-MB Chromium image into each plugin ZIP would duplicate it and force every consumer to manage its own Chromium.
- **Keep Chromium's in-process sandbox.** Rejected: it requires `SYS_ADMIN` or a relaxed `seccomp` profile, both incompatible with `cap_drop: ALL`. The VM + container hardening layers provide stronger isolation.
- **Pin `--allowed-hosts` to a single hostname (`mcp-hub`).** Rejected (see Correction): it authenticates nothing on a shared compose network and only breaks the hub's legitimate calls.
- **Mount `/workspace:rw` in v1.** Deferred (YAGNI): base64 inline output covers small screenshots; a writable mount can be added later if a concrete file-output use case appears.
