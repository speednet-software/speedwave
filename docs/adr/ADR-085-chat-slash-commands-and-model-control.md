# ADR-085: Chat UI Slash-Command Allowlist and Composer Model/Effort Control

**Status:** Accepted

**Date:** 2026-07-17

## Context

The chat UI's slash-command popover, model pill, and Claude Code's own slash
dispatcher were three independently-maintained "truths" that disagreed. The
popover's healthy path discovered commands from a throwaway `claude -p`
`system/init` (`crates/speedwave-runtime/src/slash.rs`), its failure path fell
back to a hardcoded 7-entry list (`slash.rs::fallback_discovery`), and badge
classification used a separate hand-maintained 13-name list
(`slash.rs::is_builtin_name`). None of the three matched the live dispatcher
running inside the persistent wire process.

Empirical verification against the pinned Claude Code version (a live dev
container, project `speedwave`, over the exact wire the chat UI uses -
`claude -p --input-format stream-json --output-format stream-json --verbose`)
found the real `system/init` returns 87 commands, of which 4 of the 7
hardcoded fallback entries do not exist in the real dispatcher (`/cost`,
`/help`, `/resume`, `/memory` all either alias to something else or report
"isn't available in this environment"). Conversely, `/model` and `/effort`
are real commands with observed wire behavior that drove the composer design
below.

The composer's model pill was read-only; model selection lived entirely in
the Settings `LlmProviderComponent`, which is one save-form step removed from
the running session and, for non-Anthropic providers, could leave the badge
showing a stale model if the live wire switch failed after the config write
had already committed.

## Decision

### 1. Native command allowlist is a display filter, not an execution gate

A new const table (`crates/speedwave-runtime/src/native_slash.rs`) replaces
both `is_builtin_name` and `fallback_discovery`. Each entry carries `name`,
`description`, `badge` kind, `show: bool`, and (for `/effort` only) an
`Option<&'static [&'static str]>` of levels. The popover displays exactly
`allowlist(show=true) ∩ live_init` - never the allowlist alone, so a CC
version bump that removes a command cannot leave a dead entry visible. A
guard test asserts every `show: true` name is present in the pinned-CC init,
turning a future CC bump that renames or removes an allowed command into a
red test rather than a silent UI lie.

This is a **display filter only**. A user who hand-types any native command

- allowed, hidden, or unknown to the table - still reaches Claude Code
  unmodified; there is no interception layer. Names that are not in the table,
  not plugin-prefixed, not an agent name, and do not resolve to a known
  skill/command/resource file are hidden by default-deny, but still execute if
  typed. `user-invocable: false` is always respected, integration-shipped
  skills included: all 13 current integration skills declare it, so they stay
  hidden by their authors' intent regardless of provenance classification.
  This preserves CLI parity: the product controls what it suggests, never what
  it permits.

### 2. Composer is the single model control; a normalization triad prevents routing bypass

Three distinct id shapes exist for a model and must never be conflated
(`crates/speedwave-runtime/src/model_id.rs`):

- `catalog_id` - the provider-native id shown in the picker (Anthropic:
  the CC-selectable form, may carry the `[1m]` suffix; OpenRouter:
  `anthropic/claude-sonnet-5` shape; Local: whatever `/v1/models` serves).
- `wire_id` - what must be sent to `/model` and what `ANTHROPIC_MODEL`
  carries. `wire_model_id(kind, entry_id, catalog_id)` builds it: unchanged
  for an Anthropic kind, else `"<entry_id>/<catalog_id>"` (no double-prefix
  when the catalog id is already wire-shaped). This matches both the
  renderer's routed-prefix construction
  (`crates/speedwave-runtime/src/compose/llm.rs`, the `Local | OpenRouter`
  arm, `let routed_model = crate::model_id::wire_model_id(entry.kind,
&entry.id, &model);`) and the proxy's routing rule, which resolves a
  backend purely by the string before the first `/`, defaulting to
  `"anthropic"` for a bare id (`containers/proxy/src/router.rs::resolve`:
  `let prefix = match model.split_once('/') { Some((p, _)) => p, None =>
"anthropic" };`). Sending a bare `catalog_id` for a non-Anthropic
  OpenRouter entry (e.g. bare `anthropic/claude-sonnet-5`, which itself
  contains a `/`) would mis-route to the anthropic backend - this is exactly
  the routing-bypass class the id triad exists to prevent.
- `observed_id` - `init.model` as reported back by Claude Code once a
  session (or a `/model` switch) has taken effect; it has the `wire_id`
  shape and is normalized via `normalize_observed(observed, entry_id)`
  (strips one leading `<entry_id>/`, identity on a non-matching prefix)
  before display or comparison.

