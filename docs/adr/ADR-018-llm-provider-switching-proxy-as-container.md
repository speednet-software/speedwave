# ADR-018: LLM Provider Switching — Proxy as Container

> **Status:** Superseded by [ADR-040](ADR-040-remove-litellm-direct-provider-injection.md) (2026-04-19) — the LiteLLM `llm-proxy` container and all cloud providers were removed; only Anthropic (direct) and local providers remain.
> **Context:** Early design for running Claude Code against non-Anthropic LLMs by adding a translating proxy container.

## Decision (historical)

The original plan: when the configured LLM provider was not Anthropic, Speedwave would add an `llm-proxy` container running LiteLLM to translate the Anthropic Messages API into the target provider's API[^1]. Ollama was the exception — Claude Code would connect to it directly. This was never the shipped end state; ADR-040 removed the proxy.

## Why (historical rationale)

- Claude Code natively honours `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, sending every request to whatever endpoint implements `POST /v1/messages`[^2]. The design leveraged this without patching Claude Code.
- A proxy was thought necessary to bridge cloud providers (OpenAI, Gemini, DeepSeek, OpenRouter) whose wire formats differ from the Anthropic Messages schema.
- Ollama already implements the Anthropic-format `POST /v1/messages`[^3], so it needed no proxy even in this design.

## What actually shipped (current state)

ADR-040 deleted LiteLLM and the `llm-proxy` container. The current behaviour, implemented in `apply_llm_config_in` in `crates/speedwave-runtime/src/compose.rs`:

- Only two provider classes are accepted: `anthropic` (direct to `api.anthropic.com`) and the local family — `ollama`, `lmstudio`, `llamacpp`, `local` (the SSOT list `LOCAL_PROVIDERS` in `crates/speedwave-runtime/src/config.rs`). Any other provider hard-fails with `bail!`. Cloud providers (OpenAI, Gemini, DeepSeek, OpenRouter) are explicitly unsupported.
- For a local provider, Speedwave injects `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, and `ANTHROPIC_AUTH_TOKEN` directly into the `claude` container — there is no proxy and no per-session token. The auth token is the user's own `api_key` when present, otherwise the dummy `sk-no-key-required` (`DUMMY_TOKEN` in `crates/speedwave-runtime/src/compose/llm.rs`). A function named `generate_session_token()` does not exist; a test pins that `apply_llm_config` injects no UUID.

## Secrets management (current state)

There is no `~/.speedwave/secrets/<project>/llm.env` file and no `env_file` mechanism. Local-provider credentials live in two per-project token files under `tokens/<project>/local-llm/` — `api_key` and `custom_headers` — read by `read_local_llm_token_opt_in` in `crates/speedwave-runtime/src/compose.rs`. The `api_key` becomes the `ANTHROPIC_AUTH_TOKEN` Bearer; `custom_headers` are flattened into `ANTHROPIC_CUSTOM_HEADERS` (a defensive filter strips any `Authorization:` line so a stale token cannot collide with the Bearer).

## Security check (survives)

`SecurityCheck` still enforces the `NO_EXTERNAL_LLM_KEYS_CLAUDE` rule (Display string exactly that) — the `claude` container must carry no external LLM API keys. The forbidden-prefix list is broader than this ADR originally described: `OPENAI_`, `AZURE_OPENAI_`, `GEMINI_`, `DEEPSEEK_`, `OPENROUTER_`, `COHERE_`, `MISTRAL_`, `TOGETHER_`, `GROQ_`. See `crates/speedwave-runtime/src/compose.rs`.

## Where it lives in code

- LLM env injection + provider gate — `apply_llm_config_in` in `crates/speedwave-runtime/src/compose.rs`
- Accepted local providers (SSOT) — `LOCAL_PROVIDERS` in `crates/speedwave-runtime/src/config.rs`
- Per-project credential reader — `read_local_llm_token_opt_in` in `crates/speedwave-runtime/src/compose.rs`
- Security rule — `NO_EXTERNAL_LLM_KEYS_CLAUDE` in `crates/speedwave-runtime/src/compose.rs`
- Removal rationale — [ADR-040](ADR-040-remove-litellm-direct-provider-injection.md)

## Rejected alternatives

- Patching Claude Code to speak provider-native APIs directly — rejected because Claude Code's `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` env support already redirects every request, so no fork or patch was needed.

[^1]: LiteLLM's unified `/v1/messages` endpoint translates Anthropic-format requests to non-Anthropic providers and translates the responses back: https://docs.litellm.ai/docs/anthropic_unified/

[^2]: Claude Code environment variables, including `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`: https://code.claude.com/docs/en/env-vars

[^3]: Ollama's Anthropic Messages API compatibility, exposing `POST /v1/messages`: https://docs.ollama.com/api/anthropic-compatibility
