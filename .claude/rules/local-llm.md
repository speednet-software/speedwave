---
paths:
  - 'crates/speedwave-runtime/src/compose/**'
  - 'crates/speedwave-runtime/src/config.rs'
  - 'crates/speedwave-runtime/src/usage.rs'
  - 'crates/speedwave-runtime/src/usage_cost.rs'
  - 'containers/Containerfile.proxy'
  - 'containers/proxy/**'
  - 'desktop/src-tauri/src/llm_cmd.rs'
  - 'desktop/src-tauri/src/llm_cmd/**'
  - 'desktop/src-tauri/src/containers_cmd.rs'
  - 'desktop/src-tauri/src/http_util.rs'
  - 'desktop/src/src/app/settings/llm-provider/**'
  - 'docs/adr/ADR-040-remove-litellm-direct-provider-injection.md'
  - 'docs/adr/ADR-041-local-llm-model-discovery.md'
  - 'docs/adr/ADR-073-embedded-per-project-speedwave-proxy.md'
---

# LLM Provider Rules

Every session routes through the per-project Rust forwarder `proxy` (port 4000, compose network only), which relays native Anthropic `/v1/messages` with no translation. `llm.proxy_enabled` defaults to `true` (`unwrap_or(true)`), so the proxy is the primary Anthropic path for nearly everyone — the legacy direct-injection path is the fallback, scheduled for removal; do not build on it.

## Invariants (non-negotiable)

1. **The proxy container never holds a canonical Anthropic credential.** No `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` env name may reach it — the passthrough leg forwards the client's subscription OAuth header verbatim. Provider keys are injected exclusively as `SPW_KEY_<PROVIDER_ID>` by compose and read from `/tokens`. Guarded by the renderer's no-key-values/no-canonical-names test and the forwarder's `forward.rs` header tests — keep both green.
2. **OAuth sessions carry no auth env.** Injecting `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`/`apiKeyHelper` into the claude container disables Claude Code OAuth. The `anthropic_oauth` branch injects `ANTHROPIC_BASE_URL` (passthrough) and model defaults only.
3. **Key VALUES never land in config.json or the rendered proxy.json.** Values live in `tokens/<project>/llm/<provider_id>_api_key` (0600, atomic, `Bearer `-stripped, CRLF-rejected); configs carry presence flags and `SPW_KEY_<ID>` env-name references only. Provider ids are plugin-grade slugs (`plugin::is_valid_slug`, never a second regex).
4. **`provider`, `base_url`, `providers`, `active`, `proxy_enabled` are user-only config.** Repo `.speedwave.json` may set `model` only — `merge_llm_repo()` strips the rest. A malicious cloned repo must not redirect traffic, add providers, or flip the kill-switch.
5. **Anthropic model strings have one SSOT** — `defaults.rs::ANTHROPIC_MODELS`, read by the frontend via `list_anthropic_models`. No hard-coded model strings.
6. **Usage has one source of truth for final values.** The forwarder's per-request JSONL line plus the host-side cost sidecar (`cost-cache.jsonl`, keyed by `response_id`) are the SSOT for final tokens + cost (dashboard, chat footer, and the in-container `statusline.sh`, which reads the sidecar's `response_id`/`cost_usd` fields directly with last-write-wins dedup — the `speedwave` CLI binary has no usage command). The Claude Code result stream is a live preview reconciled to proxy values, and the only source of context/limits the proxy cannot see. Cost enrichment never rewrites the usage JSONL; unpriced (subscription/unknown) stays `null`, never `0.0`. The `CostSource` enum (`usage_cost.rs`, wire strings `catalog`/`subscription`/`free`/`actual`/`unknown`/`deferred`/`failed`) is a two-consumer contract Rust ↔ TS `models/llm.ts::CostSourceKind` (test `cost_source_ts_union_matches_rust`) — never reorder/rename; `deferred` is the only non-terminal source (OpenRouter async cost) and drives the footer re-reconcile.

## Env-var injection (compose/llm.rs)

