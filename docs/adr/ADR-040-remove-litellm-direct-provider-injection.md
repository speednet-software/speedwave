# ADR-040: Remove LiteLLM — Direct Local Provider Injection

**Status:** Accepted
**Date:** 2026-04-19

## Context

Speedwave previously used LiteLLM (`ghcr.io/berriai/litellm:latest`) as a proxy container to route Claude Code's Anthropic API calls to external LLM providers. In March 2026, LiteLLM was found to contain a backdoor injected through the `libpostal` supply chain — a poisoned security scanner that granted remote access to the LiteLLM codebase.[^1][^7]

At the same time, the three most popular local LLM servers added native support for the Anthropic `/v1/messages` protocol:

- **Ollama 0.14.0+** — native Anthropic compatibility[^2]
- **LM Studio 0.4.1+** — Anthropic-compatible `/v1/messages` endpoint[^3]
- **llama.cpp (January 2026, PR #17570)** — Anthropic Messages API support[^4]

This makes LiteLLM unnecessary for the Speedwave use case: local models only.

## Decision

Remove LiteLLM entirely. Inject `ANTHROPIC_BASE_URL` and related env vars directly into the `claude` container. Support three local providers with well-known defaults.

**Cloud providers (OpenAI, Gemini, DeepSeek, OpenRouter) are not supported.** Speedwave is a local-first platform. External LLM API keys must never enter containers — this is a security invariant.

## Supported Providers

| Provider    | Default base URL                    | Notes                                                    |
| ----------- | ----------------------------------- | -------------------------------------------------------- |
| `anthropic` | Direct Anthropic API (no injection) | Default                                                  |
| `local`     | `http://host.docker.internal:11434` | Any server speaking Anthropic Messages on `/v1/messages` |

The `local` provider supersedes the original `ollama`/`lmstudio`/`llamacpp` triplet — see [ADR-041 §"Dialect autodetect"](ADR-041-local-llm-model-discovery.md) for the unified discovery path. Legacy provider names are accepted on read for **two release cycles** (auto-migrated to `local` on first Save in Settings); planned removal in v0.X+2.

Compatible local servers (non-exhaustive): Ollama 0.14+, LM Studio 0.4.1+, llama.cpp PR #17570 (Jan 2026+), Unsloth, vLLM (2026+), LiteLLM via the `/anthropic` route. Pure OpenAI Chat Completions servers (vLLM stock, TGI, Triton) do **not** work — Claude Code requires `POST /v1/messages`, not `/v1/chat/completions`. The discovery probe sanity-checks `/v1/messages` and surfaces a warning in Settings when it's missing.

All local URLs use `host.docker.internal` which is mapped to the host gateway via `extra_hosts` in `compose.template.yml`. Single-segment path prefixes (e.g. `/anthropic` for LiteLLM, `/v1` for AWS-style gateways) are accepted; multi-segment paths and query/fragment are rejected.

## Environment Variables Injected

When a local provider is selected, the following env vars are set on the `claude` container:

| Variable                                    | Value                                                  |
| ------------------------------------------- | ------------------------------------------------------ |
| `ANTHROPIC_BASE_URL`                        | Provider URL (single-segment path prefix accepted)     |
| `ANTHROPIC_AUTH_TOKEN`                      | User-supplied Bearer or `sk-no-key-required` dummy[^8] |
| `ANTHROPIC_CUSTOM_HEADERS`                  | Multi-line `Name: Value` (when configured)             |
| `ANTHROPIC_MODEL`                           | User-configured model name (active model)[^9]          |
| `ANTHROPIC_CUSTOM_MODEL_OPTION`             | User-configured model name (picker entry)[^9]          |
| `ANTHROPIC_CUSTOM_MODEL_OPTION_NAME`        | `<model> (<Provider Label>)` for the `/model` picker   |
| `ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION` | `Local model served by <Provider Label>`               |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`  | `1` (disables model validation)[^5]                    |
| `CLAUDE_CODE_ATTRIBUTION_HEADER`            | `0` (prevents 90% KV cache slowdown)[^6]               |

For `anthropic` provider, no injection occurs — Claude Code connects directly to `api.anthropic.com`.

`ANTHROPIC_MODEL` is the **primary mechanism** Claude Code uses to identify the active model — it drives `/status`, the statusline display, and the `/model` picker selection at startup.[^9] Without it, Claude Code falls back to the account-tier default (Haiku/Sonnet) regardless of where `ANTHROPIC_BASE_URL` points; the local model is reachable but the UI claims a different name.

`ANTHROPIC_CUSTOM_MODEL_OPTION` is **supplementary**: it adds a single validation-skipped entry to the `/model` picker (e.g. `llama3.3 (Ollama)`) so the user sees a friendly label even when the local server's `/v1/models` discovery doesn't return a usable name. The `_NAME` and `_DESCRIPTION` companions only take effect when `ANTHROPIC_BASE_URL` points to an LLM-gateway-like endpoint, which is exactly our local-provider case.[^9]

`ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` is **not** used: those silently remap the built-in Sonnet/Opus/Haiku aliases to the same local model, leaving the `/model` picker showing three misleading Anthropic names.

## API key + custom headers for local servers

Many local servers require authentication: vLLM `--api-key`, LM Studio with "Require Authentication" enabled, llama.cpp `--api-key`, LiteLLM `LITELLM_MASTER_KEY`, corporate gateways. Some additionally require non-`Authorization` headers (Azure APIM's `Ocp-Apim-Subscription-Key`, tenant routing headers).

**Storage.** Both credentials live in per-project token files outside the config:

- `~/.speedwave/tokens/<project>/local-llm/api_key` — Bearer token
- `~/.speedwave/tokens/<project>/local-llm/custom_headers` — newline-separated `Name: Value`

Files are owner-only (Unix 0o600 + 0o700 dirs via `chmod`; Windows ACL via `icacls /inheritance:r`). Writes are atomic (`.tmp + rename`) so a crash never leaves a truncated secret. Validation happens before write: api_key strips a leading `Bearer ` prefix and rejects CRLF; custom_headers rejects `Authorization`, `Cookie`, `Host`, `Content-Length`, `Transfer-Encoding`, and any value containing `\r` (HTTP request-smuggling defense).

Only the presence flags `has_api_key` / `has_custom_headers` land in `config.json`; the values stay on disk. The frontend's Settings UI uses a touched-flag pattern to distinguish "leave unchanged" (field omitted in the JSON), "delete" (field = `null`), and "write/replace" (field = string).

**At compose render time** `apply_llm_config` reads the files and injects their contents as `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_CUSTOM_HEADERS` env vars. Missing or unreadable files fall back to the dummy + a warn log (the log_sanitizer redacts any leaked value via the bare `sk-` regex).

### Threat model — env vs file mount

This is **deliberately different from the plugin token regime** (`~/.speedwave/tokens/<project>/<service>/` mounted `:ro` into the worker container). Plugin tokens never enter the `claude` container; LLM credentials must, because Claude Code reads `ANTHROPIC_AUTH_TOKEN` from its environment.

Consequences:

- The rendered `compose.yml` contains the secret. We chmod it to 0o600 on Unix (boy-scout extension — every compose file is now 0o600, not only those carrying LLM keys). Atomic via `fs_perms::write_restricted_file_atomic`.
- Windows polls **NTFS user-profile DACL** for the compose file (no per-file ACL hardening). User-profile path is private to the OS user by default; admin-installed malware has access. Accepted limitation — documenting here is the mitigation.
- Inside the `claude` container the secret is visible in `/proc/<pid>/environ`. The container runs as a single non-root user (UID 1000:1000); Claude Code is the only process. Accepted residual risk.

This is **not** "identical regime to plugin tokens." It is a separate, documented model justified by the fact that Claude Code reads from env vars (no file-convention path supported).

## Protocol scope

Speedwave supports servers that implement Anthropic Messages on `POST /v1/messages`. Pure OpenAI Chat Completions servers are out of scope: re-introducing a translation proxy would resurrect the LiteLLM-shaped attack surface this ADR removed in the first place. Users wanting OpenAI-only servers can run their own translation proxy (e.g. LiteLLM, but **not** as a Speedwave component) and point Speedwave at it.

The discovery probe sanity-checks `/v1/messages` with a minimal 1-token POST and surfaces a yellow banner in Settings when it returns 404/405. The probe cost on a real local server is negligible (1 token on a local GPU); the UI discloses this under the Discover button.

## Architecture

```
Before (LiteLLM):
  claude → llm-proxy (LiteLLM) → external API (OpenAI, etc.)

After (direct injection):
  claude → host.docker.internal:PORT → local LLM server (Ollama, LM Studio, llama.cpp)
  claude → api.anthropic.com (Anthropic provider, no change)
```

## Security — Threat Model Delta

**Removed attack surface:**

- LiteLLM container (~52 MB image, ~512 MB RAM, ~4000 lines Python, supply chain risk)
- 1 exposed port (llm-proxy)
- `~/.speedwave/secrets/<project>/llm.env` file with LLM API credentials

**Added:**

- `ANTHROPIC_BASE_URL` pointing to a user-configured address (local LLM server or another machine on the network)

The `claude` container already had network access (MCP workers connect to external APIs). No new egress capability is introduced. `validate_base_url()` enforces:

- Scheme: only `http://` or `https://`
- No credentials in URL
- No path, query, or fragment (only scheme + host + port)

Arbitrary host is allowed — the security boundary is that the container cannot reach the host filesystem, and credentials are never injected into `claude`.

### SSRF Prevention (repo config)

A malicious `.speedwave.json` in a cloned repository could previously set `provider` and `base_url` to redirect Claude Code to an attacker-controlled server. As of this ADR, `merge_llm_repo()` ignores `provider` and `base_url` from repo config — only `model` is merged. Only the user's `~/.speedwave/config.json` may set the provider and base URL.

## CLI Flag Injection for Local Providers

`resolve_project_config` does **not** inject any provider-specific CLI flags. Model selection, routing, and auth are configured entirely through env vars (see the table above) injected by `compose::apply_llm_config`. `ANTHROPIC_MODEL` supersedes a CLI `--model` flag for the active-model role and persists across the session without being attached to the launch command. See ADR-041[^10] for the model discovery flow that populates the user's model choice.

The default Claude Code system prompt is preserved for local providers. Modern local LLM servers ship with 32K–128K context windows[^11] that absorb the baseline prompt + tool definitions without hurting tool-use quality, and preserving the default lets `outputStyle` from `settings.json` reach local LLMs the same way it reaches Anthropic-hosted models.

## Authentication Bypass for Local Providers

`check_claude_auth` normally verifies that a valid Anthropic OAuth token is present before allowing a session to start. For local providers (`ollama`, `lmstudio`, `llamacpp`), this check short-circuits to `Ok(true)` — no Anthropic account or API key is required.

This is safe because local providers use a dummy `ANTHROPIC_AUTH_TOKEN` (`sk-no-key-required`[^8]) and route all traffic to `host.docker.internal`; no Anthropic API call is made. Requiring a real token would block users who are running entirely on local hardware with no Anthropic subscription.

## Rollback

To restore LiteLLM support:

1. Revert this commit
2. The LiteLLM image (`ghcr.io/berriai/litellm:latest`) may still be on disk — prune with `nerdctl image prune` if needed

Note: the stale llm-proxy container (if any) is automatically removed by `--remove-orphans` on next `compose up`.

### Downgrade (after `provider="local"`)

A user who has saved `provider="local"` in `~/.speedwave/config.json` and then downgrades to a release that predates this change will see a **hard error**: the old binary's `apply_llm_config` arm doesn't know `"local"` and returns `bail!("Unsupported LLM provider 'local'")`. Speedwave will not start the project.

Recovery requires manual edit of `config.json`: change `"provider": "local"` to one of the legacy names (`"ollama"`, `"lmstudio"`, `"llamacpp"`) that the old binary recognises. The stored credentials in `~/.speedwave/tokens/<project>/local-llm/` are ignored by the old binary (the schema doesn't carry `has_api_key`/`has_custom_headers` flags before this change) — they remain on disk as inert files.

## Footnotes

[^1]: LiteLLM supply chain compromise (March 2026): https://snyk.io/blog/poisoned-security-scanner-backdooring-litellm/

[^2]: Ollama Anthropic compatibility (requires 0.14.0+): https://docs.ollama.com/api/anthropic-compatibility

[^3]: LM Studio Anthropic endpoint (requires 0.4.1+): https://lmstudio.ai/docs/developer/anthropic-compat

[^4]: llama.cpp Anthropic Messages API (PR #17570, January 2026): https://huggingface.co/blog/ggml-org/anthropic-messages-api-in-llamacpp

[^5]: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` disables model validation traffic: https://unsloth.ai/docs/basics/claude-code

[^6]: `CLAUDE_CODE_ATTRIBUTION_HEADER=0` prevents 90% KV cache slowdown: https://unsloth.ai/docs/basics/claude-code

[^7]: Trend Micro analysis of LiteLLM compromise: https://www.trendmicro.com/en_us/research/26/c/inside-litellm-supply-chain-compromise.html

[^8]: Dummy auth token usage for local OpenAI-compatible endpoints documented at: https://docs.vllm.ai/en/stable/serving/integrations/claude_code/

[^9]: `ANTHROPIC_CUSTOM_MODEL_OPTION` (with `_NAME`, `_DESCRIPTION`, `_SUPPORTED_CAPABILITIES` suffixes) adds a single entry to the `/model` picker and skips validation of the model ID: https://code.claude.com/docs/en/model-config

[^10]: ADR-041: Local LLM Model Discovery and SSRF Policy — `docs/adr/ADR-041-local-llm-model-discovery.md`

[^11]: Representative 1M context: Llama 3.1 (128K) — https://ai.meta.com/blog/meta-llama-3-1/ ; Qwen2.5 family default 32K with 128K via YaRN — https://qwenlm.github.io/blog/qwen2.5/ ; DeepSeek-V3 128K — https://github.com/deepseek-ai/DeepSeek-V3
