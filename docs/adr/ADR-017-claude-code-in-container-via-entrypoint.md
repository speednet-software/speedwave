# ADR-017: Claude Code in Container via entrypoint.sh

## Decision

Claude Code is installed inside the container at first start via `entrypoint.sh`, not on the host. The version is pinned by Speedwave and cannot be changed by users.

## Rationale

Claude Code running on the host would have unrestricted access to the filesystem, network, and all host services. Running it inside a hardened container (read-only filesystem, `cap_drop: ALL`, `no-new-privileges`, no tokens, no container socket) preserves the security model from ADR-009.

## Installation Mechanism

Claude Code is installed via `install-claude.sh` — a reusable script (SSOT) used by both `Containerfile.claude` (build time) and `entrypoint.sh` (runtime fallback):[^36]

```bash
/usr/local/bin/install-claude.sh "${CLAUDE_VERSION}"
```

- `CLAUDE_VERSION` is a pinned semver (e.g. `2.1.76`) in `defaults.rs` — never "latest" or "stable"
- At build time, the version is passed as `--build-arg CLAUDE_VERSION=X.Y.Z` via the `ContainerRuntime::build_image()` trait
- At runtime, `render_compose()` injects it as an environment variable from `defaults::CLAUDE_VERSION`
- `DISABLE_AUTOUPDATER=1` prevents auto-update after pinned installation
- The official installer (`bootstrap.sh`) verifies the downloaded binary's SHA256 against a version-pinned manifest.json from GCS

**Accepted residual risk (CWE-494 of bootstrap.sh):** The bootstrap script is fetched via TLS (`--proto '=https' --tlsv1.2`) without hash verification — identical to rustup, nvm, and homebrew. Hash-pinning the bootstrap script is operationally fragile (it changes independently of Claude Code versions). Mitigating factors: (1) official Anthropic installer, (2) TLS protection, (3) installer verifies binary SHA256, (4) container isolation (cap_drop ALL, no tokens, read-only FS).

## Runtime Behavior Flags

Claude Code behavior inside the container is tuned via environment variables injected by `render_compose()`. Defaults live in `defaults::base_env()` so they are user-overridable via `claude.env.<VAR>` in `.speedwave.json` or `~/.speedwave/config.json`.

| Variable                       | Default | Purpose                                                                                                                                                           |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `0`     | Disables upstream telemetry.                                                                                                                                      |
| `DISABLE_AUTOUPDATER`          | `1`     | Prevents in-container auto-update after pinned installation.                                                                                                      |
| `IS_SANDBOX`                   | `1`     | Signals a sandboxed environment so Claude Code accepts `--dangerously-skip-permissions` under Linux rootless UID 0 (ADR-026).[^39]                                |
| `CLAUDE_CODE_NO_FLICKER`       | `1`     | Enables the alt-screen / differential renderer (focus view). Mitigates PTY write-side backpressure that previously froze long streaming sessions in the CLI.[^40] |

A separate template-sourced flag (`CLAUDE_CODE_EFFORT_LEVEL=max` in `compose.template.yml`) is considered non-user-overridable — it is a Speedwave policy, not a tuning knob.

## Persistent Volume

Claude Code binary and user data persist across container rebuilds via a named volume:

```
~/.speedwave/claude-home/<project>/ → /home/speedwave (RW, persistent)
```

This volume survives Speedwave updates. Claude Code is re-installed only when `CLAUDE_VERSION` changes in a new Speedwave release.

## Custom Output Style

`entrypoint.sh` copies the custom "Speedwave" output style to `~/.claude/output-styles/Speedwave.md` on first start. Claude Code supports custom output styles via `.md` files in this directory.[^37]

## Why Not Install on Host

- Host installation would bypass all container security controls (ADR-009)
- Users do not need Claude Code on the host — Speedwave manages the full lifecycle
- Version pinning ensures consistency across all users of a project

## Rejected: npm install

Speedwave v1 used `npm install -g @anthropic-ai/claude-code`. The npm package has been deprecated[^38] in favor of the native installer. v2 uses only the native installer.

---

[^36]: [Claude Code Setup — Install specific version](https://code.claude.com/docs/en/setup)

[^37]: [Claude Code Output Styles — Custom Styles](https://code.claude.com/docs/en/output-styles)

[^38]: [Claude Code installation — native installer replaces npm](https://code.claude.com/docs/en/setup)

[^39]: [ADR-026: Linux rootless container user](./ADR-026-linux-rootless-container-user.md)

[^40]: [Claude Code CHANGELOG — 2.1.97 introduces `CLAUDE_CODE_NO_FLICKER` / Ctrl+O focus view toggle](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md)
