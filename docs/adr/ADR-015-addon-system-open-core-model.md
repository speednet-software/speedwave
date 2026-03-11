# ADR-015: Addon System — Open-Core Model

## Decision

Speedwave uses an open-core model: Apache-2.0-licensed core with proprietary addons distributed as ZIP packages. Addon compose fragments are merged at generation time by `render_compose()`, not at runtime via compose `include`.

## Rationale

**Open-core split:**

| Layer                                                                                   | License            | Repository              |
| --------------------------------------------------------------------------------------- | ------------------ | ----------------------- |
| Speedwave core (hub, slack, gitlab, redmine, sharepoint, mcp-os, runtime, CLI, Desktop) | MIT                | Public GitHub           |
| Presale addon                                                                           | Proprietary        | Private repo (Speednet) |
| Future addons (e.g. JIRA, SAP)                                                          | Proprietary / paid | Separate private repos  |

This model is identical to GitLab CE/EE[^29] and Metabase[^30] — MIT core for maximum adoption, proprietary extensions for monetization.

**Why not compose `include`:** The `include` directive has poor cross-runtime support — it has unresolved bugs in various implementations (crashes with long syntax, path resolution errors, and broken multiple includes).[^31] Instead, `render_compose()` merges addon fragments at YAML generation time, producing a single complete compose file that works reliably with `nerdctl compose` across all platforms.

## Addon Package Structure

```
~/.speedwave/addons/<addon-name>/
├── compose.addon.yml          # OCI Compose fragment (optional — only if addon has an MCP server)
├── claude-resources/
│   ├── skills/                # .md files — workflow definitions
│   ├── commands/              # Claude commands (e.g. /presale, /estimate)
│   └── agents/                # Specialized agents
└── addon.json                 # Manifest: name, version, license, dependencies
```

**addon.json manifest:**

```json
{
  "name": "presale",
  "version": "1.0.0",
  "mcp_server": true,
  "worker_env": "WORKER_PRESALE_URL",
  "port": 4006,
  "resources": ["skills", "commands", "agents"]
}
```

## How Addons Connect to Core

1. **`WORKER_<SERVICE>_URL` env var** in hub — existing mechanism from v1; if the variable is set, hub registers the service and its tools become visible to Claude; if missing, the service is invisible (zero errors)
2. **`render_compose()` merge** — for each installed addon, its `compose.addon.yml` fragment is merged into the generated compose file before writing to disk
3. **Volume mounts** — addon `claude-resources/` are mounted read-only into the claude container; `entrypoint.sh` symlinks them into `~/.claude/`

## Installation

```bash
speedwave addon install ~/Downloads/presale-1.0.0.zip
# → extracts to ~/.speedwave/addons/presale/
# → next `speedwave` run: updates compose + resource symlinks
```

Distribution: ZIP file delivered via email, Gumroad, or any storefront. No license server, no JWT verification, no online activation (YAGNI).

---

[^29]: [GitLab CE vs EE — open-core model](https://about.gitlab.com/install/ce-or-ee/)

[^30]: [Metabase open-source vs commercial](https://www.metabase.com/docs/latest/paid-features/overview)

[^31]: [nerdctl compose — known issues and compatibility](https://github.com/containerd/nerdctl/issues)
