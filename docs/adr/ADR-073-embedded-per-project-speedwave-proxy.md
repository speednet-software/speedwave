# ADR-073: Embedded Per-Project Speedwave Proxy

> **Status:** Accepted — supersedes ADR-040 in part (the "no proxy" decision; the credential-handling and SSRF rules of ADR-040 are upheld and extended). An earlier draft of this ADR proposed a Python LiteLLM proxy; that approach never shipped in a release and is replaced wholesale by the first-party Rust forwarder described here.
> **Context:** New product requirements — multi-provider choice (Anthropic subscription, Anthropic API key, local servers, OpenRouter, any backend that speaks the Anthropic Messages API), per-project usage accounting, and in-session model switching — cannot be met by direct env injection alone. They also do not require protocol translation: every backend Speedwave targets now speaks the native Anthropic Messages API.

## Decision

Ship `proxy` — a tiny first-party Rust Anthropic-passthrough forwarder — as a per-project compose service. Claude Code's `ANTHROPIC_BASE_URL` points at it for every provider class. The forwarder receives `POST /v1/messages` (+ `count_tokens`), routes by the model prefix in the request body to the configured backend, relays the SSE stream byte-for-byte with **no translation**, sniffs usage frames, and appends one usage line per request. The pre-proxy direct-injection path remains behind the `llm.proxy_enabled` kill-switch (default on) for one release and is removed in N+2.

```
claude ──ANTHROPIC_BASE_URL──► proxy:4000 ──┬─ anthropic prefix (passthrough) ─► api.anthropic.com
        (per-project network)                         ├─ openrouter/* (key swap) ────────► openrouter.ai
                                                       └─ <id>/* (key swap) ──────────────► local server
                                                          (every leg: native Anthropic /v1/messages, SSE relayed verbatim)
```

The forwarder is ~6 source files (`main.rs`, `router.rs`, `forward.rs`, `usage.rs`, `count_tokens.rs`, `config.rs`) built on axum + tokio + reqwest/rustls + serde, shipped as a static binary in a distroless/scratch image.

## Why a Rust forwarder instead of LiteLLM

The earlier draft of this ADR re-introduced LiteLLM (the upstream removed in ADR-040) under a tightened threat model: an exact pin, `pip install --require-hashes`[^1], no admin UI/database/host port, and worker-class hardening. That eliminated the _runtime_ attack surface but kept the _supply-chain_ one — a large Python dependency tree whose only defense was the `--require-hashes` machinery, which had to be regenerated and changelog-audited on every version bump.

Two facts made the proxy's whole reason for existing — protocol translation — unnecessary:

- **Every supported backend now speaks the native Anthropic Messages API.** Anthropic itself (passthrough), OpenRouter[^2], llama.cpp[^3], vLLM[^4], LM Studio[^5], and Ollama[^6] all expose `POST /v1/messages` with streaming. A backend that _only_ speaks OpenAI Chat Completions is out of scope (documented minimum-version requirement + fail-fast), because the forwarder never translates Anthropic↔OpenAI.
- **The only behaviors Speedwave actually needs are routing, a verbatim/swap header decision, an SSE byte relay, and a usage sniff** — a few hundred lines of Rust, not a translation engine.

The supply-chain win: the forwarder has **no Python dependencies**. It retires the `requirements.in` / `requirements.txt --generate-hashes` / `--require-hashes` machinery[^1] that was ADR-040's central concern entirely — the image is a multi-stage Rust build over a single `Cargo.lock` (built `--locked`), and every external `FROM` is digest-pinned (`@sha256:`, enforced by `build.rs::every_base_image_is_digest_pinned`). Built locally, never pulled (`pull_policy: never`).

## Topology: per project, not shared

One `proxy` container per project, inside that project's compose network. A shared instance would require a host port (local exposure of all keys without auth), would hold every project's keys in one process, and a settings change in one project would restart streams in all others. Per-project instances exist only while the project runs.

The forwarder is dramatically lighter than the LiteLLM container it replaces: measured **~3-4 MiB idle and ~37 MiB peak** under 15 concurrent 64k streams on the dev Lima VM. The resource cap is **128 MiB** (≈3.5× the measured peak — `resources.rs::PROXY_RESOURCES`), down from the 512 MiB LiteLLM cap, counted in adaptive VM sizing (ADR-068).

## Provider model (config schema v3)

`LlmConfig` carries `providers: Vec<LlmProviderEntry>` + `active: {provider_id, model}` + `schema_version`. Entry kinds: `anthropic_oauth`, `anthropic_api_key`, `local`, `open_router`. Provider ids are plugin-grade slugs (`^[a-z][a-z0-9-]{0,63}$`) because they become token file names and `SPW_KEY_<ID>` env names.

