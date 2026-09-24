# ADR-089: Claude Code's Control Channel as the Source of Truth for Anthropic Models, Context and Plan Limits

> **Status:** Accepted
> **Date:** 2026-09-18
> **Context:** For Anthropic providers the Desktop chat answered four questions from the wrong place. The model picker came from the static catalog (`defaults.rs::ANTHROPIC_MODELS`), rendered two rows per model and spelled one model three ways. The `limit` meter read `rate_limit_event.utilization`, which most events do not carry and the rest report as a 0-1 fraction, so it showed 0% or 1%. The context meter fell back to a fabricated 200k window before the first result, after a resume and after a model switch. The effort stops came from a hand-maintained table. The pinned Claude Code answers all four authoritatively over stream-json control requests on the chat process Speedwave already runs (ADR-006, ADR-088).

## Decision

### 1. Control requests go to the long-lived chat session process only

`desktop/src-tauri/src/control_channel.rs::ControlChannel` is a request/response primitive on the chat process that `chat.rs::ChatSession` spawns. A request is `{type: "control_request", request_id, request: {subtype, ...}}` on stdin; the answer is `{type: "control_response", response: {subtype: "success" | "error", request_id, response | error}}` on stdout. Every request gets a unique id, a waiter in a pending map and its own timeout (`ControlQuery::timeout`). The stdout reader routes a `control_response` to its waiter before the stream parser sees the line (`chat.rs::consume_control_response`). An unknown id is logged at debug level and dropped, a timeout or a rejected request becomes an error for that caller only, and a stopped or dead process fails every waiter at once. The reader thread never waits on anything, so the message stream cannot stall. The Tauri commands release the session mutex before they wait (`chat_session_cmd.rs::control_query_inner`), so a control request never blocks `send_message`. The existing `interrupt` flow is untouched.

A new short-lived `claude` process per query is ruled out: every extra start-up while the access token is expired is another chance of the OAuth refresh race recorded in ADR-052, and Speedwave never reads Anthropic credentials to work around it.

Proxy-routed providers (local, OpenRouter) send no control request: the backend sends `initialize` only when the session's provider kind is Anthropic (`chat.rs`), and Angular asks for usage and context only for Anthropic kinds (`chat-state.service.ts::refreshControlData`). For a routed provider Claude Code would report its own assumptions, not the provider's, so their model list and context window stay on the discovery probe of ADR-041.

**Amendment (SPEED-696, 2026-09-24: one control request for routed sessions).** A proxy-routed session now sends exactly one control request: `set_model`. It goes out when the first `system/init` reports a model other than the configured one (the soft-impose of ADR-088, amendment SPEED-696). The request changes the session and reads no data from Claude Code, so the reason above does not apply to it. Routed sessions still send no `initialize`, `get_usage` or `get_context_usage`. `ControlChannel::send_set_model` writes the request under the stdin lock the caller already holds, because the soft-impose must see a user's `/model` written first. The answer is awaited on a thread of its own (`chat.rs::report_soft_impose`), so the reader still never waits.

### 2. The requests used and the fields read

