---
paths:
  - 'crates/speedwave-runtime/src/compose/**'
  - 'crates/speedwave-runtime/src/config.rs'
  - 'crates/speedwave-runtime/src/usage.rs'
  - 'containers/Containerfile.proxy'
  - 'containers/proxy/**'
  - 'desktop/src-tauri/src/llm_cmd.rs'
  - 'desktop/src-tauri/src/containers_cmd.rs'
  - 'desktop/src-tauri/src/http_util.rs'
  - 'desktop/src/src/app/settings/llm-provider/**'
  - 'docs/adr/ADR-040-remove-litellm-direct-provider-injection.md'
  - 'docs/adr/ADR-041-local-llm-model-discovery.md'
  - 'docs/adr/ADR-073-embedded-per-project-speedwave-proxy.md'
---

# LLM Provider Rules

Speedwave is a **local-first** platform. Since ADR-073 every session routes
through a per-project Rust forwarder, `proxy` (port 4000, compose
network only), which relays native Anthropic `/v1/messages` with no
translation; ADR-040's direct-injection path survives behind the
`llm.proxy_enabled` kill-switch until N+2. ADR-040, ADR-041 and ADR-073 are
mandatory reading before touching any code under the `paths:` above.

## Invariants (non-negotiable)

1. **The proxy container must never hold a canonical Anthropic credential.**
   No `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` env name may reach it —
   the passthrough leg forwards the client's subscription OAuth header
   verbatim only while the forwarder has no Anthropic credential of its own.
   Provider keys are injected exclusively as `SPW_KEY_<PROVIDER_ID>` by
   compose and read from `/tokens`. Guarded by the renderer's
   no-key-values/no-canonical-names test and the forwarder's `forward.rs`
   header tests — keep both green.
2. **OAuth sessions carry no auth env.** Injecting any of
   `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`/`apiKeyHelper` into the claude
   container disables Claude Code OAuth. The `anthropic_oauth` proxy branch
   must inject `ANTHROPIC_BASE_URL` (passthrough) and model pins only.
3. **Key VALUES never land in config.json or the rendered proxy.json.**
   Values live in `tokens/<project>/llm/<provider_id>_api_key`
   (0600, atomic, `Bearer `-stripped, CRLF-rejected); configs carry presence
   flags and `SPW_KEY_<ID>` env-name references only. Provider ids are
   plugin-grade slugs — they become file names and env names; validate with
   `plugin::is_valid_slug`, never a second regex.
4. **`provider`, `base_url`, `providers`, `active`, and `proxy_enabled` are
   user-only configuration.** Repo `.speedwave.json` may set `model` only —
   `merge_llm_repo()` strips the rest. A malicious cloned repo must not be
   able to redirect traffic, add providers, or flip the kill-switch.
5. **Anthropic model strings have one SSOT** —
   `crates/speedwave-runtime/src/defaults.rs::ANTHROPIC_MODELS`. Frontend
   reads it via `list_anthropic_models`. Do not hard-code model strings.
6. **Usage has one source of truth for final values.** The forwarder's per-request
   JSONL line plus the host-side cost sidecar (`cost-cache.jsonl`, keyed by
   `response_id`) are the SSOT for final tokens + cost across the dashboard, chat
   footer, and CLI statusline. The Claude Code result stream is a live preview
   reconciled to the proxy values, and the source of context/limits the proxy
   cannot see. Cost enrichment never rewrites the usage JSONL; unpriced
   (subscription/unknown) stays `null`, never collapsed to `0.0`.

## Env-var injection (compose/llm.rs)

- **`ANTHROPIC_MODEL` is primary**, `ANTHROPIC_CUSTOM_MODEL_OPTION` is
  supplementary. For non-Anthropic kinds the model is `<provider_id>/<model>`
  — it must match the route prefix in the rendered proxy.json.
- **Non-Anthropic kinds remap built-in aliases (ADR-073).**
  `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` are all set to the routed
  `<provider_id>/<model>` so `/model opus|sonnet|haiku|fable` hits the wildcard
  route instead of a bare `claude-*` (404). `ANTHROPIC_DEFAULT_HAIKU_MODEL`
  (subagent/background traffic) replaces the deprecated `ANTHROPIC_SMALL_FAST_MODEL`.
  The Anthropic branches keep pinning each alias to its own catalog model with
  the `[1m]` suffix via `anthropic_default_models_env()`.
- **Provenance (ADR-073 v3):** the routing model comes from the active provider
  entry (`LlmConfig::effective_active_model`), never a foreign `active.model`. A
  `provider/model`-shaped id under an Anthropic entry is dropped to the account
  default, not injected as `ANTHROPIC_MODEL`.
- A `local` provider with custom headers falls back to the direct path —
  the proxy would consume headers addressed to the LLM server.

## SSRF policy (host-side)

Unchanged from ADR-040/ADR-041: discovery probe and save path share
`validate_llm_base_url` (`llm_cmd.rs`), parameterised by `PrivatePolicy`.
The block list is fixed; changes require an ADR delta. The proxy URL
(`http://proxy:4000[/anthropic]`) is compose-internal and never
flows through user-facing URL fields.

## Container-host alias rewrite

`host.docker.internal` resolves inside containers (proxy included —
it carries `extra_hosts` for local backends) but not from the Desktop host
process. Host-side probes call `http_util::rewrite_container_alias_to_loopback`.
SSOT: `consts::HOST_GATEWAY_ALIAS`.

## Authentication bypass

`check_claude_auth` short-circuits via `project_needs_anthropic_auth`: only
an active `anthropic_oauth` provider runs the in-container OAuth check; all
other kinds (api key, local, openrouter) skip it. An
unconfigured project (no providers, dangling active, or fresh/missing) also
skips it (R7) — the user is routed to provider configuration, not an OAuth
wall. Legacy v1 keeps the `LOCAL_PROVIDERS` rule; an unset provider is
unconfigured. Any new Anthropic-auth checkpoint must use the same predicate.

## When designing or fixing any feature, ask:

- Does it talk to an LLM? It goes through the claude container → proxy
  — no host-side LLM calls except the discovery probe under `llm_cmd.rs`.
- Does it accept a URL? `validate_llm_base_url` (host) or
  `compose::validate_base_url` (render) — never a third validator.
- Does it add a provider kind or change routing? Update the renderer
  (`compose/proxy.rs`, `render_proxy_config`), the injection
  (`compose/llm.rs`), the forwarder's routing/header logic, the security
  rule expectations, AND ADR-073 in the same change.
- Does it touch the forwarder's deps? Bump `containers/proxy/Cargo.toml`
  and its `Cargo.lock` together and build `--locked`; there are no Python hashes
  to regenerate.
- Does it surface usage numbers? Decide which source of truth (invariant 6)
  and document the choice.

## Chat / context windows

Unchanged from ADR-041: local model context comes from the discovery probe
as `context_tokens: Option<u32>` (now per provider entry). When `None`,
propagate `null` — never substitute the 200K Anthropic baseline.
