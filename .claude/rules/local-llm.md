---
paths:
  - 'crates/speedwave-runtime/src/compose.rs'
  - 'crates/speedwave-runtime/src/config.rs'
  - 'desktop/src-tauri/src/llm_cmd.rs'
  - 'desktop/src-tauri/src/containers_cmd.rs'
  - 'desktop/src-tauri/src/url_validation.rs'
  - 'desktop/src/src/app/settings/llm-provider/**'
  - 'docs/adr/ADR-040-remove-litellm-direct-provider-injection.md'
  - 'docs/adr/ADR-041-local-llm-model-discovery.md'
---

# Local LLM Rules

Speedwave is a **local-first** platform. Since ADR-040 LiteLLM is gone — Claude Code talks directly to a local LLM server (Ollama / LM Studio / llama.cpp) or to Anthropic. There is no proxy in between. ADR-040 and ADR-041 are mandatory reading before touching any code under the `paths:` above.

## Invariants (non-negotiable)

Whether you are adding a feature, fixing a bug, or refactoring something adjacent, none of these may regress:

1. **No cloud LLM providers other than Anthropic.** No OpenAI, Gemini, DeepSeek, OpenRouter, Together, etc. The supported set is `anthropic | ollama | lmstudio | llamacpp`. If a feature requires a fifth provider — write an ADR.
2. **No external LLM API keys ever enter a container.** Local providers use the dummy `ANTHROPIC_AUTH_TOKEN=sk-no-key-required`. Anthropic uses the user's own OAuth/key. Neither path puts a third-party LLM credential inside the trust boundary.
3. **`provider` and `base_url` are user-only configuration.** Repo `.speedwave.json` may set `model` only — `merge_llm_repo()` strips the rest. A malicious cloned repo must not be able to redirect the user's traffic. If you add a new LLM-related field to config, decide explicitly which side (user vs repo) may set it, and add the merge test.
4. **Anthropic model strings have one SSOT** — `crates/speedwave-runtime/src/defaults.rs::ANTHROPIC_MODELS`. Frontend reads it via the `list_anthropic_models` Tauri command and `AnthropicModelsService`. Bumping a model = editing one const. Do not hard-code model strings in Angular, in compose injection, or in tests.

## Env-var injection (compose.rs)

The full table lives in ADR-040. Two rules when modifying it:

- **`ANTHROPIC_MODEL` is primary**, `ANTHROPIC_CUSTOM_MODEL_OPTION` is supplementary. Without `ANTHROPIC_MODEL` Claude Code falls back to the account-tier default and the UI lies about which model is running. Don't drop one and keep the other.
- **`ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` is forbidden.** It silently remaps built-in aliases to the local model and leaves three misleading Anthropic names in `/model`. Choose explicit naming over silent remapping.

## SSRF policy (host-side)

The discovery probe (`discover_llm_models`) and the save path (`update_llm_config`) **share one validator** — `validate_llm_base_url` in `desktop/src-tauri/src/url_validation.rs`, parameterised by `PrivatePolicy`. Two callsites, one policy. When you add a third callsite (e.g. a future "test connection" button):

- Reuse `validate_llm_base_url`. Do not write a second URL validator.
- If your callsite needs a different loopback policy than the existing two, extend `PrivatePolicy` (already used by Redmine — Rule of Three is satisfied), don't fork the function.
- Block list is **fixed**: link-local (incl. cloud metadata 169.254.169.254 and IPv6 `fe80::/10`), TEST-NET, IPv6 documentation/discard prefixes, multicast, unspecified, embedded credentials, query/fragment, non-`http(s)` schemes. IPv6-mapped IPv4 bypasses are checked. Adding to or removing from this list requires an ADR delta.

The HTTP probe itself runs through reqwest with: `redirect::Policy::none()`, 5-second timeout, 5 MiB body cap (`http_util::read_body_limited`), `Content-Type` allow-list. These four are a unit — if you add a new probe, copy the configuration constants by **reusing the existing reqwest client builder**, not by re-typing the values.

## Container-host alias rewrite

`host.docker.internal`, `host.lima.internal`, `host.containers.internal`, `host.speedwave.internal` resolve **inside the container** but not from the Desktop host process — Speedwave does not bundle Docker Desktop. Host-side code that probes a base URL must call `speedwave_runtime::compose::rewrite_container_alias_to_loopback`. The four aliases live in `CONTAINER_HOST_ALIASES` (one SSOT). Do not introduce a fifth alias without updating the constant **and** the rewrite helper **and** the discovery tests.

## Authentication bypass

`check_claude_auth` short-circuits to `Ok(true)` when provider is `ollama | lmstudio | llamacpp`. This is the **only** Anthropic auth check that may be bypassed for local providers. If you add another auth checkpoint (telemetry, model lookup, license check), it must follow the same pattern — local providers never reach Anthropic, so requiring an Anthropic token there blocks legitimate offline users.

## When designing or fixing any feature, ask:

- Does it talk to an LLM? Then it goes through the Claude Code container — no host-side LLM calls except the discovery probe under `llm_cmd.rs`.
- Does it accept a URL? Then it goes through `validate_llm_base_url` (or the Redmine equivalent for non-LLM services).
- Does it surface a model name to the user? Read it from `ANTHROPIC_MODELS` (Anthropic side) or from the discovery result (`DiscoveredModel`) — never hard-code.
- Does it write to repo `.speedwave.json` parsing? Verify the `merge_llm_repo()` allow-list still excludes it.
- Does the feature only make sense with a cloud provider? Stop — write an ADR first; the local-first invariant is load-bearing.

## Chat / context windows

Local model context is reported by the discovery probe as `context_tokens: Option<u32>` (Ollama: `model_info.<arch>.context_length`; LM Studio: `max_context_length`; llama.cpp: `meta.n_ctx_train`). When `None`, fall back gracefully — never guess a default. Chat code that prunes history must read this value, not assume Anthropic's 200K / 1M.
