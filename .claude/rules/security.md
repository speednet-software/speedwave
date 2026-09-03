# Security Rules

**Security is a core obsession, not an afterthought.** Every change must preserve or improve the security model. When in doubt, choose the more secure option.

## Non-negotiable invariants

- Claude container: no tokens, no container socket, runs as UID 1000:1000; containerd runs inside a VM on both platforms (Lima/WSL2).
- OWASP container hardening on every container: `cap_drop: ALL`, `no-new-privileges`, `read_only` filesystem, `tmpfs /tmp:noexec,nosuid`, resource limits. **This is not just template convention: `compose::SecurityCheck::run()` re-validates every rendered compose before `up` on every start path (CLI, Desktop, update, rollback)** — the hardening flags, container user, localhost-only port policy, no-tokens-on-claude/hub, and per-worker volume profiles (`VolumeCheckRules`). Adding or changing a template mount without a matching volume profile in `security_check.rs` hard-fails at container start, not in a named unit test. `fs_security.rs` auto-fixes data-dir modes (0o700/0o600) before the check runs; `speedwave check` reports-only.
- Token isolation: **every token mount is `:ro`, no exception** — a compromised worker exposes only its own service. `office` and `playwright` mount no `/tokens` at all; `office` additionally runs on an egress-less `internal: true` network and enforces a `/workspace/`-only path policy (canonicalize, reject symlinks) — do not add remote-fetch paths to it. The proxy mounts only `tokens/<project>/llm:/tokens:ro`.
- Workers mount only their own credentials at `/tokens:ro`. `slack` and `sharepoint` additionally mount the project dir `/workspace:rw` for file exchange, and `atlassian` mounts `/workspace:ro` for Jira attachment uploads (all three enforced per-service by `security_check.rs::check_builtin_workspace_worker_volumes`) — a new file-exchanging worker follows this profile, preferring `:ro` unless it must write, never a new mount surface.
- Hub holds zero external credentials (render-time gate rejects token mounts/secret env on it); it carries only Speedwave-internal bridge bearer tokens under `/secrets/…:ro`. It also mounts the resolved PII policy at `/policy:ro` and, deliberately, the PII audit directory at `/audit:rw` (its only writable mount — `SecurityRule::AuditMount`); proxy mirrors both mounts. Neither directory may ever reach the `claude` container, at any target (`SecurityRule::NoPolicyOrAuditMountClaude`).
- OAuth refresh happens in the host-side `oauth` worker — workers never write tokens. **The `oauth` worker (tools `refresh`/`forget`) is never enumerated to Claude and never appears in the hub's tool registry** — its only callers are other workers in the same project, which reach it directly, bypassing the hub; never wire it into `WORKER_*_URL` discovery (that would let a prompt-injected Claude call `forget`/`refresh` against every service's credentials).
- **Transcription is fully local:** raw audio and live/offline transcript passes never leave the machine — only the final transcript text goes to Claude, and only on an explicit user action. Never add a cloud-STT path, auto-send, or any telemetry carrying audio/transcript content.
- SHA256-verified binary downloads in every Containerfile; health endpoints return only `{"status":"ok"}` (or 500 `{"status":"error"}`) — no service metadata.
- **No host code-execution channel for Claude, ever.** A whitelist-gated, opt-in host command runner was fully implemented and then deliberately reverted: any host-exec capability a prompt-injected Claude can drive erodes the isolation guarantee, warnings notwithstanding. Do not reintroduce it in any form (worker, mcp-os tool, bridge handler) without a new ADR reversing that decision.
- **Speedwave never performs Anthropic OAuth and never parses/captures/stores Anthropic tokens.** Claude Code owns the whole credential lifecycle inside the container; a Speedwave-native flow or stdout token capture is brittle and violates Anthropic's Consumer Terms.
- Any new host-side WebSocket relay must be a `HostBridge` (`desktop/src-tauri/src/bridges/host_bridge.rs`) — never a hand-rolled listener/lock-file/token stack; the skeleton owns the audited security model (0o600 lock, constant-time token compare, Origin policy, watchdog).

## When implementing any feature, ask

- Does it relax any invariant above? Find a different approach.
- Does it add attack surface? Document and mitigate it.
- Does it mount host filesystem into a container? Minimize scope, `:ro` wherever possible; `/workspace:rw` is the only writable cross-boundary surface.
- Does it accept a URL/hostname/IP from config, repo `.speedwave.json`, or user input? It must go through the shared SSRF validator in `url_validation.rs`: `validate_url` (fixed `PrivatePolicy::BlockLoopback`) or `validate_collector_url(url, policy)` when the caller must choose the policy. Repo `.speedwave.json` must never override `provider`/`base_url`-class fields.

## Host-side outbound HTTP (Tauri/Desktop)

- All outbound HTTP from host code uses hardened `reqwest` clients via the shared helpers (`desktop/src-tauri/src/http_util.rs` + `url_validation.rs`): `redirect::Policy::none()`, bounded timeout, capped body. The LLM discovery probe (`llm_cmd/discovery.rs`) rejects `text/html` responses before parsing (a denylist on that one path, not a general allow-list). Reuse the helpers — never copy the constants.
- Sole redirect exception: the transcription model downloader follows redirects only to hosts in `consts::TRANSCRIPTION_MODEL_ALLOWED_REDIRECT_HOSTS`; adding a host requires an ADR delta.
- DNS rebinding on user-originated URLs is an accepted residual risk — never add a codepath that lets an attacker inject URLs into config without explicit user action.
- TLS: `rustls-tls` with bundled CA roots; switching to system roots requires an ADR.

## Bundle integrity (macOS + Windows)

Every bundled Mach-O in `tauri.macos.conf.json` `bundle.resources` must be in `sign-bundled-binaries.sh` `SIGN_TARGETS`, and binaries using restricted platform APIs need an entitlements plist in `desktop/src-tauri/entitlements/` (add a new plist; never relax an existing one). Coverage is test-guarded — keep the guards green.

Windows (ADR-086): every PE file we build that ships via `tauri.windows.conf.json` `bundle.resources` must be in `sign-windows-binaries.ps1` `$SignTargets`; Tauri's own `signCommand` covers the app binary and installers. Signing authenticates through GitHub OIDC (federated credential bound to the `release` environment) — never introduce a stored Azure client secret or a PFX-in-secret path, and never re-sign vendor-signed or hash-pinned binaries (`node.exe`, `vulkan-1.dll`).