`wire_model_id`/`normalize_observed` are the one place that owns both
directions of this mapping; no call site hand-builds a routed or displayed
id. Soft-impose and badge-mismatch comparisons always operate on `wire_id`;
the UI always displays `catalog_id`. A TypeScript mirror
(`desktop/src/src/app/chat/composer/model-selector/wire-model-id.ts`) is
cross-read-guarded against the Rust implementation (`wire_model_id_matches_ts`,
`normalize_observed_matches_ts`).

Implementing the triad surfaced and fixed a latent routing bug: the proxy
config renderer (`compose/proxy.rs`) previously derived a route's `prefix`
from a hardcoded per-kind literal (e.g. the literal `"openrouter"`) while
`compose/llm.rs` prefixed the wire id with the provider entry's own `id`; any
entry whose id differed from the literal (a custom-named OpenRouter entry,
for example) had broken routing. The route prefix is now `entry.id` for
every non-anthropic arm, matching `wire_model_id`'s prefix
(`compose/proxy.rs::openrouter_route_prefix_follows_a_custom_entry_id_not_a_hardcoded_literal`
pins the fix; `model_id.rs::custom_provider_slug_prefixes_with_its_own_entry_id`
is the id-triad-side regression for the same bug).

### 3. Session semantics differ per provider kind, matching a real wire constraint

`/model <wire_id>` sent over the wire switches the running session
immediately, with no restart and no session-id change - this is native
Claude Code behavior, not something Speedwave implements. For Anthropic
providers the composer selection is therefore session-only: nothing is
written to project config, matching the config-side removal of the
Anthropic model field (decision 7 below; the renderer already tolerates an
absent model for this provider kind, see the regression test
`update_llm_config_accepts_anthropic_without_model`,
`desktop/src-tauri/src/containers_cmd.rs`).

For local and OpenRouter providers, the composer selection **does**
write-through to the project's config, because the model is also the
session-start default read by `LlmConfig::effective_active_model()`
(`crates/speedwave-runtime/src/config.rs`) - without persisting it, the next
session would silently revert to whatever was last saved in Settings. The
write-through uses a new narrow Tauri command,
`set_provider_model` (`desktop/src-tauri/src/containers_cmd.rs`), that
mutates exactly the `providers[].model` field under the config lock - never
the full-form `update_llm_config`, which validates and saves the entire
settings form and would be a needlessly broad, non-atomic write for a
single-field change triggered from every composer keystroke-driven
selection.

Ordering is durability-first: the config write commits before the live wire
switch is attempted. A failed live switch (provider rejects the model, wire
timeout, etc.) leaves the badge truthful - it is driven only by the next
`system/init` event, never optimistically updated - while the config
already points at the new model for the next session. Rapid repeated
selections serialize through the same command under the config lock; last
write wins.

**Amendment (field-tested first-turn gap): a pre-session Anthropic pick
rides the spawn as `--model`, not a queued wire `/model`.** A wire `/model`
queued before the session exists can only flush once Claude Code is already
processing the first user prompt, so the FIRST reply always ran on the
spawn default while the badge showed the pick (observed live: badge
`claude-fable-5`, first reply `claude-opus-4-8`). Mirroring the `--effort`
launch flag (decision 5 amendment), `start_chat` now accepts an optional
model override consumed from the composer's queued pick
(`ChatStateService.startChatSession`), validated against the catalog
(`defaults::is_selectable_anthropic_model_id`, `[1m]` aliases only where
`has_1m()`) and appended as `--model` in `ChatSession::prepare_args`. The
pick is consumed synchronously at spawn, so the SystemInit flush cannot
double-send a wire `/model`; no control chip renders, correctly - the
session STARTED on that model, nothing switched. Wire `/model` remains the
mechanism for live mid-session switches and their queue survives session
start unchanged for picks made while a session is already spawning.

Claude Code's transcript JSONL records a `/model` (or `/effort`) send as an
ordinary user message; it carries no Speedwave-assigned UUID on the way out
(`build_user_message`, `desktop/src-tauri/src/chat.rs` - UUIDs are learned
only from the CC echo, per ADR-046) and no `system` role exists in
`ChatMessage.role` (`models/chat.ts`, `user | assistant` only). A live-only
suppression approach - hiding the message only in the live stream - would
therefore resurface the raw `/model x` line after every resume, since
history reconstruction (`history.rs`) replays the same transcript with no
sidecar state to consult.