- **Provenance invariant (v3):** the routing model belongs to its provider. `LlmProviderEntry.model` is the per-provider source of truth; `active.model` is a pointer that must agree with the active entry. The render derives the model via `LlmConfig::effective_active_model` — a foreign `active.model` (e.g. an OpenRouter id left under an Anthropic entry) is never injected as `ANTHROPIC_MODEL`. An anthropic provider with a `provider/model`-shaped (foreign) id falls back to the account default.
- **v3 self-heal:** `migrate_llm_to_v2` quarantines a foreign model under an anthropic entry (clears it + reconciles `active.model`); `heal_llm_config_on_disk` (run once at Desktop startup, under the config lock) persists the healed config. Idempotent.
- **Migration:** v1 flat configs lift on resolve (`migrate_llm_to_v2`): legacy `anthropic` classifies as `anthropic_api_key` iff `secrets/<project>/anthropic_api_key` exists, else `anthropic_oauth`; local aliases normalise to one `local` entry. Idempotent.
- **Downgrade story:** every save also writes derived v1 fields (`sync_llm_legacy_fields`) for one release. For OpenRouter (no v1 equivalent) the flat `model` is left `None` so the masqueraded `provider=anthropic` pair never carries a foreign model.
- **SSRF rule kept:** repo `.speedwave.json` can still set `model` only — never providers, base URLs, the active selection, or the kill-switch.

## Routing and authentication per provider kind

`resolve(cfg, model)` splits the request-body `model` on the first `/`; the prefix selects a route. A bare model with no slash (e.g. `claude-opus-4-8`) routes to the `anthropic` passthrough. Routes are read from `/config/proxy.json`, rendered per project (`compose::render_proxy_config`); the config carries no secrets — non-Anthropic keys are referenced by env name only (`SPW_KEY_<ID>`), never by value, and never under a canonical Anthropic name.

| Kind                | Route prefix → backend                             | Auth                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `anthropic_oauth`   | `anthropic` → `api.anthropic.com` (passthrough)    | Claude Code's own OAuth `Authorization`, forwarded **verbatim**        | **No auth env may be injected** — any of `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` disables Claude Code OAuth. Login flow unchanged (ADR-052): OAuth endpoints are hardcoded to api.anthropic.com in Claude Code[^7] and never touch the proxy.                                                                                                                                                                                                                                                 |
| `anthropic_api_key` | same passthrough                                   | `ANTHROPIC_API_KEY` env on `claude`, forwarded as `x-api-key`          | Deliberate deviation from "all keys into proxy tokens": keeping the key client-side preserves `/model` alias + `[1m]` semantics and avoids prefix-routing the Anthropic catalogue. ADR-040's env-visibility residual risk applies unchanged.                                                                                                                                                                                                                                                     |
| `local`             | `<provider_id>` → local / remote custom-URL server | dummy Bearer dropped; backend key (if any) via `SPW_KEY_<ID>`          | Model is sent as `<provider_id>/<model>` matching the rendered route. Covers both local and remote Anthropic-Messages servers (the former `open_ai_compat` kind was a duplicate and was removed). `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` all remap to the routed id so built-in `/model` aliases hit the route instead of a bare `claude-*` (404). `ANTHROPIC_DEFAULT_HAIKU_MODEL` (replacing the deprecated `ANTHROPIC_SMALL_FAST_MODEL`) pins subagent traffic to the same model. |
| `open_router`       | `openrouter` → `openrouter.ai`                     | dummy Bearer dropped; OpenRouter key via `SPW_KEY_OPENROUTER` (Bearer) | OpenRouter exposes the Anthropic Messages API natively[^2].                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**The verbatim OAuth passthrough invariant (non-negotiable):** on the Anthropic leg the forwarder copies the client's `authorization`, `x-api-key`, `anthropic-beta`, `anthropic-version`, and `content-type` headers to `api.anthropic.com` untouched and **injects nothing** — it holds no Anthropic credential of its own. On a swap leg it **drops** the inbound dummy auth (`sk-no-key-required` that Claude Code sends on non-Anthropic legs), keeps the non-auth Anthropic headers, and sets the scheme'd header from the `SPW_KEY_<ID>` value. No env name containing `TOKEN`/`KEY`/`SECRET` beyond `SPW_KEY_*` ever reaches the forwarder. This is enforced by `forward.rs` unit tests (`passthrough_forwards_oauth_bearer_verbatim`, `passthrough_never_injects_a_stored_key`, `swap_drops_dummy_and_injects_provider_key`) and the renderer's no-key-values/no-canonical-names test.

**Session granularity:** the provider class is fixed per session. Within a session `/model` switches freely across models of the configured providers; built-in aliases are remapped via `ANTHROPIC_DEFAULT_*_MODEL` so they do not 404 on a non-anthropic provider. Mixing the subscription with non-Anthropic providers in one session is impossible because passthrough forwards the OAuth `Authorization` only to api.anthropic.com. Content-based dynamic routing is explicitly out of scope (future ADR).

