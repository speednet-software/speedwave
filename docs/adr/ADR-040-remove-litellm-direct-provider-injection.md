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

| Provider    | Min. Version | Default base URL                    |
| ----------- | ------------ | ----------------------------------- |
| `anthropic` | —            | Direct Anthropic API (no injection) |
| `ollama`    | 0.14.0       | `http://host.docker.internal:11434` |
| `lmstudio`  | 0.4.1        | `http://host.docker.internal:1234`  |
| `llamacpp`  | Jan 2026     | `http://host.docker.internal:8080`  |

All local providers use `host.docker.internal` which is mapped to the host gateway via `extra_hosts` in `compose.template.yml`. This works identically on macOS (Lima), Linux (nerdctl rootless), and Windows (WSL2).

## Environment Variables Injected

When a local provider is selected, the following env vars are set on the `claude` container:

| Variable                                    | Value                                                |
| ------------------------------------------- | ---------------------------------------------------- |
| `ANTHROPIC_BASE_URL`                        | Provider URL (no `/v1` suffix)                       |
| `ANTHROPIC_AUTH_TOKEN`                      | `sk-no-key-required` (dummy)[^8]                     |
| `ANTHROPIC_CUSTOM_MODEL_OPTION`             | User-configured model name[^9]                       |
| `ANTHROPIC_CUSTOM_MODEL_OPTION_NAME`        | `<model> (<Provider Label>)` for the `/model` picker |
| `ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION` | `Local model served by <Provider Label>`             |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`  | `1` (disables model validation)[^5]                  |
| `CLAUDE_CODE_ATTRIBUTION_HEADER`            | `0` (prevents 90% KV cache slowdown)[^6]             |

For `anthropic` provider, no injection occurs — Claude Code connects directly to `api.anthropic.com`.

`ANTHROPIC_CUSTOM_MODEL_OPTION` is preferred over `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL`: the latter silently remaps the built-in Sonnet/Opus/Haiku aliases to the same local model, leaving the `/model` picker showing three misleading Anthropic names. The former adds a single explicit, validation-skipped entry (e.g. `llama3.3 (Ollama)`) so the user sees exactly what is running.[^9]

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

When a local provider is active, `resolve_project_config` appends three flags to the Claude Code command:

- `--system-prompt-file /speedwave/resources/system-prompts/local-llm.md` — replaces Claude Code's default system prompt with a compact, local-LLM-optimised variant. The default prompt is Anthropic-centric and verbose; small-context local models benefit from a shorter, model-agnostic prompt.
- `--model <user_model>` — pins the user-configured model name as the default in Claude Code's `/model` picker, so the session starts with the correct local model selected rather than the Anthropic default.
- `--append-system-prompt <identity>` — runtime-built identity payload from `prompts::local_llm_identity(model, provider)` (`crates/speedwave-runtime/src/prompts.rs`). The base `local-llm.md` cannot bake in a runtime-resolved model id; this append closes the loop so an "what model are you?" question gets a concrete answer (`"I am \`qwen3:35b\` hosted by Ollama"`) instead of the generic disclaimer baked into the file. The wording is hard-coded with explicit anti-suffix and anti-followup rules because small local models otherwise fold under follow-up pressure ("are you sure?", "really?") or hallucinate `-AWQ`/`-instruct` suffixes that aren't in the actual model id.

None of these flags is injected for the `anthropic` provider — the system prompt and identity stay at Claude Code's defaults. See ADR-041[^10] for the model discovery flow that populates `<user_model>`.

### Identity prompt injection — security

Both `claude.llm.model` and `claude.llm.provider` reach `local_llm_identity` from layered config (defaults → repo `.speedwave.json` → user `~/.speedwave/config.json`). A malicious `.speedwave.json` committed by an untrusted collaborator could otherwise inject newlines / quotes into the identity payload to override Claude Code's system rules. Two-layer mitigation:

1. `local_llm_identity` returns `Option<String>` — `None` for any model name containing characters outside `[A-Za-z0-9._:/+-]`, leading dashes, empty strings, or values longer than 128 chars. The resolver skips `--append-system-prompt` entirely in that case.
2. `containers_cmd::update_llm_config` rejects model names starting with `-` (CLI flag collision guard) at save time so the broken value never persists.

The Anthropic provider is exempt at the outer-layer — the `is_local_provider(...)` guard in `resolve_project_config` skips the entire local-flag block for it.

## Authentication Bypass for Local Providers

`check_claude_auth` normally verifies that a valid Anthropic OAuth token is present before allowing a session to start. For local providers (`ollama`, `lmstudio`, `llamacpp`), this check short-circuits to `Ok(true)` — no Anthropic account or API key is required.

This is safe because local providers use a dummy `ANTHROPIC_AUTH_TOKEN` (`sk-no-key-required`[^8]) and route all traffic to `host.docker.internal`; no Anthropic API call is made. Requiring a real token would block users who are running entirely on local hardware with no Anthropic subscription.

## Rollback

To restore LiteLLM support:

1. Revert this commit
2. The LiteLLM image (`ghcr.io/berriai/litellm:latest`) may still be on disk — prune with `nerdctl image prune` if needed

Note: the stale llm-proxy container (if any) is automatically removed by `--remove-orphans` on next `compose up`.

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