The chosen rule is pure content shape, applied identically live and during
history reconstruction: any user message matching
`^/(model|effort)\s+\S+$` (`parse_control_command`) renders as a system chip
(e.g. "model -> Sonnet 5"). A hand-typed `/model x` gets the identical
treatment - this is truthful, since Claude Code executed it as a command
either way, and it means there is exactly one rendering rule to maintain,
not two code paths that must stay in sync. Chips are excluded from
conversation previews and unread counts, and the ADR-046 retry-anchor picker
skips chip messages when proposing retry targets (a chip's own transcript
UUID remains a valid anchor; it merely is not surfaced as a target).

Two empirical wire facts shaped the live-side mechanics. First, the desktop
wire emits no user-echo events in a tool-free session (no
`--replay-user-messages`), so live detection hooks the send side: `chat.rs`
matches the outgoing text before writing to stdin and emits
`StreamChunk::ControlChip` (uuid `None` at emission; a later user-type event
with a matching id commits via the existing `UserMessageCommit` path).
Second, even with `--include-partial-messages` (which the desktop passes),
a synthetic confirmation turn (`message.model == "<synthetic>"`) emits zero
`stream_event` lines, so its text can never reach the delta arm that renders
live text - **no live-suppression mechanism exists or is needed** for that
confirmation; a regression test pins this contract. Consequently, on the
send side, `sendMessage` skips the optimistic bubble append for
control-shaped text (`isControlShaped`, TS mirror of
`chat.rs::is_blank_or_slash_only`-adjacent logic, cross-read-guarded) and the
emitted `ControlChip` chunk is the sole rendered message, preventing a
double-render.

Soft-impose at session start (local/OpenRouter): after spawn, if normalized
`observed_id != wire_id(configured)`, the client silently injects
`/model <wire_id>`; the parser recognizes the injected text and fully
suppresses that one live chip (a debug log records it instead). After
resume, the injected message renders as a normal chip like any other -
the transcript cannot distinguish it from a user-typed one, so it is not
special-cased there.

### 5. Effort control: the launch hold, and its release for live wire control

Empirically, sending `/effort <level>` over the wire is refused whenever a
launch-effort pin already exists in the project's Claude Code
`settings.json` (`effortLevel`), which Claude Code itself writes on its own
TUI `/effort` usage and on its own settings updates. The measured refusal
text: `"Not applied: the launch-effort pin holds effort at high this
session. Run /effort low in an interactive terminal"` - `settings.json` was
left unchanged by the refused attempt. `SystemInit` carries no effort field
at all, so there is no live structured source to read a current-session
effort from. This matches Claude Code's own documentation: a non-interactive
`/effort` "can't release the model-default hold" on Fable 5/Opus 4.8/Opus
4.7 and reports `Not applied`[^1], and more generally `low`/`medium`/`high`/
`xhigh` persist across sessions only when set in an _interactive_ session[^1].

**Amendment (same change, deeper empirics): the hold is releasable at spawn,
so the control is live after all.** Further in-container probes against the
pinned Claude Code build showed the refusal is NOT tied to the settings-file
pin: with `effortLevel` absent entirely, a non-interactive `/effort` was
refused with the identical "launch-effort pin holds effort at high" message
(high = the premium model default). The releasing lever is the `--effort
<level>` launch flag ("Effort level for the current session", `claude
--help`): a session spawned with an explicit `--effort` accepts wire
`/effort` changes live ("Set effort level to <level> (this session only)"),
and Claude Code records per-model release flags (`unpinOpus48LaunchEffort`
etc.) in `~/.claude.json`, after which even flag-less sessions accept live
changes.

The shipped design therefore: every chat spawn passes `--effort <pin>`
(`chat.rs::launch_effort_level`: the persisted pin, else `high`), which both
sets the launch effort and releases the hold; the composer effort control
persists the pin (`effort_pin::set_effort_pin`, next sessions) AND applies
the level to the CURRENT session with a wire `/effort` routed through the
control-command path (`ChatStateService.applyEffortSelection`) - queued when
a turn is streaming, flushed at turn end, rendering the standard control
chip. Persistable levels remain exactly `low`, `medium`, `high`, `xhigh`
(`effort_pin::PERSISTABLE_EFFORT_LEVELS`) - Claude Code's settings-file
contract accepts only these four, since `max` and `ultracode` are documented
as session-only[^1]. A hand-typed `/effort <level>` in chat remains
pass-through; Claude Code's own reply renders unmodified. The control is
rendered only for Anthropic provider kinds. Level-vs-model capability
mismatches are Claude Code's own concern (an unsupported level is silently
clamped per-model[^1]).