**Limitation:** a `local` provider with custom headers falls back to the direct path — headers are addressed to the LLM server and the proxy would consume them.

## No translation

The forwarder relays the upstream byte stream unbuffered (channel + `ReceiverStream`, no buffering) and never rewrites the response — the SSE stream is relayed verbatim. The request body is touched only minimally: on a swap leg `forward.rs::strip_model_prefix` rewrites the single `model` field to drop the route prefix (`local/foo` → `foo`), because the backend only knows its own model name, not Speedwave's routing prefix; the Anthropic passthrough leg (no prefix) leaves the body untouched. Because every supported backend speaks native Anthropic `/v1/messages` with streaming[^2][^3][^4][^5][^6], there is no Anthropic↔OpenAI translation step — the source of LiteLLM's pydantic-bridge noise, its streaming-logging gaps, and most of its CPU cost. A pure OpenAI-only backend is therefore unsupported by design; the docs state the minimum versions that added the Anthropic endpoint, and an OpenAI-only server fails fast rather than being silently mistranslated.

## count_tokens shim

Claude Code probes `POST /v1/messages/count_tokens` before a turn. Some backends do not implement it: Ollama returns 404 and then cascades into 500s with growing timeouts until the server becomes unresponsive[^6]. The forwarder intercepts the route and returns a synthetic `200 {"input_tokens":0}` without any upstream call, so the probe never reaches a backend that mishandles it. This is harmless for backends that _do_ support count_tokens (llama.cpp implements it[^3]) — Claude Code only uses the value as a soft pre-flight estimate, and the real token counts still come from the streamed `usage` frames.

## Usage accounting (per backend)

The relay task sniffs SSE frames as they pass and, on stream end, appends exactly one compact JSON line to `/usage/usage.jsonl` (per-project bind mount `usage/<project>/proxy/`). The line uses the exact field names the host aggregator reads (`ts, capture, status, model, response_id, cost_usd, latency_ms, prompt_tokens, completion_tokens, cache_read, cache_write`); the timestamp is RFC3339-millis with a local colon offset (matching `log_ts::log_timestamp`). Anthropic `input_tokens→prompt_tokens`, `output_tokens→completion_tokens`, `cache_read_input_tokens→cache_read`, `cache_creation_input_tokens→cache_write`; `response_id` from `message_start.message.id`.

Per-backend nuances captured directly from the wire (no callback, no translation bridge):

- **`input_tokens` from `message_start` OR the last non-zero `message_delta`** — bridged backends (e.g. vLLM) sometimes report prompt tokens only on the final delta.
- **No usage frame → no line.** A stream that never carried a `usage` block is skipped rather than logged as `0/0` (prevents zero-only noise).
- **A legitimate `0/0` is still emitted** (e.g. an OpenRouter cache hit) — the sniffer distinguishes "never seen" from "seen and zero".

Host-side, `speedwave_runtime::usage` aggregates per day/model with `response_id` dedup and 10 MiB rotation. **The usage JSONL is the SSOT for final usage values** (tokens + cost) across all three surfaces — dashboard, chat footer, CLI statusline. The Claude Code result stream is a live in-progress preview, reconciled to the proxy values once the request is recorded; context-window % and subscription rate-limits stay sourced from Claude Code (the proxy never sees them). OpenRouter prices a generation a few seconds after the stream ends, so a turn is first written `deferred` (`cost_usd: null`); the chat footer re-reconciles it on a short backoff (`reconcileFooterCost`) until `/generation` fills the real cost, while the dashboard re-enriches on every open — so neither freezes at the pre-pricing value.

**Traffic logging.** Beyond the usage JSONL, the forwarder logs the live request flow at `info` — one inbound line (`proxy req: model=… prefix=… provider=kind/id → <upstream_host>`) and one outbound line (`proxy resp: model=… status=… latency=…ms in=… out=…`, token counts from the same SSE sniffer, `-` when no usage frame was seen). These carry routing metadata only — no auth headers, keys, or request/response bodies, and the upstream is a `host[:port]` with no path or query. The proxy container's stdout already reaches the Desktop log view, the `/logs` UI, and the diagnostics ZIP through the `compose` log source (`get_all_logs` → `merge_log_sources` → `log_sanitizer::sanitize`), so the traffic is visible with no extra transport; `RUST_LOG` overrides the level. A `>= 400` upstream status additionally emits a `warn`.

