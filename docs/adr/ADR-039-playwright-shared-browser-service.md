# ADR-039: Playwright Shared Browser Service

## Status

Accepted

## Context

Speedwave's existing MCP workers (Slack, SharePoint, Redmine, GitLab) all require per-project credentials stored under `~/.speedwave/tokens/<project>/<service>/`. The infrastructure around those workers — `is_service_configured`, `TOGGLEABLE_MCP_SERVICES`, and the Desktop service-card UI — was designed with credential-bearing services as the only case.

Adding a browser automation capability via Microsoft's `@playwright/mcp` package[^1] introduces a qualitatively different kind of service: one that accesses only public URLs and carries no credentials at all. This ADR records the three non-obvious design decisions that arose from that difference, plus the choices made for container security and transport-layer compatibility.

### Why a shared service rather than a plugin

Browser automation is general-purpose infrastructure, not domain-specific integration. Multiple plugins (`figma`, `accessibility-audit`, `visual-regression`, `site-analyzer`) and Claude directly all benefit from the same browser instance. Shipping it as a built-in worker keeps the image out of individual plugin ZIPs (avoiding multi-MB duplication), lets it share the compose network with all workers, and removes the need for each consumer to manage their own Chromium installation.

## Decision

### 1 — Credential-less service contract

Playwright has no credentials: it contacts only URLs supplied at call time by Claude or a plugin. The service therefore must never receive a `/tokens` mount, must always be treated as configured (no setup wizard step), and must expose no configuration form in the Desktop UI.

Four concrete changes implement this contract:

**No `/tokens` mount.** The compose template entry for `mcp-playwright` has no `volumes:` stanza for credentials, unlike every other worker. This is an intentional absence documented in the template comment, not an oversight.[^2]

**`is_service_configured` returns `true` for empty `auth_fields`.** The Tauri command that reports integration status short-circuits to `true` when a service descriptor has an empty `auth_fields` list.[^3] Playwright's `McpServiceDesc` entry in `TOGGLEABLE_MCP_SERVICES` declares `auth_fields: &[]`, so the function never attempts to read a token directory.

**Desktop UI hides the configuration form.** `ServiceCardComponent.hasConfigurableFields` returns `auth_fields.length > 0`.[^4] When it returns `false`, the card body — setup hint, form fields, Save / Remove Credentials buttons — is entirely suppressed via `@if (!svc.configured && !expanded && hasConfigurableFields)` guards. The toggle remains as the sole interactive element. A credential-less service therefore presents as: "toggle to enable, nothing else needed."

**`CREDENTIAL_LESS_SERVICES` test allowlist.** A dedicated constant in the test module of `consts.rs` holds the exhaustive list of credential-less services (`["playwright"]` at the time of writing).[^5] Two tests enforce the contract for every entry in `TOGGLEABLE_MCP_SERVICES`:

- `test_every_service_has_auth_fields` — fails if a service not in the allowlist has an empty `auth_fields`.
- `test_every_service_has_credential_files` — fails if a service not in the allowlist has an empty `credential_files`.

These tests serve as a tripwire: if a future built-in service accidentally omits auth fields, CI fails loudly rather than silently shipping an unauthenticated service that should have required credentials.

### 2 — Container security profile and `--no-sandbox`

The Playwright container runs under Speedwave's standard hardening profile (`cap_drop: ALL`, `security_opt: no-new-privileges:true`, `read_only: true`) with two Chromium-specific additions: `shm_size: 2g` and a larger `tmpfs /tmp`.

**`--no-sandbox` is safe in this context.** Chromium's built-in process sandbox uses Linux namespaces and `seccomp-bpf` to isolate renderer processes from the browser process.[^6] Enabling it inside a container requires either `SYS_ADMIN` capability (to create user namespaces) or a `seccomp` profile that permits `clone(CLONE_NEWUSER)` — both of which conflict with `cap_drop: ALL` and the locked-down compose profile.[^7] Rather than weakening the container security posture to satisfy Chromium's internal sandbox, Speedwave provides an equivalent isolation layer at a higher level:

- **macOS:** Lima VM[^8] (ADR-002) provides a separate kernel. The Playwright container runs inside the Lima VM, which runs inside the macOS hypervisor.
- **Windows:** WSL2 with a Hyper-V boundary[^9] (ADR-004) provides equivalent kernel separation.
- **Linux:** rootless user namespaces (ADR-026) confine the entire container runtime; the container itself still drops all capabilities.

The three-layer stack (hypervisor → container runtime → `cap_drop: ALL` + `no-new-privileges`) provides stronger isolation than Chromium's in-process sandbox alone would. Passing `--no-sandbox` delegates that role to the outer layers, which is the same approach taken by all major container-based browser testing platforms.[^10]