- **Anthropic kinds inject the Settings model as `ANTHROPIC_DEFAULT_MODEL`, never `ANTHROPIC_MODEL`** (ADR-073 amendment 2026-09-02): it is the session's starting model, and a `/model` pick persisted in the in-container `settings.json` outranks it, whereas `ANTHROPIC_MODEL` would outrank that pick (both verified on CC 2.1.252; a persisted pick is a CLI/TUI behavior, `-p` stream-json sessions keep `/model` session-only). Test-guarded: `assert_model_not_forced` in `compose/mod.rs`.
- **Non-Anthropic kinds force `ANTHROPIC_MODEL=<provider_id>/<model>`**, `ANTHROPIC_CUSTOM_MODEL_OPTION` supplementary; the routed id must match the route prefix in the rendered proxy.json and must beat any persisted pick. `entrypoint.sh` drops a foreign `provider/model` id from `settings.json` only when `ANTHROPIC_MODEL` is unset; a persisted pick that merely differs from a forced `ANTHROPIC_MODEL` is left alone (the env pin wins at startup).
- **Non-Anthropic kinds remap built-in aliases:** `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` all point at the routed `<provider_id>/<model>` so `/model opus|sonnet|haiku|fable` hits the wildcard route instead of 404ing on a bare `claude-*`. `ANTHROPIC_DEFAULT_HAIKU_MODEL` (subagent/background traffic) replaces the deprecated `ANTHROPIC_SMALL_FAST_MODEL`.
- **Anthropic kinds pin `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` only — FABLE is deliberately omitted** (it resolves natively; test `anthropic_default_models_env_omits_fable_alias`), each alias to its latest catalog model, with the `[1m]` suffix only where the model supports a 1M context. `[1m]` is real Claude Code model-id syntax — it must stay quoted in compose YAML (Go/nerdctl chokes on `[`); never strip it.
- **Provenance:** the routing model comes from the active provider entry (`LlmConfig::effective_active_model`), never a foreign `active.model`. A `provider/model`-shaped id under an Anthropic entry falls back to the account default.
- A `local` provider with custom headers falls back to the direct path — the proxy would consume headers addressed to the LLM server.
- **Windows mirrored-mode limitation (ADR-080):** host-side local LLM listeners (user-run Ollama/LM Studio/llama.cpp) are NOT relayed — `compose/llm.rs` emits `host.docker.internal:<raw port>` and no Speedwave process supervises those ports, so under WSL2 mirrored mode the proxy cannot reach them. Workarounds: switch WSL to NAT, run the LLM inside the distro, or hand-run a `socat` unit (see ADR-080 "Known limitations"). A supervised relay for configured provider ports is future work.
- **Local-only CLI flags (config.rs resolver, not compose):** an active `Local` kind adds `--exclude-dynamic-system-prompt-sections` (KV-cache prefix reuse) and `--append-system-prompt` with `prompts::local_llm_skills_nudge()` (static copy — never interpolate config values into it without a sanitizer; the v0.10-removed `local_llm_identity` shows the injection risk). Prompt **replacement** (`--system-prompt-file`) stays banned — removed in v0.10.0, do not reintroduce. Test-guarded (`resolve_injects_skills_nudge_*`, `resolve_never_replaces_prompt_*`).

## URLs, aliases, auth

- Discovery probe and save path share `validate_llm_base_url` (`llm_cmd/discovery.rs`, re-exported through `llm_cmd.rs` — the module was split into `llm_cmd/{discovery,usage}.rs`), parameterized by `PrivatePolicy`; render-side validation is `compose::validate_base_url` — never a third validator. The block list is fixed; changes require an ADR delta. The proxy URL (`http://proxy:4000`, routed by request-body model prefix, not URL path) is compose-internal and never flows through user-facing URL fields.
- `host.docker.internal` resolves inside containers (proxy carries `extra_hosts`) but not on the Desktop host — host-side probes call `http_util::rewrite_container_alias_to_loopback`. A saved loopback `base_url` is rewritten to the alias by `compose::canonicalize_local_base_url` (the persisted value must be reachable from inside the proxy container).
- `check_claude_auth` short-circuits via `project_needs_anthropic_auth`: only an active `anthropic_oauth` provider runs the in-container OAuth check; api-key/local/openrouter kinds and unconfigured projects skip it (routed to provider configuration, not an OAuth wall). Any new Anthropic-auth checkpoint uses the same predicate.

## When designing or fixing any feature, ask

- Does it talk to an LLM? It goes claude container → proxy — no host-side LLM calls except the discovery probe in `llm_cmd.rs`.
- Does it add a provider kind or change routing? Update the renderer (`compose/proxy.rs::render_proxy_config`), the injection (`compose/llm.rs`), the forwarder's routing/header logic, and the security-test expectations in the same change.
- Does it touch the forwarder's deps? Bump `containers/proxy/Cargo.toml` + its `Cargo.lock` together; build `--locked`.
- Does it surface usage numbers? Decide which source of truth (invariant 6) and document the choice.
- Local model context windows come from the discovery probe as `context_tokens: Option<u32>`; when `None`, propagate `null` — never substitute the 200K Anthropic baseline.
- Any new env injected into the `claude` service whose name contains `TOKEN`/`KEY`/`SECRET` (e.g. `CLAUDE_CODE_MAX_CONTEXT_TOKENS`) must be added to the `NoTokensClaude` allowlist in `compose/security_check.rs`, or the start gate rejects its own render and containers never start. Guard: `test_rendered_compose_with_routed_window_passes_security_check`.
