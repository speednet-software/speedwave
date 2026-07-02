# ADR-017: Claude Code in Container via entrypoint.sh

> **Status:** Accepted
> **Context:** Claude Code must never run on the host; it runs inside the hardened, token-free container and Speedwave manages its full lifecycle.

## Decision

Claude Code is installed inside the container — at image build time and, as a fallback, at first start by `entrypoint.sh` — never on the host. The version is pinned by Speedwave and cannot be changed by users.

## Why

- Host installation would bypass every container security control (read-only filesystem, `cap_drop: ALL`, `no-new-privileges`, no tokens, no container socket) — see ADR-009.
- Users do not need Claude Code on the host; Speedwave owns the install/update/run lifecycle.
- Pinning a concrete semver (never "latest"/"stable") keeps every user of a project on the same version.

## Installation mechanism

- A reusable installer script is the SSOT used by both the build-time Containerfile and the runtime fallback — `containers/install-claude.sh`, invoked from `containers/Containerfile.claude`.
- The pinned version lives in one constant, `crates/speedwave-runtime/src/defaults.rs::CLAUDE_VERSION`. A test enforces it is a concrete semver, not "latest"/"stable".
- At build time the version is passed as a `CLAUDE_VERSION` build arg; at runtime `render_compose` injects it as an environment variable (`containers/compose.template.yml` consumes `CLAUDE_VERSION`).
- The official native installer downloads the binary from GCS and verifies its SHA256 against a version-pinned manifest; `DISABLE_AUTOUPDATER=1` prevents in-container auto-update after the pinned install.

**Accepted residual risk (CWE-494):** the bootstrap script is fetched over TLS (`--proto '=https' --tlsv1.2`) without hash verification — identical to rustup, nvm, and homebrew. Hash-pinning the bootstrap is operationally fragile (it changes independently of Claude Code versions). Mitigated by: official Anthropic installer, TLS transport, installer-side binary SHA256 check, and container isolation. See `containers/install-claude.sh`.

## Runtime behavior flags

User-overridable defaults live in `crates/speedwave-runtime/src/defaults.rs::base_env()` (overridable via `claude.env.<VAR>` in `.speedwave.json` or `~/.speedwave/config.json`):

- `CLAUDE_CODE_ENABLE_TELEMETRY=0` — disables upstream telemetry.
- `DISABLE_AUTOUPDATER=1` — prevents in-container auto-update after the pinned install.
- `IS_SANDBOX=1` — signals a sandboxed environment so `--dangerously-skip-permissions` is accepted regardless of effective UID. Both supported platforms (macOS Lima, Windows WSL2) run the container as UID 1000, so the root-user check already passes; this is defense-in-depth (see ADR-026).
- `CLAUDE_CODE_NO_FLICKER=1` — enables the alt-screen / differential (focus-view) renderer, mitigating PTY write-side backpressure that froze long streaming sessions in the CLI.

Speedwave deliberately does **not** set `CLAUDE_CODE_EFFORT_LEVEL`. The env var outranks the user's in-session `/effort` and the persisted `settings.json`,[^effort] so pinning it (even to `auto`) blocks the user from changing effort — `/effort max` reports "Not applied: env override". Omitting it lets Claude Code use the model's own default effort while keeping `/effort` working and persisted to `settings.json` (see ADR-022). A compose test asserts the var is absent from the `claude` service environment.

## Persistent state

Claude Code's binary and user data persist across container rebuilds via a per-project mount of `~/.speedwave/claude-home/<project>/` at the container home (`/home/speedwave`, read-write). The volume survives Speedwave updates; Claude Code is re-installed only when `CLAUDE_VERSION` changes in a new release.

## Custom output style

`containers/entrypoint.sh` symlinks (does not copy) the bundled "Speedwave" output style into `~/.claude/output-styles/Speedwave.md`. The symlink keeps the resources mount read-only and auto-updates on a new Speedwave version, while leaving any user-created styles in that directory intact.

## Onboarding pre-seed (`~/.claude.json`)

`containers/entrypoint.sh` creates `~/.claude.json` only when it is absent (so it never overwrites user state). It always pre-accepts the `/workspace` trust dialog. The `hasCompletedOnboarding` / `installMethod: native` fields are written **only when credentials are valid** — i.e. `~/.claude/.credentials.json` exists and is a complete JSON object. When credentials are absent those fields are omitted, so Claude Code still shows the login wizard on the next start. See ADR-052.

## Rejected alternatives

- **Install on the host** — bypasses all container security controls (ADR-009) and gives Claude Code unrestricted host access.
- **`npm install -g @anthropic-ai/claude-code`** (used in v1) — the npm package was deprecated in favor of the native installer; v2 uses the native installer only.

[^effort]: Claude Code resolves settings with environment variables taking precedence over `settings.json`; `CLAUDE_CODE_EFFORT_LEVEL` is documented in the environment-variable reference. https://docs.claude.com/en/docs/claude-code/settings#environment-variables

---

- [ADR-009: Per-project isolation preserved](./ADR-009-per-project-isolation-preserved.md)
- [ADR-026: Linux rootless container user](./ADR-026-linux-rootless-container-user.md)
- [ADR-052: Anthropic OAuth login flow](./ADR-052-anthropic-oauth-login-flow.md)