**`chromium_headless_shell` instead of full Chromium.** The Microsoft Playwright base image ships two Chromium builds: the full browser (used for headed/GUI automation) and `chromium_headless_shell` (a stripped-down build for headless-only workloads).[^11] Regular Chromium bootstraps its own crashpad process and IPC broker, which requires `CAP_SYS_ADMIN` and a running dbus socket — neither of which is available under `cap_drop: ALL` with `no-new-privileges`. The headless shell omits the GPU stack, audio, dbus, and the crashpad broker, so it starts cleanly without any elevated capability.[^12] The web platform APIs exposed to MCP tools are identical; only the out-of-process infrastructure differs.

**`shm_size: 2g`.** Chromium uses POSIX shared memory (`/dev/shm`) for inter-process communication between the browser process and renderer processes.[^13] The Docker/containerd default for `/dev/shm` is 64 MiB, which is sufficient for single-tab CLI workloads but too small for multi-page Playwright sessions — the browser crashes at page load time with `ENOMEM`. Setting `shm_size: 2g` in the compose profile allocates a RAM-backed shared-memory region large enough for concurrent page rendering without requiring a writable volume.[^14]

**`tmpfs /tmp:noexec,nosuid,size=1g`.** Playwright uses `/tmp` for Chromium user-data caches and, when configured with `--output-dir /tmp/playwright-mcp-output`, for screenshot compositing. The `read_only: true` root filesystem prevents writes to any other path. The `size=1g` limit is intentionally larger than other workers (which use `size=64m`) to accommodate page screenshots that are returned inline as base64 rather than written to `/workspace`.

**No `/workspace` mount in v1.** Screenshots and extracted content are returned to the hub as base64-encoded data within the MCP tool response. This eliminates the need for a writable project-directory mount, reducing the blast radius of a compromised browser session to the current conversation rather than the full project directory. If a concrete use case arises that requires file-level output (e.g., saving a PDF to the project), a `/workspace:rw` mount can be added in a future version following the same pattern as other workers.

**`--allowed-hosts mcp-hub`.** The `playwright-mcp` server's `--allowed-hosts` flag restricts which hostnames may make HTTP requests to its Streamable HTTP endpoint.[^15] Setting it to `mcp-hub` ensures that only the hub — not other containers on the compose network, and not any host-side process — can invoke Playwright tools. This prevents a compromised plugin container from pivoting to the browser service.

### 3 — Heartbeat `sed` patch as deliberate tech debt

`@playwright/mcp` version 0.0.70 enables a Streamable HTTP heartbeat by default: the server sends a ping frame every 3 seconds, and kills the session after 5 seconds if no acknowledgement arrives.[^16] Speedwave's MCP Hub connects to each worker over a standard HTTP request-response cycle; it does not maintain a persistent bidirectional SSE channel between tool calls. The heartbeat ping has nowhere to land, so the server closes the connection mid-response, truncating the tool output to zero bytes.

The fix is a `sed` one-liner applied at image build time that flips the heartbeat flag from `true` to `false` in the compiled JavaScript of `playwright-core`.[^17] A `grep -q` guard on the next `RUN` layer verifies that the patched string is present; if a version bump renames or restructures the function, the guard fails the build with a clear message rather than shipping a silently broken image:

```
FATAL: heartbeat patch did not apply — verify path for @playwright/mcp <version>
```

This is acknowledged as deliberate tech debt. The correct long-term fix is an upstream `--no-heartbeat` CLI flag in `@playwright/mcp`. When that flag is available, the `sed` block in the Containerfile must be replaced with the flag in the `CMD` array, and the version pin updated accordingly. The build-time guard ensures the patch does not survive undetected across a version bump.

## Consequences

### Positive

- **Zero-configuration browser automation.** Users enable the Playwright toggle and Claude immediately has browser access — no token entry, no setup wizard, no credentials to manage.
- **Single shared Chromium instance.** All plugins that consume browser automation reuse the same container, avoiding duplicated image layers and concurrent Chromium startups.
- **No credential surface.** A compromised Playwright container leaks nothing about user accounts, API keys, or project data — there are no credentials to exfiltrate.
- **`CREDENTIAL_LESS_SERVICES` tripwire.** The test allowlist prevents future services from accidentally omitting auth fields and shipping unauthenticated.
- **Ephemeral browser state.** Container restart wipes `/tmp` (the user-data dir), giving a fresh Chromium profile on every Speedwave session start.

### Negative

- **`sed` patch fragility.** The heartbeat patch is pinned to `@playwright/mcp 0.0.70`'s internal JavaScript structure. Any version bump requires verifying the patch still applies and the guard still fires. The build-time check catches this at image build, not at runtime.
- **No persistent screenshot files.** Outputs return as base64, which is suitable for small screenshots but impractical for large PDFs or multi-page captures. Adding `/workspace:rw` in a future version will address this.
- **`shm_size` is static.** The 2 GiB shared-memory reservation is consumed whether the browser opens one tab or twenty. Future work could make this configurable per-project, but YAGNI applies until a concrete memory-pressure report exists.

