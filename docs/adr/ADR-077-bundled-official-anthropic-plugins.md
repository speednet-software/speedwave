# ADR-077: Bundle Official Anthropic Claude Code Plugins

**Status:** Accepted

**Date:** 2026-07-05

> **Amendment (2026-07-17):** The decision assumed `claude plugin install <name>@claude-plugins-official` works in a fresh home. It does not: Claude Code seeds the official-marketplace registration only during interactive first launch — never from headless sessions or `claude plugin` CLI calls — so in a fresh per-project home every bundled install fails with "Plugin not found in marketplace", and the error's suggested remedy (`marketplace update`) fails on the same missing registration.[^9] Verified live on Claude Code 2.1.206: only projects where the user happened to run the interactive CLI ever acquired the marketplace. The entrypoint now bootstraps it — an idempotent `claude plugin marketplace add anthropics/claude-plugins-official` immediately before the first actual install, skipped entirely when `known_marketplaces.json` already lists the marketplace (so restarts pay no network call), attempted at most once per start, non-fatal and diagnostics-logged on failure. A custom `SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE` is not bootstrapped: its source repo is unknown to the entrypoint.

## Context

Claude Code supports a plugin system whose components (skills, commands, agents, hooks, LSP servers) install from marketplaces.[^1] Anthropic publishes a first-party marketplace, `claude-plugins-official`, from which plugins install via `claude plugin install <name>@<marketplace>`.[^2] We want a curated set of these official plugins available and enabled by default the moment a user launches Speedwave, while leaving the user free to disable any (or add their own).

The Speedwave claude container is hardened (read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, UID 1000) but **has outbound internet egress by design** — only the `office` worker runs on an egress-less `internal: true` network (ADR-055). Verified live: `curl https://github.com` returns 200 from inside the container. The `~/.claude` home is a per-project host bind mount, so plugin installs and enable/disable state persist across restarts.

## Decision

**Install the bundled plugins at container start via `claude plugin install`, from the entrypoint.** The entrypoint reads the currently-installed set once (`claude plugin list --json`) and runs `claude plugin install <name>@claude-plugins-official` only for names in `defaults::BUNDLED_PLUGINS` that are not already present. Skipping already-installed plugins is what makes a user `/plugin disable` survive a restart: `claude plugin install` re-enables a plugin, so reinstalling one the user had disabled would silently re-enable it. Each install is bounded by `timeout` and non-fatal — a failure (e.g. GitHub unreachable) logs a warning with the captured error and never blocks the session. The plugin list and marketplace reach the container as the `SPEEDWAVE_BUNDLED_PLUGINS` / `SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE` env vars, rendered from the SSOT const into the compose template; both are in `RESERVED_ENV_KEYS` so a repo `.speedwave.json` cannot redirect which plugins install.

`claude plugin install` enables a plugin on install; a later user `/plugin disable` writes `enabledPlugins: false` at user scope, which persists across restarts and updates.[^3] We do **not** write the enablement ourselves and do **not** ship any managed-settings file — versions are not pinned, so users may add or update plugins freely.

### The 5 bundled plugins

| Plugin                 | Kind                | License        |
| ---------------------- | ------------------- | -------------- |
| `frontend-design`      | skills              | Apache-2.0[^4] |
| `feature-dev`          | agents + commands   | Apache-2.0[^4] |
| `claude-md-management` | commands + skills   | Apache-2.0[^4] |
| `superpowers`          | skills + hooks      | MIT[^5]        |
| `typescript-lsp`       | LSP (metadata only) | Apache-2.0[^4] |

### TypeScript language server pre-baked into the image

The `typescript-lsp` plugin ships only an `lspServers` metadata entry pointing at the bare `typescript-language-server` command; it does not fetch the server itself. We therefore pre-bake `typescript-language-server` and `typescript` into the claude image at build time (`npm install -g`, as root, into `/usr/local`), pinned by version via `ARG` (the same pattern the playwright worker uses) so a rebuild is deterministic. Both are Apache-2.0, so redistributing them inside our image is permitted.[^6][^7]

### `php-lsp` excluded

The official `php-lsp` plugin's language server is Intelephense, which is proprietary/freemium: its licence grants only a "personal, non-transferable" right to use the software on the licensee's own devices and prohibits reproducing or distributing any part of it.[^8] Bundling or auto-installing Intelephense would be redistribution and is not permitted; in a container the user has no independent install path either. `php-lsp` is dropped.

## Consequences

- Delivery depends on GitHub/marketplace reachability at first start. Because the plugin cache lives on the persistent `~/.claude` mount, only the first project run needs egress; a failed install is a warning, not a blocker.
- Plugin versions are not pinned — a bump upstream may pull a newer plugin. This matches the fact that users can already run `claude plugin update` themselves.
- The pre-baked TypeScript server is version-pinned via `ARG`; bumping it edits the Containerfile and rebuilds the image.
- This mechanism is independent of the Speedwave sibling-repo plugin system (`SPEEDWAVE_PLUGINS`); the two do not interact.

[^1]: Claude Code plugins overview - https://code.claude.com/docs/en/plugins

[^2]: Discover and install plugins - https://code.claude.com/docs/en/discover-plugins

[^3]: Plugin settings and default enablement - https://code.claude.com/docs/en/settings

[^4]: `claude-plugins-official` marketplace (plugins carry Apache-2.0 LICENSE files) - https://github.com/anthropics/claude-plugins-official

[^5]: superpowers plugin (MIT) - https://github.com/obra/superpowers

[^6]: `typescript-language-server` (Apache-2.0) - https://www.npmjs.com/package/typescript-language-server

[^7]: TypeScript (Apache-2.0) - https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt

[^8]: Intelephense end-user licence (personal, non-transferable; no redistribution) - https://intelephense.com/

[^9]: claude-code issue #66750 — official marketplace auto-seeded only on interactive first launch, no autoheal - https://github.com/anthropics/claude-code/issues/66750