| Request                                      | When                                                                                                                                  | Fields read                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize`                                 | once, right after an Anthropic session spawns                                                                                         | `models[]`: `value`, `resolvedModel`, `displayName`, `description`, `supportsEffort`, `supportedEffortLevels`; `account`: `subscriptionType`, `apiProvider`  |
| `get_usage` with `skip_behaviors: true`      | subscription sign-in only: after `initialize` answers, after every finished turn, on every `rate_limit_event`, when the popover opens | `subscription_type`, `rate_limits_available`, `rate_limits`: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `model_scoped[]`, `extra_usage` |
| `get_context_usage` with `detail: "summary"` | after `initialize` answers (fresh or resumed session), after every finished turn, when the popover opens                              | `model`, `totalTokens`, `maxTokens`, `percentage`, `categories[]`: `name`, `tokens`, `isDeferred`                                                            |

The Agent SDK reference documents the same operations as `initializationResult()`, `supportedModels()`, `accountInfo()` and `getContextUsage()`, and states that with `detail: 'summary'` "No token-count requests go out, and the per-category numbers are approximate"[^2]. The structs read only fields that the Agent SDK types for the pinned version declare: `@anthropic-ai/claude-agent-sdk` 0.3.267 declares `claudeCodeVersion` 2.1.267[^3]. Unknown keys are ignored, because the real `get_usage` payload carries many undeclared keys. `account.email` and `account.organization` are never read, so they cannot reach the frontend (`control_channel.rs::account_never_carries_identity_fields`). Nothing is polled on a timer.

The parsed `initialize` result is kept by the session and pushed to Angular as the `chat_session_info` event with three states (`pending`, `ready`, `unavailable`); `get_plan_usage` and `get_context_usage` are pull commands. `ClaudeControlService`, `ModelPickerService` and `PlanUsageService` are the Angular side. Every mirrored type has an `include_str!` cross-read test.

### 3. The pinned binary is the source of truth over the public docs

The capture `desktop/src-tauri/tests/fixtures/cc-2.1.267-control-responses.sanitized.json` holds real responses of the pinned Claude Code 2.1.267 on a Max account, once with the container environment as compose renders it and once without the `ANTHROPIC_DEFAULT_*_MODEL` pins. In it every bare model id (`claude-opus-5`, `claude-sonnet-5`, `claude-fable-5-1` and every legacy id) reports a 200k window and only `<id>[1m]` reports 1M (`control_channel.rs::pinned_binary_gives_bare_ids_200k_and_only_the_1m_suffix_one_million`).

The model configuration page says that on the Anthropic API "Sonnet 5 always runs with the 1M context window. There is no 200K variant"[^1]. The same page documents our case for Sonnet 5: when `ANTHROPIC_BASE_URL` points at an LLM gateway "Claude Code can't verify 1M support" and budgets the window at 200K unless the 1M form is selected, and in that configuration Claude Code "doesn't check your plan's usage credits" because "the gateway decides whether the request succeeds"[^1]. Every Speedwave session routes through the per-project proxy (ADR-073), so Claude Code treats it as a gateway session. The page does not spell the 200K budget out for the other models with a 1M window; the capture shows it for all of them. The docs and the measurement agree once the gateway is taken into account, but the measurement came first and found it.

Two rules follow. When the docs and the pinned binary disagree, the binary wins, and the question is settled by measurement, never by assumption. And the capture is part of the Claude Code bump ritual: `control_channel.rs::fixture_is_the_capture_of_the_pinned_claude_code` fails until the fixture's `claude_code_version` equals `defaults.rs::CLAUDE_VERSION`, and the parser tests over the new capture show what changed.

The plan labels were measured the same way. The strings of the pinned binary, whose SHA256 matches the release manifest[^4], map the subscription type to exactly `Claude Enterprise`, `Claude Team`, `Claude Max`, `Claude Pro` and the default `Claude API`; the binary was read, never executed. `defaults.rs::AnthropicPlan::from_claude_code` accepts those labels and the `get_usage` ids (`pro`, `max`, `team`, `enterprise`); anything else is an unknown plan. A session whose provider kind is an Anthropic API key is treated as API billing without asking Claude Code (`model_picker.rs::plan_for`).

### 4. `get_usage` is experimental: accepted risk, degrade to hidden

The Agent SDK types mark the request as experimental: the query method is named `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` and its notice reads "this API is unstable and may change or be removed in any release"[^3]. The Agent SDK reference does not list it[^2]. Speedwave accepts that risk because it is the only structured source of the data behind `/usage`. The guard is the degrade path: `rate_limits_available: false`, `rate_limits: null`, a rejected or timed-out request and a payload whose typed fields do not parse all mean "no limits", and nothing renders. A window without a utilization, or whose `resets_at` has passed, is not reported. Missing data is hidden, never shown as 0%.

`rate_limit_event` stays a status signal only. Its `utilization` is a 0-1 fraction that most events omit; the backend turns it into a percent and ignores a value outside 0-1, and the UI uses the event solely to mark the ring while a warning or a rejection is current and to trigger a `get_usage` read.

### 5. One row per model; Speedwave picks the 1M window by plan, invisibly

The picker is one flat list: the `initialize` rows grouped by canonical id (`defaults.rs::canonical_anthropic_model_id`: `resolvedModel` without `[1m]` and without a snapshot date) in Claude Code's order, followed by the legacy catalog rows Claude Code does not list. A current-generation model absent from Claude Code's list is not offered. A model the catalog lacks shows Claude Code's `displayName` without its 1M decoration. The row of Claude Code's `default` entry carries a `Default` badge; picking it clears the `settings.json` model pin and sends `/model default`, which the model configuration page defines as the "Special value that clears any model override"[^1]. While `initialize` is pending the picker is disabled; when no list arrives the static catalog is the fallback.

Because a bare id and its `[1m]` form are different sessions, one function chooses the wire id: `defaults.rs::anthropic_wire_model_id(catalog_id, plan)`, driven by the catalog attribute `one_million_context`:

| Catalog models                       | 1M included on                     | Source                                                                                                                               |
| ------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Sonnet 5, Fable 5.1, Fable 5         | every plan                         | "models with a native 1M window, such as Sonnet 5 and the Fable models"; for Sonnet 5 "no usage credits required on any plan"[^1]    |
| Opus 5, Opus 4.8, Opus 4.7, Opus 4.6 | Max, Team, Enterprise, API billing | plan table: Opus with 1M context is "Included with subscription" on Max, Team and Enterprise and "Requires usage credits" on Pro[^1] |
| Sonnet 4.6                           | API billing only                   | "requires usage credits on every subscription plan, including Max"; "Full access" on API and pay-as-you-go[^1]                       |
| Haiku 4.5                            | never                              | not among the models the page lists as supporting a 1M window[^1]                                                                    |

An unknown plan keeps a plan-dependent model on the bare id. An existing pin is normalized to the id the policy picks once the plan is known (`model_picker.rs::normalized_pin`); alias pins are left alone. `set_model_pin` accepts every id the picker can produce and rejects everything else. Behind the proxy Claude Code itself does not check usage credits (decision 3), so this table is what keeps a Pro account off a paid Opus 1M window.

No user-visible string in the Desktop contains `[1m]` or `(1M)`: one label function (`ModelPickerService.label`) serves the picker, the composer pill, message metadata and the `/model` chip, live and rebuilt from history.

The effort slider follows the same source: a row Claude Code lists carries its `supportedEffortLevels` (none without `supportsEffort`), legacy rows and the fallback carry the catalog table, and the slider order is `defaults.rs::EFFORT_LEVELS` shipped with the rows.

**Amendment (SPEED-663, 2026-09-22: the picker rows have one source, and the catalog supplies none).** Field-tested on the 0.18.1 dev build: changing the effort level with no live conversation respawns the chat session (`ChatStateService.applyEffortSelection`, then `startChatSession`), and while it respawned the picker turned from the four rows Claude Code had listed, with descriptions and the `Default` badge, into the nine-row catalog with the retired models, no descriptions and no badge. The window is structural. `chat_session_cmd.rs::start_session_inner` swaps the old session out under the session mutex and stops it (`ChatSession::stop` resets the info slot to `Unavailable` without emitting an event), then holds the mutex through `ChatSession::start`, which emits `pending` only after the process has spawned; `chat_session_cmd.rs::session_info_state_inner` reads a failed `try_lock` as `Unavailable`. Angular still held the previous `ready` state, so the badge stayed enabled while `list_model_picker` answered from the catalog, and the `source` field that named the swap was read by nothing. The sentences of this decision that allowed it, "followed by the legacy catalog rows Claude Code does not list" and "when no list arrives the static catalog is the fallback", and in decision 6 "the legacy rows" and "the whole list whenever Claude Code reports none", are superseded as follows.

- The rows have exactly one source: the `initialize` list of the live session. `model_picker.rs::build_picker` takes a `SessionInfo` and yields `None` for an empty list; `list_model_picker` returns `null` until the session reports its models, which covers an idle session, the respawn window above, and a failed or timed-out `initialize`. The catalog supplies no row in any state (`catalog_picker`, `catalog_row` and `PickerSource` are removed), and no legacy catalog row is appended to the list, which `successful_initialize_does_not_restore_models_claude_code_omits` had already pinned.
- `ModelPickerService.refresh` keeps the rows it already holds when the backend reports `null` or fails, and returns the rows held afterwards, so `rowFor`, `label` and the effort stops keep working on the last known list through a respawn. With nothing held the combobox says "Model list unavailable." with Retry (`model-selector.component.ts::fetchOptions`), never a substitute list.
- The catalog is metadata: `family` for labels, pricing, `one_million_context` for the wire id, `default_effort`, and the per-model `effort_levels` the slider falls back to for the current model while no rows are held (`effortStops` in `model-selector.component.ts`). Label precedence for any id, in `ModelPickerService.label`: the catalog `family`; else the `display_name` Claude Code listed, which `model_picker.rs::listed_row` keeps on the row only for an id the catalog lacks; else the id without its `claude-` prefix, snapshot date and `[1m]` suffix.
- `set_model_pin` validation is unchanged: a wire id the live session listed, else any catalog id bare or with `[1m]` where the model has a 1M window (`defaults.rs::is_selectable_anthropic_model_id`). Residual: a model the catalog lacks, picked from the held rows while the session has not answered, is rejected as unknown until the session reports it again.

Guards: `picker_offers_no_rows_until_the_session_reports_its_models` and `an_empty_model_list_yields_no_picker` in `model_picker.rs`; the held-rows and nothing-known specs of `model-picker.service.spec.ts`; the "Model list unavailable", last-known-rows and Retry specs of `model-selector.component.spec.ts`.

### 6. What the static catalog still owns

`defaults.rs::ANTHROPIC_MODELS` remains the source of truth for model names (`family`), pricing, the legacy rows, the default effort, the `one_million_context` policy attribute, and the whole list whenever Claude Code reports none. It is no longer the source of which models an account is offered, of effort stops for listed models, or of any context window: `AnthropicModelsService.contextTokensFor` is deleted, and `DEFAULT_CONTEXT_TOKENS` is never used for an Anthropic session.

### 7. Context window

`get_context_usage` is the source of used tokens, the window and the categories for Anthropic sessions, including before the first message and after a resume. `result.modelUsage[model].contextWindow` stays the fallback when the request fails; a `/model` chip forgets the window until the next answer; with nothing known the ring is hidden. The `Free space` category is dropped at the command boundary, and categories flagged `isDeferred` are not drawn because they are not in the context.

## Consequences

- One row per model, clean names, a plan-aware window and real limits for subscription users; API-key users see the context section only.
- A Claude Code bump now includes a capture step, enforced by a failing test.
- The Desktop depends on an experimental request for one feature. If Anthropic removes or reshapes `get_usage`, the plan section disappears and nothing else breaks.
- A Pro account never lands on a paid Opus 1M window through the picker, even though Claude Code itself does not check usage credits behind the proxy.
- The catalog must still be maintained at every model launch: a model Claude Code lists but the catalog lacks is offered under Claude Code's display name, without pricing, and on the bare id whenever Claude Code lists one (`model_picker.rs::listed_row`).
- Only a Max capture exists. What Claude Code lists for a Pro account and for an API key is unverified; the policy for those plans rests on the model configuration page[^1] and on the plan labels read from the binary.

## Rejected alternatives

- **A short-lived `claude -p` process per query.** Simple, but each start-up risks the OAuth refresh race (ADR-052).
- **Reading Anthropic's usage endpoint or rate-limit headers from the host or the proxy.** It would need the OAuth token, which Speedwave never reads, or would only see thresholds, not utilization.
- **Keeping the catalog as the model list.** It cannot know the account, and its 1M flag is wrong for a bare id on the pinned binary.
- **Showing both window variants.** The product owner decided on one row per model; the window is an implementation detail Speedwave can choose correctly from the plan.

[^1]: Claude Code model configuration: the `default` value, extended context by model and plan (plan table for Opus and Sonnet 4.6), the `[1m]` suffix, the Sonnet 5 context window, and the LLM-gateway behaviour for 1M context and usage credits. https://code.claude.com/docs/en/model-config

[^2]: Agent SDK reference, TypeScript: `Query` methods `initializationResult()`, `supportedModels()`, `accountInfo()`, `setModel()` and `getContextUsage()` with the `detail` option. https://code.claude.com/docs/en/agent-sdk/typescript

[^3]: `@anthropic-ai/claude-agent-sdk` 0.3.267: package metadata with `claudeCodeVersion` 2.1.267 (https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.267) and the type definitions declaring the `initialize`, `get_usage` (experimental) and `get_context_usage` control requests and responses (https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.267/sdk.d.ts).

[^4]: Claude Code 2.1.267 release manifest with the per-platform binary checksums. https://downloads.claude.ai/claude-code-releases/2.1.267/manifest.json
