# ADR-011: User Configuration Passed to Claude Code

## Decision

Users can configure per-project environment variables and LLM provider via `~/.speedwave/config.json`. These are injected into the Claude Code process at startup.

## Rationale

Different projects require different Claude Code settings (model selection, custom environment variables, alternative LLM providers). Exposing this as simple JSON in the project config allows both CLI and Desktop users to configure Claude Code without editing internal files.

## Config Structure

### User config (`~/.speedwave/config.json`)

```json
{
  "projects": [
    {
      "name": "acme-corp",
      "dir": "/Users/user/projects/acme-corp",
      "claude": {
        "env": {
          "ANTHROPIC_MODEL": "claude-opus-4-6",
          "CUSTOM_VAR": "value"
        },
        "llm": {
          "provider": "anthropic"
        }
      }
    }
  ],
  "active_project": "acme-corp",
  "selected_ide": {
    "ide_name": "VS Code",
    "port": 52698
  }
}
```

### Repo config (`<project>/.speedwave.json`, optional)

```json
{
  "claude": {
    "env": {
      "ANTHROPIC_MODEL": "claude-sonnet-4-6"
    },
    "llm": {
      "provider": "ollama",
      "model": "llama3.3",
      "base_url": "http://host.docker.internal:11434"
    }
  }
}
```

### Fields

#### Per-project Claude overrides (`claude.*`)

| Field                       | Rust type                         | Description                                                                                                                                                                                                                                                 |
| --------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude.env`                | `Option<HashMap<String, String>>` | Environment variables injected into the Claude Code process[^1]                                                                                                                                                                                             |
| `claude.llm`                | `Option<LlmConfig>`               | Local LLM provider configuration — see ADR-040                                                                                                                                                                                                              |
| `claude.llm.provider`       | `Option<String>`                  | `anthropic` (default), `ollama`, `lmstudio`, `llamacpp`                                                                                                                                                                                                     |
| `claude.llm.model`          | `Option<String>`                  | Model id. For local providers passed via `--model`. For `anthropic` also injected as `ANTHROPIC_MODEL` (compose layer; `claude.env.ANTHROPIC_MODEL` still wins on conflict). Sanitised before embedding in the local-LLM identity prompt — see ADR-040.     |
| `claude.llm.base_url`       | `Option<String>`                  | Optional; overrides the provider default port. **Not accepted from repo config** — only from user config (SSRF prevention, ADR-040).                                                                                                                        |
| `claude.llm.context_tokens` | `Option<u32>`                     | Persisted context window in tokens — populated by Settings (Anthropic SSOT lookup or local discovery probe). Consumed by the chat footer's `used / max` ratio before any stream-level value lands. Zero is rejected at save time. See ADR-041 for sourcing. |

#### Global config fields

| Field            | Rust type             | Description                                                     |
| ---------------- | --------------------- | --------------------------------------------------------------- |
| `active_project` | `Option<String>`      | Name of the currently active project (Desktop project switcher) |
| `selected_ide`   | `Option<SelectedIde>` | Persisted IDE Bridge upstream — see ADR-007                     |

### `claude.settings` — not yet implemented

The `ClaudeOverrides` struct accepts a `settings: Option<serde_json::Value>` field[^2], but `resolve_claude_config()` does not propagate it to `ResolvedClaudeConfig`. The field is parsed and silently dropped. This is a known gap — if needed, the resolver must be extended to pass `settings` through to the Claude process.

## Default Flags

`resolve_claude_config()` always includes these CLI flags for the Claude Code process (`defaults::DEFAULT_FLAGS`)[^1]:

| Flag                             | Purpose                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dangerously-skip-permissions` | Safe in this context: Claude runs in an isolated container with `cap_drop: ALL`, read-only filesystem, unprivileged user, zero tokens, and isolated network — see ADR-009 |
| `--mcp-config <path>`            | Points Claude Code to the generated MCP hub config (`/home/speedwave/.claude/mcp-config.json`, created by `entrypoint.sh`)                                                |
| `--strict-mcp-config`            | Ignores any `.mcp.json` in the workspace — only the generated config is used                                                                                              |

## Config Resolution

Three-level merge with last-writer-wins per key:

1. **Defaults** (`speedwave-runtime/src/defaults.rs`) — telemetry disabled, autoupdater disabled, sandbox flag enabled[^3]
2. **Repo config** (`.speedwave.json` in project root) — shared across team members via git
3. **User config** (`~/.speedwave/config.json`) — personal overrides, highest priority

```
defaults → repo .speedwave.json → user ~/.speedwave/config.json
                                        (wins)
```

Resolution logic: `resolve_claude_config()` in `crates/speedwave-runtime/src/config.rs`[^4]. Environment variables are merged with `HashMap::insert` (last-writer-wins). LLM config fields are merged individually — only non-`None` values from the overlay replace base values.

---

[^1]: [Claude Code CLI reference — environment variables and flags](https://docs.anthropic.com/en/docs/claude-code/cli-usage)

[^2]: `serde_json::Value` allows arbitrary JSON — see [serde_json::Value docs](https://docs.rs/serde_json/latest/serde_json/enum.Value.html)

[^3]: As of fix #301, `ANTHROPIC_MODEL` is no longer set by `defaults::base_env()`. Users who want a specific Claude model can populate it from one of two paths: (a) `claude.env.ANTHROPIC_MODEL` in `.speedwave.json` or `~/.speedwave/config.json` (the v1 path; works for any provider), or (b) `claude.llm.model` for the `anthropic` provider, which the runtime injects into `ANTHROPIC_MODEL` at compose-render time. When both are set, `claude.llm.model` wins: `compose::render_compose` calls `inject_claude_env(...)` for `claude.env` first, then `apply_llm_config(...)` runs `inject_claude_env` again with the LLM-derived value, and the second write replaces the first by key. Whitespace/empty values fall through to Claude Code's built-in default.

[^4]: Config merge implementation — `crates/speedwave-runtime/src/config.rs:55-86`
