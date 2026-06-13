# ADR-073: Embedded Per-Project LiteLLM Proxy

> **Status:** Accepted — supersedes ADR-040 in part (the "no proxy" decision; the credential-handling and SSRF rules of ADR-040 are upheld and extended)
> **Context:** New product requirements — multi-provider choice (Anthropic subscription, Anthropic API key, local servers, OpenRouter, any OpenAI-compatible endpoint), per-project usage accounting, and in-session model switching — cannot be met by direct env injection alone.

## Decision

Ship a LiteLLM proxy as a per-project compose service (`litellm`). Claude Code's `ANTHROPIC_BASE_URL` points at it for every provider class; the proxy routes to the configured backend. The pre-proxy direct-injection path remains behind the `llm.proxy_enabled` kill-switch (default on) for one release and is removed in N+2.

```
claude ──ANTHROPIC_BASE_URL──► litellm:4000 ──┬─ /anthropic (passthrough) ─► api.anthropic.com
        (per-project network)                 ├─ openrouter/* ─────────────► openrouter.ai
                                              └─ <id>/* (openai translation)► local / custom server
```

## Why this does not resurrect the ADR-040 attack surface

ADR-040 removed a **shared, `:latest`-pulled, translation-mandatory** LiteLLM after a poisoned-dependency incident. This ADR re-introduces LiteLLM under a different threat model:

- **Exact pin + hash verification.** `containers/litellm/requirements.in` pins `litellm[proxy]==1.88.1`; `requirements.txt` is `uv pip compile --generate-hashes` output and the image installs with `pip install --require-hashes`[^1]. A poisoned re-upload of any dependency fails the build instead of shipping.
- **Built locally, never pulled.** `speedwave-litellm` is in `build.rs::IMAGES` with `pull_policy: never`, like every Speedwave image.
- **No Admin UI, no database, no virtual keys, no host port.** The proxy is reachable only inside `speedwave_<project>_network`. The entire LiteLLM management plane (the part with the richest CVE history) is never enabled.
- **Worker-class hardening.** `read_only`, `cap_drop: ALL`, `no-new-privileges`, tmpfs `/tmp`, resource caps from `resources.rs::LITELLM_RESOURCES`, and a dedicated `LITELLM_VOLUMES` security rule asserting the mount profile (config `:ro`, tokens `:ro`, usage as the only `:rw`) plus a host-network ban.
- **Version bumps are audited.** Bumping the pin = editing `requirements.in`, regenerating hashes, and reviewing the upstream changelog (procedure documented in the file header).

## Topology: per project, not shared

One `litellm` container per project, inside that project's compose network. A shared instance would require a host port (local exposure of all keys without auth, or virtual keys + Postgres with them), would hold every project's keys in one process, and a settings change in one project would restart streams in all others. Per-project instances exist only while the project runs; the cost is ~512 MiB cap per active project (counted in adaptive VM sizing, ADR-068).

## Provider model (config schema v2)

`LlmConfig` gains `providers: Vec<LlmProviderEntry>` + `active: {provider_id, model}` + `schema_version: 2`. Entry kinds: `anthropic_oauth`, `anthropic_api_key`, `local`, `open_router`, `open_ai_compat`, `custom`. Provider ids are plugin-grade slugs (`^[a-z][a-z0-9-]{0,63}$`) because they become token file names and `SPW_KEY_<ID>` env names.

- **Migration:** v1 flat configs lift on resolve (`migrate_llm_to_v2`): legacy `anthropic` classifies as `anthropic_api_key` iff `secrets/<project>/anthropic_api_key` exists, else `anthropic_oauth`; local aliases normalise to one `local` entry. Idempotent.
- **Downgrade story:** every save also writes derived v1 fields (`sync_llm_legacy_fields`) for one release, so an older Speedwave still reads a usable provider/model pair.
- **SSRF rule kept:** repo `.speedwave.json` can still set `model` only — never providers, base URLs, the active selection, or the kill-switch.

## Authentication per provider kind

| Kind                                  | Route                                   | Auth                                                                         | Notes                                                                                                                                                                                                                                            |
| ------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `anthropic_oauth`                     | `litellm:4000/anthropic` (passthrough)  | Claude Code's own OAuth `Authorization` header, forwarded verbatim           | **No auth env may be injected** — any of `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` disables Claude Code OAuth. Login flow unchanged (ADR-052): OAuth endpoints are hardcoded to api.anthropic.com in Claude Code[^2] and never touch the proxy. |
| `anthropic_api_key`                   | same passthrough                        | `ANTHROPIC_API_KEY` env on `claude` (as today), forwarded as `x-api-key`     | Deliberate deviation from "all keys into litellm tokens": keeping the key client-side preserves `/model` alias + `[1m]` semantics and avoids prefix-routing the Anthropic catalogue. ADR-040's env-visibility residual risk applies unchanged.   |
| `local` / `open_ai_compat` / `custom` | `litellm:4000` (unified `/v1/messages`) | dummy Bearer (`sk-no-key-required`); backend key (if any) via `SPW_KEY_<ID>` | Model is sent as `<provider_id>/<model>` matching the rendered wildcard route; LiteLLM translates Anthropic⇄OpenAI. `ANTHROPIC_SMALL_FAST_MODEL` pins subagent traffic to the same model.                                                        |
| `open_router`                         | `litellm:4000`                          | dummy Bearer; OpenRouter key via `SPW_KEY_OPENROUTER`                        | `openrouter/*` wildcard route.                                                                                                                                                                                                                   |