## Verification

- `test_every_service_has_auth_fields` — asserts `playwright` has an empty `auth_fields` and that every other service in `TOGGLEABLE_MCP_SERVICES` has at least one field.
- `test_every_service_has_credential_files` — asserts `playwright` has an empty `credential_files` and that every other service has at least one file.
- `test_is_service_configured_returns_true_for_credential_less_service` — calls `is_service_configured_with_home` for `playwright` with an empty temp dir and asserts `true` (no token directory required).
- `test_playwright_has_no_tokens_mount` — renders a compose with Playwright enabled and asserts no `volumes:` entry under `mcp-playwright` references the tokens path.
- `test_playwright_has_shm_size` — renders a compose with Playwright enabled and asserts `shm_size: 2g`.
- `test_playwright_has_tmp_size_1g` — renders a compose with Playwright enabled and asserts the `tmpfs` entry for `/tmp` uses `size=1g`.

## References

[^1]: `@playwright/mcp` — Microsoft's official MCP server for Playwright browser automation: https://github.com/microsoft/playwright-mcp

[^2]: `containers/compose.template.yml`, `mcp-playwright` service definition — no `volumes:` credentials stanza: https://github.com/speednet-software/speedwave/blob/dev/containers/compose.template.yml

[^3]: `desktop/src-tauri/src/integrations_cmd.rs`, `is_service_configured` — short-circuits to `true` when `auth_fields` is empty: https://github.com/speednet-software/speedwave/blob/dev/desktop/src-tauri/src/integrations_cmd.rs

[^4]: `desktop/src/src/app/integrations/service-card/service-card.component.ts`, `hasConfigurableFields` getter: https://github.com/speednet-software/speedwave/blob/dev/desktop/src/src/app/integrations/service-card/service-card.component.ts

[^5]: `crates/speedwave-runtime/src/consts.rs`, `CREDENTIAL_LESS_SERVICES` constant and associated tests: https://github.com/speednet-software/speedwave/blob/dev/crates/speedwave-runtime/src/consts.rs

[^6]: Chromium sandbox architecture — uses Linux namespaces and `seccomp-bpf` for renderer isolation: https://chromium.googlesource.com/chromium/src/+/main/docs/linux/sandboxing.md

[^7]: Docker/containerd and Chromium sandbox — `SYS_ADMIN` or `clone(CLONE_NEWUSER)` required for the Chromium namespace sandbox inside a container: https://chromium.googlesource.com/chromium/src/+/main/docs/linux/sandboxing.md#the-sandbox-in-detail

[^8]: ADR-002 — Lima as VM Manager on macOS, establishing the hypervisor isolation layer: https://github.com/speednet-software/speedwave/blob/dev/docs/adr/ADR-002-lima-as-vm-manager-on-macos.md

[^9]: ADR-004 — WSL2 + nerdctl on Windows, establishing the Hyper-V isolation layer: https://github.com/speednet-software/speedwave/blob/dev/docs/adr/ADR-004-wsl2-and-nerdctl-on-windows.md

[^10]: Google Cloud Run Jobs with Chromium — `--no-sandbox` is the documented approach for containerised Chromium when the container itself provides isolation: https://cloud.google.com/run/docs/configuring/services/memory-limits

[^11]: Microsoft Playwright Docker image contents — ships both full Chromium and `chromium_headless_shell`: https://playwright.dev/docs/docker

[^12]: Playwright headless shell vs full Chromium — the shell build omits crashpad, dbus, GPU, and audio stack: https://playwright.dev/docs/browsers#chromium

[^13]: Chromium shared-memory IPC — uses `/dev/shm` (POSIX shared memory) for inter-process communication: https://www.chromium.org/developers/design-documents/inter-process-communication/

[^14]: Docker `shm_size` compose reference — sets the size of `/dev/shm` for a service: https://docs.docker.com/compose/compose-file/05-services/#shm_size

[^15]: `@playwright/mcp` `--allowed-hosts` flag — restricts which hostnames may connect to the Streamable HTTP endpoint: https://github.com/microsoft/playwright-mcp#configuration

[^16]: MCP Streamable HTTP transport heartbeat — the spec defines an optional ping/pong keep-alive on SSE connections; `@playwright/mcp` enables it by default in 0.0.70: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http

[^17]: `mcp-servers/playwright/Containerfile` — the `sed` patch and `grep -q` guard at build time: https://github.com/speednet-software/speedwave/blob/dev/mcp-servers/playwright/Containerfile
