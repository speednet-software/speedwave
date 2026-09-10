# ADR-011: User Configuration Passed to Claude Code

> **Status:** Accepted
> **Context:** Different projects need different Claude Code settings (model, custom env vars, alternative LLM provider) without editing internal files.

> **Amendment (2026-09-02):** The env key carrying `claude.llm.model` on the Anthropic path changed from `ANTHROPIC_MODEL` to `ANTHROPIC_DEFAULT_MODEL`; the field descriptions below are corrected in place. Rationale and the binary verification behind it: ADR-073, amendment of the same date.

## Decision

Users configure per-project environment variables and an LLM provider via `~/.speedwave/config.json` (personal) and an optional `<project>/.speedwave.json` (team, committed to git). These are resolved through a three-level merge and injected into the Claude Code process at startup. Both CLI and Desktop read the same resolution path.

## Why

- Plain JSON config keeps Claude Code tunable for both CLI and Desktop users without touching internal files.
- Splitting repo config (shared via git) from user config (personal, highest priority) lets a team ship a default model while individuals override locally.
- SSRF prevention: `provider` and `base_url` are accepted only from user config, never from repo `.speedwave.json` (see ADR-040).

## Config shape

The two files carry a `claude` block with these fields (the `ClaudeOverrides` / `LlmConfig` structs in `config.rs`):

- `claude.env` — `Option<HashMap<String,String>>`, env vars injected into the Claude Code process.
- `claude.llm.provider` — `anthropic` (default), `ollama`, `lmstudio`, `llamacpp`. Repo config cannot set it.
- `claude.llm.model` — model id, injected at compose-render time by `compose::apply_llm_config_in` (no `--model` CLI flag is added). On the Anthropic path it becomes `ANTHROPIC_DEFAULT_MODEL`, the model new sessions start on, which a `/model` pick persisted in the container's `settings.json` outranks; routed providers (local, OpenRouter) get `ANTHROPIC_MODEL=<provider_id>/<model>`, which outranks a persisted pick. Either key, when set, overwrites the same key from `claude.env`. Repo config may suggest only `model`.
- `claude.llm.base_url` — overrides the provider default; user config only (SSRF, ADR-040).
- `claude.llm.context_tokens` — persisted context window in tokens, used by the chat footer's `used / max` ratio; zero is rejected at save time (sourcing in ADR-041).

Global (top-level) fields: `active_project` (Desktop project switcher) and `selected_ide` (persisted IDE Bridge upstream — ADR-007).

Neither model key is set by defaults. `claude.env.ANTHROPIC_MODEL` stays the user's explicit hard pin for any provider (it outranks a persisted `/model` pick); `claude.llm.model` is the Settings-level default described above. Both are written after `claude.env` during compose render and win by key.

## Default flags

`resolve_project_config()` always attaches `defaults::DEFAULT_FLAGS` to the Claude Code process. The constant holds four flags across six slice entries (two flags — `--mcp-config` and `--thinking-display` — each carry a value argument):

- `--dangerously-skip-permissions` — safe here because Claude runs in an isolated container with `cap_drop: ALL`, read-only filesystem, unprivileged UID 1000, zero tokens, and an isolated per-project network (see ADR-009). `IS_SANDBOX=1` in `base_env()` pre-empts the root-user gate[^1].
- `--mcp-config <path>` — points Claude Code at the generated MCP hub config (`MCP_CONFIG_PATH` = `/home/speedwave/.claude/mcp-config.json`, created by `containers/entrypoint.sh`)[^2].
- `--strict-mcp-config` — ignores any `.mcp.json` in the workspace; only the generated config is used[^3].
- `--thinking-display summarized` — forces thinking content to be returned in populated text form instead of empty signature-only blocks, so the chat UI sees the model's reasoning (unverified).

## Config resolution

Three-level merge, last-writer-wins per key:

1. Defaults — telemetry disabled, autoupdater disabled, sandbox flag enabled (`defaults::base_env()`).
2. Repo `.speedwave.json` — shared via git; `provider`/`base_url` ignored.
3. User `~/.speedwave/config.json` — personal, highest priority.

The merge runs in `resolve_project_config()` (public entry point `resolve_claude_config()` returns its `.0`). Env vars merge via `merge_env` (`HashMap::insert`, last writer wins). LLM fields merge per-field, replacing only non-`None` overlay values: `merge_llm` for user config, `merge_llm_repo` for repo config (the latter accepts only `model`).

## Known gap

`ClaudeOverrides` accepts a `settings: Option<serde_json::Value>` field, but the resolver does not propagate it into `ResolvedClaudeConfig` (which carries only `env`, `flags`, `llm`). The field is parsed and silently dropped; if needed, the resolver must be extended to pass it through.

## Where it lives in code

- Config structs — `crates/speedwave-runtime/src/config.rs` (`LlmConfig`, `ClaudeOverrides`, `ResolvedClaudeConfig`).
- Resolution / merge — `resolve_project_config`, `resolve_claude_config`, `merge_env`, `merge_llm`, `merge_llm_repo` in `crates/speedwave-runtime/src/config.rs`.
- Defaults, default flags, MCP config path — `crates/speedwave-runtime/src/defaults.rs` (`base_env`, `DEFAULT_FLAGS`, `MCP_CONFIG_PATH`).
- MCP config generation — `containers/entrypoint.sh`.

[^1]: Claude Code refuses `--dangerously-skip-permissions` when running as root/sudo unless `IS_SANDBOX=1` (or `CLAUDE_CODE_BUBBLEWRAP=1`) signals a sandboxed environment: https://github.com/anthropics/claude-code/issues/58150

[^2]: `--mcp-config` loads MCP servers from a JSON file or string, per the official CLI reference: https://code.claude.com/docs/en/cli-reference

[^3]: `--strict-mcp-config` restricts Claude Code to only the MCP servers supplied via `--mcp-config`, ignoring other MCP configuration sources, per the official CLI reference: https://code.claude.com/docs/en/cli-reference