### 6. Proxy effort/thinking-field translation: verified, not dropped

Design work leading into this ADR carried a provisional expectation that the
proxy "drops" effort/thinking fields in translation for non-Anthropic
providers. Reading the actual forwarding code
(`containers/proxy/src/forward.rs::messages` and `strip_model_prefix`)
during implementation shows this is not accurate: the proxy parses the
request body once (`serde_json::from_slice`) only to read the `model` field
and resolve a route (`router.rs::resolve`); `strip_model_prefix` rewrites
only that `model` field when the resolved route carries an id prefix
(`if let Some((_, bare)) = model.split_once('/') { ... }`), and the
resulting `outbound_body` - everything else in the parsed JSON, unchanged -
is forwarded byte-for-byte to the upstream provider (`req =
client.post(&upstream_url).body(outbound_body)`). There is no proxy code
path that inspects, drops, or rewrites an `effort`/`thinking` field anywhere
in `containers/proxy/src` (confirmed by inspection - the only other
`thinking` occurrence in the crate is an unrelated streaming-token field
name in `usage.rs`). Concretely: since the composer's effort control is
rendered only for Anthropic provider kinds (decision 5), no effort-carrying
request body is ever generated for a non-Anthropic route in the first
place, so this fact is currently inert for the effort feature itself - it
is recorded here because it is the actual, verified behavior of the
forwarding path, correcting an unverified guess before it could calcify
into an assumed invariant elsewhere.

### 7. Anthropic-native entries stop storing a configured model

`ANTHROPIC_MODEL` is no longer written for anthropic-native provider
entries; any previously stored value is cleared by a one-time self-heal at
config load (`LlmConfig::clear_active_anthropic_model`, following the
existing `quarantine_foreign_anthropic_models` pattern in
`crates/speedwave-runtime/src/config.rs`) and on every settings save
thereafter. This follows directly from decision 5: since the composer sends
full model ids (including `[1m]` CC-selectable forms) directly over the
wire, and model/effort changes for Anthropic are session-scoped by design,
there is no config-side model to keep in sync.

With no model configured anywhere, Claude Code resolves an account-type
default. Anthropic's own documentation states: "Max, Team Premium,
Enterprise pay-as-you-go, and Anthropic API: defaults to Opus 4.8" and "Pro,
Team Standard, and Enterprise subscription seats: defaults to Sonnet
5"[^1] - identical resolution in the TUI and in headless mode. The
precedence order for setting a model, highest first, is: an in-session
`/model` switch, then the `--model` flag or `ANTHROPIC_MODEL` environment
variable (session-scoped), then a `model` value in managed/user/project/
local settings, with an organization default (Claude Code v2.1.196+, when
an admin has configured one) and the account-type default as the two
fallback tiers when nothing else applies[^1].

Alias envs `ANTHROPIC_DEFAULT_SONNET_MODEL`/`ANTHROPIC_DEFAULT_OPUS_MODEL`
are honored by the wire (verified: `/model sonnet` resolved to
`claude-sonnet-5[1m]` via the baked env) and continue to exist for typed
aliases only - the composer itself never needs them, since it always sends
a full id. A previously planned `ANTHROPIC_DEFAULT_FABLE_MODEL` alias
addition for anthropic-native entries was dropped after a direct wire test
showed Claude Code does not honor it there: with the env set to
`claude-fable-5[1m]`, `/model fable` still resolved the bare
`claude-fable-5` id, unaffected by the env. This is consistent with
Claude Code's own alias-resolution table, which lists only `opus` and
`sonnet` as resolving differently per provider/version and does not name
`fable` as configurable via that family of env vars for the Anthropic API
column[^1]. The env remains part of the _non-Anthropic_ routed-alias remap
(`compose/llm.rs`), which is a distinct mechanism: it points the alias at
the already-prefixed `wire_id`, not at a bare Claude model name, so Claude
Code's own alias resolution never has to look the real id up.

### 8. Auto-default rules for fresh non-Anthropic setups

To keep the "model required for non-Anthropic providers" invariant from
ever tripping on a fresh setup, an auto-default is applied at the moment a
provider is saved, not deferred to first use: saving an OpenRouter provider
with no model stores `anthropic/claude-sonnet-5` (OpenRouter's confirmed
catalog id[^2] for the current-generation Sonnet model, at 1M-context
standard pricing); saving a local provider with no model stores the first
model reported by the existing discovery probe, and the save fails with a
clear error if the probe itself fails and no model was supplied. Repo
`.speedwave.json`'s model suggestion (`apply_repo_model_suggestion`,
`crates/speedwave-runtime/src/config.rs`) stops applying to Anthropic
entries - an Anthropic-native entry has no model field left to suggest a
value into.

