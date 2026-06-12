---
paths:
  - 'crates/speedwave-runtime/src/compose/**'
  - 'crates/speedwave-runtime/src/config.rs'
  - 'crates/speedwave-runtime/src/usage.rs'
  - 'containers/Containerfile.litellm'
  - 'containers/litellm/**'
  - 'desktop/src-tauri/src/llm_cmd.rs'
  - 'desktop/src-tauri/src/containers_cmd.rs'
  - 'desktop/src-tauri/src/http_util.rs'
  - 'desktop/src/src/app/settings/llm-provider/**'
  - 'docs/adr/ADR-040-remove-litellm-direct-provider-injection.md'
  - 'docs/adr/ADR-041-local-llm-model-discovery.md'
  - 'docs/adr/ADR-072-embedded-per-project-litellm-proxy.md'
---

# LLM Provider Rules

Speedwave is a **local-first** platform. Since ADR-072 every session routes
through a per-project LiteLLM proxy container (`litellm`, port 4000, compose
network only); ADR-040's direct-injection path survives behind the
`llm.proxy_enabled` kill-switch until N+2. ADR-040, ADR-041 and ADR-072 are
mandatory reading before touching any code under the `paths:` above.

## Invariants (non-negotiable)

1. **The litellm container must never hold a canonical Anthropic credential.**
   No `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` env name may reach it —
   the `/anthropic` passthrough forwards the client's subscription OAuth
   header only while the proxy has no Anthropic credential of its own.
   Provider keys are exported exclusively as `SPW_KEY_<PROVIDER_ID>` by the
   entrypoint. Guarded by `render_never_embeds_key_values_or_canonical_names`
   and the entrypoint BATS suite — keep both green.
2. **OAuth sessions carry no auth env.** Injecting any of
   `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`/`apiKeyHelper` into the claude
   container disables Claude Code OAuth. The `anthropic_oauth` proxy branch
   must inject `ANTHROPIC_BASE_URL` (passthrough) and model pins only.
3. **Key VALUES never land in config.json or the rendered litellm
   config.yaml.** Values live in `tokens/<project>/llm/<provider_id>_api_key`
   (0600, atomic, `Bearer `-stripped, CRLF-rejected); configs carry presence
   flags and `os.environ/SPW_KEY_<ID>` references. Provider ids are
   plugin-grade slugs — they become file names and env names; validate with
   `plugin::is_valid_slug`, never a second regex.
4. **`provider`, `base_url`, `providers`, `active`, and `proxy_enabled` are
   user-only configuration.** Repo `.speedwave.json` may set `model` only —
   `merge_llm_repo()` strips the rest. A malicious cloned repo must not be
   able to redirect traffic, add providers, or flip the kill-switch.
5. **Anthropic model strings have one SSOT** —
   `crates/speedwave-runtime/src/defaults.rs::ANTHROPIC_MODELS`. Frontend
   reads it via `list_anthropic_models`. Do not hard-code model strings.
6. **Usage has one dashboard source.** The litellm callback JSONL
   (aggregated by `speedwave_runtime::usage`) feeds the usage dashboard; the
   Claude Code result stream feeds per-session chat stats. Never sum the two
   — the same request appears in both.

## Env-var injection (compose/llm.rs)

- **`ANTHROPIC_MODEL` is primary**, `ANTHROPIC_CUSTOM_MODEL_OPTION` is
  supplementary. For non-Anthropic kinds the model is `<provider_id>/<model>`
  — it must match the wildcard route in the rendered litellm config.
- **`ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` is forbidden for
  non-Anthropic kinds** (silent alias remapping). The Anthropic branches pin
  each alias to its own model with the `[1m]` suffix (ADR-040 rule, upheld).
  `ANTHROPIC_SMALL_FAST_MODEL` (subagent traffic) is pinned to the active
  model for non-Anthropic kinds instead.
- A `local` provider with custom headers falls back to the direct path —
  the proxy would consume headers addressed to the LLM server.

## SSRF policy (host-side)

Unchanged from ADR-040/ADR-041: discovery probe and save path share
`validate_llm_base_url` (`llm_cmd.rs`), parameterised by `PrivatePolicy`.
The block list is fixed; changes require an ADR delta. The litellm proxy URL
(`http://litellm:4000[/anthropic]`) is compose-internal and never flows
through user-facing URL fields.

## Container-host alias rewrite

`host.docker.internal` resolves inside containers (litellm included — it
carries `extra_hosts` for local backends) but not from the Desktop host
process. Host-side probes call `http_util::rewrite_container_alias_to_loopback`.
SSOT: `consts::HOST_GATEWAY_ALIAS`.

## Authentication bypass

`check_claude_auth` short-circuits via `project_needs_anthropic_auth`: only
an active `anthropic_oauth` provider runs the in-container OAuth check; all
other kinds (api key, local, openrouter, openai-compat, custom) skip it.
Legacy v1 configs keep the `LOCAL_PROVIDERS` rule. Any new Anthropic-auth
checkpoint must use the same predicate.

## When designing or fixing any feature, ask:

- Does it talk to an LLM? It goes through the claude container → litellm —
  no host-side LLM calls except the discovery probe under `llm_cmd.rs`.
- Does it accept a URL? `validate_llm_base_url` (host) or
  `compose::validate_base_url` (render) — never a third validator.
- Does it add a provider kind or change routing? Update the renderer
  (`compose/litellm.rs`), the injection (`compose/llm.rs`), the security
  rule expectations, AND ADR-072 in the same change.
- Does it touch litellm's version? Follow the bump procedure in
  `containers/litellm/requirements.in` (regenerate hashes, audit changelog).
- Does it surface usage numbers? Decide which source of truth (invariant 6)
  and document the choice.

## Chat / context windows

Unchanged from ADR-041: local model context comes from the discovery probe
as `context_tokens: Option<u32>` (now per provider entry). When `None`,
propagate `null` — never substitute the 200K Anthropic baseline.