The proxy tags each line with `provider_kind`/`provider_id`/`gen_id` but never writes cost. **Cost is enriched host-side** into an append-only sidecar (`cost-cache.jsonl`) keyed by `response_id` — the usage JSONL is read-only and never rewritten, so enrichment cannot race the proxy's append or rotation. Per provider: Anthropic API key → `ANTHROPIC_MODELS` price catalog (`cost_source: catalog`); Anthropic OAuth → `null` (`subscription`, flat-rate); OpenRouter → real `GET /api/v1/generation` `data.total_cost` (`actual`)[^8], else `unknown`; local → `0.0` (`free`); catalog miss → `null` (`unknown`). Aggregation keeps `cost_usd: Option<f64>` with `priced_requests`/`unpriced_requests`, so a subscription session shows "—", never `$0`.

JSONL over SQLite is deliberate: the file crosses the VM boundary on a bind mount (virtiofs/9p), where SQLite locking is unreliable; append-only text degrades to one truncated line on crash, which the aggregator skips and reports.

## Hot reload

`ContainerRuntime::compose_up_service(project, "proxy")` recreates only the forwarder after an LLM-settings change (config re-render + targeted `up -d --force-recreate`); the claude container restarts only when its own env changed. Service names are validated against `BUILT_IN_SERVICES` before reaching engine argv.

nerdctl's config-hash convergence only recreates services whose compose definition changed — and neither the bind-mounted `/config` files nor the `/tokens` key files are part of that definition, while the forwarder reads its config and resolves keys only at container start. The renderer therefore injects `SPW_CONFIG_DIGEST` (sha256 over each rendered file under the project's config dir — name + full content — plus each key file's name + a sha256 of its content; never raw key values) into the service env, making any config or key change a compose-definition change. Image-level changes (Containerfile, Cargo sources) propagate independently via the per-image build-input hash tags (ADR-072).

## Where it lives in code

- Forwarder: `containers/proxy/src/{main,router,forward,usage,count_tokens,config}.rs` (standalone cargo project, built `--locked`)
- Image: `containers/Containerfile.proxy` (multi-stage Rust → distroless/scratch, digest-pinned)
- Compose: `containers/compose.template.yml` (`proxy` service), `compose/mod.rs` (mount dirs + substitution), `resources.rs::PROXY_RESOURCES`
- Config renderer + keys: `compose/proxy.rs` (`render_proxy_config`); token namespace: `compose/tokens.rs` (`llm` service)
- Schema + migration: `config.rs` (`LlmProviderEntry`, `migrate_llm_to_v2`, `sync_llm_legacy_fields`, `proxy_enabled`)
- Routing/env injection: `compose/llm.rs` (`apply_llm_config_proxy` / `apply_llm_config_legacy_in`)
- Security: `compose/security_check.rs` (proxy-volumes rule), `log_sanitizer.rs` (Google key rule)
- Usage: `crates/speedwave-runtime/src/usage.rs`, desktop `llm_cmd.rs::get_llm_usage`
- Auth gating: desktop `setup_wizard.rs::project_needs_anthropic_auth`
- Per-service recreate: `runtime/mod.rs::compose_up_service` (+ Lima/WSL impls, `LockedRuntime`, mock)

[^1]: pip `--require-hashes` secure-installs mode (the supply-chain machinery this design retires by having no Python deps): https://pip.pypa.io/en/stable/topics/secure-installs/

[^2]: OpenRouter exposes the Anthropic Messages API (`POST /v1/messages`, native request/response + streaming): https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages

[^3]: llama.cpp `llama-server` added native Anthropic Messages API support (incl. `POST /v1/messages/count_tokens`, tools, vision, streaming with Anthropic SSE events) — PR #17570: https://github.com/ggml-org/llama.cpp/pull/17570

[^4]: vLLM Anthropic Messages API endpoints (`/v1/messages` + `/v1/messages/count_tokens`) — feature issue #21313: https://github.com/vllm-project/vllm/issues/21313 ; serving docs: https://docs.vllm.ai/en/latest/serving/online_serving/

[^5]: LM Studio 0.4.1 added an Anthropic-compatible `POST /v1/messages` endpoint with SSE streaming (`message_start`, `content_block_delta`, `message_stop`): https://lmstudio.ai/docs/developer/anthropic-compat/messages

[^6]: Ollama exposes the Anthropic-compatible `/v1/messages` endpoint but does not implement `/v1/messages/count_tokens`; the unhandled probe degrades the server into 500s/timeouts (the cascade the shim prevents) — issue #13949: https://github.com/ollama/ollama/issues/13949 ; Anthropic compatibility docs: https://docs.ollama.com/api/anthropic-compatibility

[^7]: Claude Code OAuth/admin endpoints ignore `ANTHROPIC_BASE_URL` (hardcoded to api.anthropic.com), so the login flow never traverses the proxy: https://github.com/anthropics/claude-code/issues/48011

[^8]: OpenRouter exposes per-generation cost (`data.total_cost`, USD) via `GET /api/v1/generation?id=<gen-id>`: https://openrouter.ai/docs/api-reference/get-a-generation
