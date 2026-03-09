# ADR-018: LLM Provider Switching — Proxy as Container

## Decision

When the LLM provider is not Anthropic, Speedwave adds an `llm-proxy` container (LiteLLM) that translates the Anthropic Messages API to the target provider's API. For Ollama, no proxy is needed — Claude Code connects directly.

## Rationale

Claude Code natively supports `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` — it sends all requests to whatever endpoint implements the Anthropic Messages API (`POST /v1/messages`). Speedwave leverages this without patching Claude Code.

## Architecture

```
When provider = anthropic (default):
  Claude Code → api.anthropic.com (direct, no proxy, zero overhead)

When provider != anthropic (e.g. openai, gemini, deepseek):
  Claude Code → ANTHROPIC_BASE_URL=http://llm-proxy:4009 → LiteLLM container → external provider

When provider = ollama:
  Claude Code → ANTHROPIC_BASE_URL=http://host:11434/v1 → Ollama (direct, no proxy)
```

**LiteLLM**[^39] is chosen as the proxy — MIT-licensed, 36k+ GitHub stars, supports 100+ providers, and has an official Docker image (`ghcr.io/berriai/litellm`).

**Ollama exception:** Ollama natively implements `POST /v1/messages` in Anthropic format since version 0.14.0.[^40] No proxy is needed — Claude Code connects directly to Ollama via `ANTHROPIC_BASE_URL`.

## Secrets Management

API keys for external LLM providers are stored in:

```
~/.speedwave/secrets/<project>/llm.env   # chmod 600, never committed
```

`render_compose()` adds this file as `env_file` in the `llm-proxy` container section. The claude container **never sees** external LLM API keys — it only sees `ANTHROPIC_BASE_URL` (internal proxy address) and `ANTHROPIC_AUTH_TOKEN` (random per-session UUID v4).

## Supported Providers

| Provider     | Config                            | Proxy Needed                                  | Example Model      |
| ------------ | --------------------------------- | --------------------------------------------- | ------------------ |
| `anthropic`  | default, no config                | No                                            | claude-sonnet-4-6  |
| `openai`     | `api_key_env: OPENAI_API_KEY`     | Yes (LiteLLM)                                 | gpt-4o, o3         |
| `gemini`     | `api_key_env: GEMINI_API_KEY`     | Yes (LiteLLM)                                 | gemini-2.0-flash   |
| `deepseek`   | `api_key_env: DEEPSEEK_API_KEY`   | Yes (LiteLLM)                                 | deepseek-chat      |
| `openrouter` | `api_key_env: OPENROUTER_API_KEY` | Yes (LiteLLM)                                 | any via OpenRouter |
| `ollama`     | `base_url: http://host:11434`     | No (native `/v1/messages` since v0.14.0)[^40] | llama3.3, qwen2.5  |
| `lmstudio`   | `base_url: http://host:1234`      | Yes (LiteLLM)                                 | local model        |

## Security

- External LLM API keys exist only in `llm.env` (chmod 600), loaded only by the proxy container
- Claude container sees only `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` (internal proxy token) — no external keys
- Proxy container uses the same OWASP hardening as all other containers (cap_drop: ALL, no-new-privileges, read_only)
- Proxy token is a random UUID v4 generated per session (`generate_session_token()`) — prevents unauthorized containers from using the proxy
- `SecurityCheck::run()` verifies: claude container has no `*OPENAI*`, `*GEMINI*`, `*DEEPSEEK*`, or `*OPENROUTER*` environment variables (rule: `NO_EXTERNAL_LLM_KEYS_CLAUDE`)

---

[^39]: [LiteLLM — Call 100+ LLMs using the same Input/Output Format](https://github.com/BerriAI/litellm)

[^40]: [Anthropic compatibility — Ollama](https://docs.ollama.com/api/anthropic-compatibility)
