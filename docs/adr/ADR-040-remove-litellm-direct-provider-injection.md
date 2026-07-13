# ADR-040: Remove LiteLLM — Direct Local Provider Injection

> **Status:** Superseded in part by [ADR-073](ADR-073-embedded-per-project-speedwave-proxy.md) — the "no proxy" decision is reversed under a hardened threat model (pinned hashes, local build, no management plane, per-project network); the credential-handling, SSRF, and repo-config rules of this ADR remain in force. The direct-injection path survives behind the `llm.proxy_enabled` kill-switch until N+2.
> **Context:** A LiteLLM supply-chain compromise (March 2026)[^1] plus native Anthropic Messages support in local LLM servers made the LiteLLM proxy container an unnecessary attack surface.

## Decision

Remove the LiteLLM proxy container entirely. When a local LLM provider is selected, inject `ANTHROPIC_BASE_URL` and related env vars directly into the `claude` container so Claude Code talks to a local server speaking the Anthropic Messages protocol (`POST /v1/messages`). Cloud providers (OpenAI, Gemini, DeepSeek, OpenRouter) are deliberately unsupported — external LLM API keys must never enter containers.

## Why

- LiteLLM was found to ship a backdoor via a poisoned dependency (compromised maintainer PyPI credentials, versions 1.82.7/1.82.8)[^1]; a `:latest` proxy image is a recurring supply-chain risk.
- Local servers (Ollama 0.14+[^2], LM Studio 0.4.1+[^3], llama.cpp PR #17570[^4], vLLM[^5], Unsloth[^6]) now speak Anthropic Messages natively, so the translation proxy is no longer needed for the local-first use case.
- Re-introducing an OpenAI Chat Completions translation layer would resurrect exactly the attack surface this ADR removed. Pure `/v1/chat/completions` servers are out of scope; users who need one run their own proxy and point Speedwave at it.

## What is configured

- Two providers: `anthropic` (default — no injection, connects to `api.anthropic.com`) and `local` (any server speaking Anthropic Messages, default `http://host.docker.internal:11434`). The `local` provider supersedes the original `ollama`/`lmstudio`/`llamacpp` triplet; legacy names are still accepted on read and auto-migrated to `local` on the next Save.
- For a local provider the injected env vars include `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (user Bearer or the `sk-no-key-required` dummy), `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_MODEL` (the primary signal Claude Code uses for `/status`, statusline, and `/model` picker selection), the `ANTHROPIC_CUSTOM_MODEL_OPTION` family (friendly picker label), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and `CLAUDE_CODE_ATTRIBUTION_HEADER=0`.
- `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` is intentionally not used — it would silently remap built-in aliases and leave three misleading Anthropic names in the picker.
- No provider-specific CLI flags are injected — model, routing, and auth flow entirely through env vars, and the default Claude Code system prompt is preserved.

## Credentials for local servers

- The Bearer token lives at `~/.speedwave/tokens/<project>/local-llm/api_key` and custom headers at `~/.speedwave/tokens/<project>/local-llm/custom_headers` (newline-separated `Name: Value`), both outside `config.json`. Only `has_api_key` / `has_custom_headers` presence flags land in config.
- Files are owner-only and written atomically (write to a sibling tempfile, then rename) so a crash never leaves a truncated secret. Validation runs before write: `api_key` strips a leading `Bearer ` and rejects CRLF; `custom_headers` rejects `Authorization`, `Cookie`, `Host`, `Content-Length`, `Transfer-Encoding`, and any value containing a carriage return (request-smuggling defense).
- At compose-render time the files are read and injected as `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_CUSTOM_HEADERS`. Missing or unreadable files fall back to the dummy token with a warn log (the sanitizer redacts any leaked `sk-` value).

## Threat model

- This is deliberately different from the plugin token regime (worker tokens mounted `:ro`, never entering the `claude` container). LLM credentials must enter `claude` because Claude Code reads `ANTHROPIC_AUTH_TOKEN` from its environment — there is no file-convention path it would read instead.
- Consequence: the rendered `compose.yml` contains the secret. Every compose file is therefore written owner-only and atomically. On Unix that means `chmod 0o600`; on Windows the same write path applies a per-file ACL (`icacls /inheritance:r /grant:r <user>:(F)`) to the tempfile **before** the atomic rename, so the destination never appears with the inherited DACL — an `icacls` failure aborts the write rather than leaving a world-readable secret.
- Inside the `claude` container the secret is visible in `/proc/<pid>/environ`. The container runs as a single non-root user (UID 1000:1000) with Claude Code as the only process — accepted residual risk.
- A malicious `.speedwave.json` in a cloned repo cannot redirect Claude Code: the repo-config merge only honors `model`; `provider` and `base_url` are taken solely from the user's `~/.speedwave/config.json`. URL validation enforces `http`/`https` only, no embedded credentials, no query/fragment, and at most a single-segment path prefix (e.g. `/v1`); `..`/`.` traversal segments are rejected before parsing.
- For local providers the Anthropic OAuth check is skipped (it returns success) so users on local-only hardware with no Anthropic subscription can start a session; all traffic routes to `host.docker.internal`, so no Anthropic API call is made.

## Where it lives in code

- Compose injection + URL/path validation + local-LLM token paths — `crates/speedwave-runtime/src/compose.rs` (`apply_llm_config_in`, `validate_base_url`, `default_base_url`, `tokens_path`).
- Owner-only atomic file writes (Unix `chmod 0o600`, Windows per-file `icacls`) — `crates/speedwave-runtime/src/fs_perms.rs` (`write_restricted_file_atomic`, `write_restricted_file_synced`, `ensure_owner_only_dir`).
- Per-project compose persisted through the restricted-write path — `crates/speedwave-runtime/src/compose.rs::save_compose_in`.
- Repo-config SSRF guard (only `model` merged from repo) and the local-provider set — `crates/speedwave-runtime/src/config.rs` (`merge_llm_repo`, `LOCAL_PROVIDERS`, `is_local_provider`).
- Local-provider auth bypass — `desktop/src-tauri/src/setup_wizard.rs::check_claude_auth`.
- Host-gateway alias (`host.docker.internal`) statically declared for `claude` in the compose template — `containers/compose.template.yml`.
- Follow-up model-discovery and SSRF policy — [ADR-041](ADR-041-local-llm-model-discovery.md). Per-project token isolation rationale — [ADR-009](ADR-009-per-project-isolation-preserved.md).

## Rejected alternatives

- **Keep LiteLLM as a translation proxy** — recurring supply-chain risk and a standing extra container/port for a capability local servers now provide natively.
- **Support cloud LLM providers** — would require external API keys inside containers, violating the token-isolation invariant.
- **Mount the LLM credential like a plugin token (`:ro` file)** — Claude Code reads it from the environment, not from a file path, so a mount would not be consulted.

[^1]: [LiteLLM: Security Update - Suspected Supply Chain Incident (March 2026)](https://docs.litellm.ai/blog/security-update-march-2026)

[^2]: [Ollama docs: Anthropic API compatibility](https://docs.ollama.com/api/anthropic-compatibility)

[^3]: [LM Studio docs: Anthropic Compatibility Endpoints](https://lmstudio.ai/docs/developer/anthropic-compat)

[^4]: [llama.cpp PR #17570: server: add Anthropic Messages API support](https://github.com/ggml-org/llama.cpp/pull/17570)

[^5]: [vLLM docs: Claude Code integration via the Anthropic Messages API](https://docs.vllm.ai/en/latest/serving/integrations/claude_code/)

[^6]: [Unsloth docs: use Unsloth as an API endpoint](https://unsloth.ai/docs/basics/api)