## Anthropic model catalog facts backing this ADR

- `[1m]` is Claude Code's own model-alias/model-name suffix syntax for the
  1M-context session-window variant of a model, not a distinct upstream API
  billing id: on the Anthropic API, Sonnet 5 always runs with the 1M window
  with no `[1m]` variant to select and no premium versus the 200K range,
  while Fable 5, Opus 4.8, and Opus 4.7 likewise always run at 1M on the
  Anthropic API; the `[1m]` suffix exists for `opus`/other models where the
  1M window is not the unconditional default, and "the 1M context window
  uses standard model pricing with no premium for tokens beyond 200K"[^1].
  The catalog's `[1m]`-suffixed entries exist purely to expose the
  CC-selectable variant distinctly, so the session window shown to the user
  matches what Claude Code will actually use for that selection.
- Legacy ids `opus-4-6`, `opus-4-7`, and `sonnet-4-6` (`claude-opus-4-6`,
  `claude-opus-4-7`, `claude-sonnet-4-6`) are listed as **Active** with no
  retirement date on Anthropic's model-deprecations page as of this
  writing[^3]; `opus-4-1` (`claude-opus-4-1-20250805`) is Deprecated with a
  retirement date of August 5, 2026[^3] and is not carried in this catalog.
  The three active legacy entries stay in the catalog for historical
  usage-cost attribution with `selectable: false` - they never appear in
  the composer picker, but a manually typed `/model <full-legacy-id>` still
  reaches Claude Code unmodified, which errors account-appropriately if the
  id is truly gone.
- Sonnet 5's introductory API pricing of $2/$10 per million input/output
  tokens is in effect through August 31, 2026, after which standard pricing
  of $3/$15 per million tokens takes effect[^4] - a pricing bump is
  scheduled in the catalog around that date.
- Whether access to a specific current-generation model name is ever
  plan-exclusive on a claude.ai subscription is **not fully verified** by
  this ADR: Anthropic's feature-availability documentation lists
  _feature_ access by plan (Code Review, Analytics, SSO, etc.) but does not
  tabulate model-name access by plan, deferring instead to the model
  configuration page[^1], which documents only account-type default
  resolution and Fable 5's own gating (not available under zero data
  retention, and gated by a live server-side availability check on
  `/model fable` rather than a static plan list[^1]). The composer
  therefore does not pre-filter its catalog by plan; Claude Code's own
  account-aware `/model` is the runtime authority and surfaces an explicit
  error or fallback if a selection is genuinely unavailable to the account.

## Consequences

- One place to change a model in chat: the composer, with truthful,
  init-driven badge state and no code path that can send a mis-routed bare
  id for a non-Anthropic provider.
- Effort control is honestly next-session, communicated as such, instead
  of silently failing against an existing launch pin the way a naive
  `/effort` pass-through would.
- Control messages are visible, auditable regular transcript entries
  (as chips) rather than a hidden channel that could resurface
  inconsistently after resume.
- The slash popover can never show a dead command or omit a live one for
  longer than the discovery cache's staleness window, because its
  allowlist is intersected with the real init on every discovery, not
  trusted alone.
- Settings loses its Anthropic model selector entirely; Anthropic model
  choice lives only in the composer, for the current session.

[^1]: Claude Code model configuration - default model resolution and precedence order (`/model`, `--model`/`ANTHROPIC_MODEL`, settings, org default, account-type default), per-plan account defaults, the `[1m]` context-window suffix, effort-level persistence and settings-file constraints (`low`/`medium`/`high`/`xhigh` only), and Fable 5's own availability gating. https://code.claude.com/docs/en/model-config

[^2]: OpenRouter model catalog entry for Claude Sonnet 5, confirming the `anthropic/claude-sonnet-5` id and 1M-context standard pricing. https://openrouter.ai/anthropic/claude-sonnet-5

[^3]: Anthropic API model deprecations page - status table showing `claude-opus-4-6`, `claude-opus-4-7`, and `claude-sonnet-4-6` as Active with no retirement date, and `claude-opus-4-1-20250805` as Deprecated with retirement date August 5, 2026. https://platform.claude.com/docs/en/about-claude/model-deprecations

[^4]: Anthropic API pricing page - Claude Sonnet 5 introductory pricing ($2/$10 per MTok through August 31, 2026) and standard pricing ($3/$15 per MTok) thereafter. https://platform.claude.com/docs/en/about-claude/pricing
