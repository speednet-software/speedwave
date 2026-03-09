# ADR-017: Claude Code in Container via entrypoint.sh

## Decision

Claude Code is installed inside the container at first start via `entrypoint.sh`, not on the host. The version is pinned by Speedwave and cannot be changed by users.

## Rationale

Claude Code running on the host would have unrestricted access to the filesystem, network, and all host services. Running it inside a hardened container (read-only filesystem, `cap_drop: ALL`, `no-new-privileges`, no tokens, no container socket) preserves the security model from ADR-009.

## Installation Mechanism

`entrypoint.sh` uses the official native installer with a version pin:[^36]

```bash
curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}"
```

- `CLAUDE_VERSION` is injected from `defaults.rs` by `render_compose()` — always a concrete version, never "latest"
- `DISABLE_AUTOUPDATER=1` prevents auto-update after pinned installation
- Version verification: `claude --version` output is compared to expected version; mismatch causes `exit 1` (fail fast)

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
