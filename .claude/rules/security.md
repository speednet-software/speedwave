# Security Rules

**Security is a core obsession, not an afterthought.** Every architectural decision must preserve or improve the security model established in Speedwave v1. When in doubt, choose the more secure option.

## Security principles inherited from v1 (non-negotiable)

- Claude container: no tokens, no container socket, container user UID 1000:1000 (containerd runs inside a VM on both supported platforms — Lima on macOS, WSL2 on Windows; see ADR-059)
- OWASP container hardening: `cap_drop: ALL`, `no-new-privileges`, `read_only` filesystem, `tmpfs: /tmp:noexec,nosuid`
- Token isolation: each MCP worker mounts **only its own** service credentials at `/tokens` read-only — a compromised worker exposes only that service. Every built-in worker mounts `/tokens:ro` with no exception (SharePoint's former `:rw` token mount was retired when OAuth refresh moved to the host-side `oauth` worker — see ADR-060)
- Hub has zero tokens — compromise of the hub exposes nothing
- Lima VM / WSL2: kernel-level isolation layer on top of container isolation
- Resource limits per container (CPU + memory caps)
- SHA256-verified binary downloads in Containerfile
- Health endpoints return only `{ "status": "ok" }` — no service metadata leaked

## When implementing any feature, ask:

- Does this require relaxing any of the above? If yes — find a different approach.
- Does this add a new attack surface? Document it and mitigate it.
- Does this require mounting host filesystem into a container? Minimize scope, use `:ro` wherever possible.
- Does it accept a URL, hostname, or IP from config / repo `.speedwave.json` / user input? It must go through the shared SSRF validator (`url_validation::validate_url` + the appropriate `PrivatePolicy`). See `.claude/rules/local-llm.md` for the full policy and the metadata-endpoint threat model. Repo `.speedwave.json` must never override `provider`/`base_url`-class fields.
- Does it run on the **host** (Tauri/Desktop) and call out over HTTP? Apply the layered hardening from ADR-041: `redirect::Policy::none()`, request timeout, body-size cap, `Content-Type` allow-list. Do **not** copy these constants — reuse `desktop/src-tauri/src/url_validation.rs` and `http_util.rs`.

## macOS bundle integrity (delivery requirement)

- Every bundled Mach-O listed in `desktop/src-tauri/tauri.macos.conf.json` `bundle.resources` must be signed by `scripts/sign-bundled-binaries.sh` — these two lists are an SSOT-alignment pair (CLAUDE.md). Adding a binary to the bundle without adding it to `SIGN_TARGETS` ships an unsigned Mach-O.
- Bundled binaries that use restricted platform APIs need an entitlements plist in `desktop/src-tauri/entitlements/` (e.g. `virtualization.plist` for `limactl`, `apple-events.plist` / `calendars.plist` for native helpers). Adding a new such binary = adding a new plist, not relaxing an existing one.

## Host-side outbound HTTP (Desktop / Tauri)

The `claude` container's network surface is governed by the v1 invariants above. Code running on the **host** (Tauri commands like `discover_llm_models`, Redmine proxy, update checker) is a separate threat surface:

- All outbound HTTP from Tauri commands goes through `reqwest` clients configured per ADR-041 (no redirects, bounded timeout, capped body, `Content-Type` allow-list where the response is parsed).
- DNS rebinding is an accepted residual risk for user-originated URLs (see ADR-041 §"Residual risks (accepted)"). Do not introduce a codepath that lets an attacker inject URLs into config without explicit user action — that would invalidate the accepted-risk decision.
- TLS uses `rustls-tls` with bundled CA roots. Do not switch to system roots without an ADR.