**The passthrough invariant (validated in the Phase 0 spike):** LiteLLM's `/anthropic` route forwards client headers untouched **only while the proxy itself holds no Anthropic credential** — `get_auth_header` would otherwise override the client's header[^3]. Therefore the litellm container must never see `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` env names; provider keys are exported exclusively as `SPW_KEY_<ID>` by the entrypoint (enforced by a BATS test and the renderer's no-canonical-names test).

**Session granularity:** the provider class is fixed per session. Within a session `/model` switches freely across models _of the configured providers_ (wildcard routes); mixing the subscription with non-Anthropic providers in one session is impossible because the unified root forwards only `x-*` headers, not `Authorization`[^3]. Content-based dynamic routing is explicitly out of scope (future ADR).

**Limitation:** a `local` provider with custom headers falls back to the direct path — headers are addressed to the LLM server and the proxy would consume them.

## Key handling

Values live in `~/.speedwave/tokens/<project>/llm/<provider_id>_api_key` (0600, atomic, validated: `Bearer ` stripped, CRLF rejected); config carries only `has_api_key`. The directory mounts `:ro` at `/tokens`; the entrypoint exports each file as `SPW_KEY_<ID>` (slug re-validated in-container with `LC_ALL=C`, defense in depth). The rendered `config.yaml` references keys as `os.environ/SPW_KEY_<ID>` and never contains values.

## Usage accounting

A custom callback (`litellm_callback.py`, baked into the image) appends one JSON line per request to `/usage/usage.jsonl` — the per-project bind mount `usage/<project>/litellm/`. Two capture paths are required on litellm 1.88.1: success/failure events (non-streaming + streaming passthrough) and the `async_post_call_streaming_iterator_hook` (streamed unified-route requests emit **no** success events from bridged providers — observed on 1.88.1 and 1.89.0rc2; for those, usage rides the final `message_delta` SSE frame)[^4].

Host-side, `speedwave_runtime::usage` aggregates per day/model with `response_id` dedup and 10 MiB rotation. **Source-of-truth split:** the JSONL is the only input to the usage dashboard; the Claude Code result stream (`total_cost_usd`/`modelUsage`) remains the per-session chat statistic. They are never summed — that would double count.

JSONL over SQLite is deliberate: the file crosses the VM boundary on a bind mount (virtiofs/9p), where SQLite locking is unreliable; append-only text degrades to one truncated line on crash, which the aggregator skips and reports.

## Hot reload

`ContainerRuntime::compose_up_service(project, "litellm")` recreates only the proxy after an LLM-settings change (config re-render + targeted `up -d --force-recreate litellm`); the claude container restarts only when its own env changed. Service names are validated against `BUILT_IN_SERVICES` before reaching engine argv.

The full-restart path relies on nerdctl's config-hash convergence, which only recreates services whose compose definition changed — and neither the bind-mounted `/config` files nor the `/tokens` key files are part of that definition, while litellm loads its config and the entrypoint exports keys only at container start. The renderer therefore injects `SPW_CONFIG_DIGEST` (sha256 of every rendered file under `litellm/<project>/` plus key-file metadata — names, sizes, mtimes; never key values) into the litellm service env, making any config, callback or key change a compose-definition change. Image-level changes (Containerfile, requirements, entrypoint, callback source) propagate independently via the per-image build-input hash tags (ADR-072).

## Known noise (pinned version)

litellm 1.88.1 logs a background `pydantic` validation error per streamed translated request (its internal logging bridge; fixed upstream in 1.89.x). Responses and usage capture are unaffected — the iterator hook does not depend on that code path. The pin bump to 1.89.0 stable removes the noise.

## Where it lives in code

- Image: `containers/Containerfile.litellm`, `containers/litellm/{requirements.in,requirements.txt,litellm_callback.py,entrypoint.sh}`
- Compose: `containers/compose.template.yml` (`litellm` service), `compose/mod.rs` (mount dirs + substitution), `resources.rs::LITELLM_RESOURCES`
- Config renderer + keys: `compose/litellm.rs`; token namespace: `compose/tokens.rs` (`llm` service)
- Schema + migration: `config.rs` (`LlmProviderEntry`, `migrate_llm_to_v2`, `sync_llm_legacy_fields`, `proxy_enabled`)
- Routing: `compose/llm.rs` (`apply_llm_config_proxy` / `apply_llm_config_legacy_in`)
- Security: `compose/security_check.rs` (`LITELLM_VOLUMES`), `log_sanitizer.rs` (Google key rule)
- Usage: `crates/speedwave-runtime/src/usage.rs`, desktop `llm_cmd.rs::get_llm_usage`
- Auth gating: desktop `setup_wizard.rs::project_needs_anthropic_auth`
- Per-service recreate: `runtime/mod.rs::compose_up_service` (+ Lima/WSL impls, `LockedRuntime`, mock)

[^1]: pip `--require-hashes` mode: https://pip.pypa.io/en/stable/topics/secure-installs/

[^2]: Claude Code OAuth/admin endpoints ignore `ANTHROPIC_BASE_URL`: https://github.com/anthropics/claude-code/issues/48011

[^3]: LiteLLM passthrough forwards client headers, with proxy-side credentials taking precedence when set; the unified root forwards only `x-*`/`anthropic-beta` headers (`_get_forwardable_headers`): https://docs.litellm.ai/docs/pass_through/anthropic_completion and litellm source `proxy/pass_through_endpoints/llm_passthrough_endpoints.py` (`anthropic_proxy_route`), `proxy/litellm_pre_call_utils.py` (verified against the pinned 1.88.1 wheel in the Phase 0 spike).

[^4]: Bridged-provider streaming logging gap observed empirically in the Phase 0 spike against litellm 1.88.1 and 1.89.0rc2; related upstream auth-precedence issue: https://github.com/BerriAI/litellm/issues/29190
