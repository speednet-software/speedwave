# ADR-088: Chat UI Slash-Command Allowlist and Composer Model/Effort Control

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

**Amendment (SPEED-539: the Anthropic pick becomes persistent via
`settings.json`, reversing "session-only" above).** Claude Code's own
settings documentation gives the `model` key a scope of "Any file" and
tells an external tool exactly what to do when Claude Code itself cannot
persist a pick for it: "Set the key in the tool that generates the
file"[^5]. The same key is read "only once, at session start" - identically
in `-p` mode, since nothing in the non-interactive path re-reads it
mid-session[^5][^6]. `ChatStateService.applyModelSelection` now writes the
picked `wire_id` into the project's claude-home `settings.json` under
`model` (`pin_cmd::set_model_pin`, delegating to the new
`claude_settings::set_model_pin`, sharing `set_effort_pin`'s locked
read-modify-write) before any live action, so the write's success gates the
wire switch - a failed write surfaces in the composer and neither the wire
nor a respawn proceeds. This supersedes the field-tested amendment above and
the machinery it introduced: the pre-session `--model` spawn flag and the
SystemInit-flushed queue existed only to cover the FIRST reply before a
session existed, and a written pin now covers that identically, because the
next spawn (interactive or `-p`) reads the file directly. Decision 3's
mid-session mechanics (wire `/model`, control chips, soft-impose) are
unchanged - only the no-session case changes: since Desktop already spawns
an idle Claude process eagerly, at app init and on "+"
(`ChatStateService.init`/`startNewConversation` call `startChatSession()`
before any message exists), a no-session pick writes the pin and respawns
that idle process so its first reply reads the file fresh, instead of
carrying `--model` on the override queue.

**Amendment (SPEED-544: the deferred `--model`/`model_override` removal
above is done - the idle respawn is now the only pre-first-turn
mechanism).** `ChatSession::prepare_args`/`start`/`start_with_retry` and the
`start_chat` Tauri command no longer take a model override parameter at
all, so the spawn argv never contains `--model` regardless of whether a
`settings.json` pin exists - pinned tests cover both the absent- and
present-pin case. The `is_selectable_anthropic_model_id` validation that
used to gate the override moved with the parameter and is gone from
`chat.rs`; the predicate itself stays, since `claude_settings::set_model_pin`
still validates a written pin against the same catalog.
`ChatStateService.startChatSession` no longer reads or clears
`_pendingModelOverride` before a spawn, and the `SystemInit` handler no
longer flushes it - the mid-session queue (unchanged from the SPEED-539
amendment) now flushes exclusively on `Result` (turn end), never on
`SystemInit`, closing the residual risk of a stale queued pick re-sending
`/model` into a session the file pin already started on the right model.
`resetForNewConversation` now clears the queue itself, so `resumeConversation`'s
own explicit clear (redundant now, since it already calls
`resetForNewConversation`) was removed - a pick queued for an old,
still-streaming turn cannot leak into whatever session starts next. `setPendingModelOverride` had no callers outside the service and its
own spec by this point, so it was inlined rather than kept as a shim.

**Amendment (SPEED-545 rig finding, 2026-09-14: history rebuilds the chip
from Claude Code's synthetic command entry).** The transcript never holds the
typed `/model x` line the history rule above matched on: Claude Code records
an executed control command as a synthetic user entry
(`<command-name>/model</command-name>`, `<command-message>`,
`<command-args>x</command-args>`), followed by a `system` entry rather than a
`<synthetic>` assistant turn, and `history.rs` dropped that entry as
synthetic noise together with `/clear` and the local-command markers. A
resumed conversation therefore lost every `/model` and `/effort` chip, which
spec 20's resume-survival assertion caught on the Windows rig.
`parse_jsonl_message` now rebuilds the typed line from the `<command-name>`
and `<command-args>` bodies (`control_command_from_synthetic_entry`) before
the synthetic skip, and only when `parse_control_command` accepts the result,
so the shape rule stays the single SSOT: `/clear`, an argument-less `/model`
(the picker) and multi-word arguments remain dropped, previews and unread
counts still exclude the rebuilt line, and the live path is untouched.

**Amendment (SPEED-657, 2026-09-21: a routed pick with no live session
re-renders the compose, the only carrier the next spawn reads).** For local
and OpenRouter providers the picked model reaches Claude Code exclusively as
container environment burned in at compose render (`ANTHROPIC_MODEL` plus the
`ANTHROPIC_DEFAULT_*` family, `crates/speedwave-runtime/src/compose/llm.rs`),
and per the SPEED-544 amendment above the session spawn carries no `--model`
at all. The config write-through therefore reached nothing already running:
the idle-respawn branch of `ChatStateService.applyModelSelection` was gated on
the provider being Anthropic, so a pick made before the first turn (the
session id exists only once the first stream chunk arrives) persisted to
`config.json` while the running container kept the previously rendered model,
and the turn failed against a model the badge no longer showed. Soft-impose
does not cover this case: it fires on `system/init`
(`chat.rs::maybe_soft_impose`), which Claude Code emits when it is already
processing the first prompt, so it repairs the second turn onwards and never
the first - the same first-turn gap the Anthropic side closed with the
`settings.json` pin. The routed branch now applies the pick the way Settings
has applied one since `model` became part of `computeActiveKey`
(`desktop/src/src/app/settings/llm-provider/llm-provider.component.ts`):
`ProjectStateService.restartContainers()` (`restart_integration_containers`,
which re-renders the compose and recreates the containers), followed by the
same idle respawn. A restart that fails, and one already in flight, both
surface in the composer with no respawn behind them, so the silent no-op
cannot return through a second entry point. A live session still takes the
wire `/model` (the proxy routes on the id prefix,
`containers/proxy/src/router.rs`) and a mid-stream pick still defers its
override; neither restarts a container.

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

**Amendment (Claude Code 2.1.267 re-verification):** the same probes on the
2.1.267 pin reproduce the behaviour above unchanged, so the design holds. Two
refinements: the hold covers Opus 4.8 and Fable 5 but NOT Fable 5.1 or Sonnet
5, whose sessions accept a wire `/effort` even without a launch flag; and
`maxEffortLevel` (new in 2.1.267) is a settings key an organization can use to
cap the level, which the composer control does not yet read.

The shipped design therefore: every chat spawn passes `--effort <pin>`
(`chat.rs::launch_effort_level`: the persisted pin, else `high`), which both
sets the launch effort and releases the hold; the composer effort control
persists the pin (`claude_settings::set_effort_pin`, next sessions) AND applies
the level to the CURRENT session with a wire `/effort` routed through the
control-command path (`ChatStateService.applyEffortSelection`) - queued when
a turn is streaming, flushed at turn end, rendering the standard control
chip. Persistable levels remain exactly `low`, `medium`, `high`, `xhigh`
(`claude_settings::PERSISTABLE_EFFORT_LEVELS`) - Claude Code's settings-file
contract accepts only these four, since `max` and `ultracode` are documented
as session-only[^1]. A hand-typed `/effort <level>` in chat remains
pass-through; Claude Code's own reply renders unmodified. The control is
rendered only for Anthropic provider kinds. Level-vs-model capability
mismatches are Claude Code's own concern (an unsupported level is silently
clamped per-model[^1]).

**Amendment (SPEED-538, 2026-09-13: the effort carrier moves to the Speedwave
project config; the shipped design above is superseded).** A fresh session now
carries no `--effort` flag at all, so Claude Code applies the model's own default
effort (`high`, `xhigh` on Opus 4.7)[^1] exactly as a bare Claude Code session
would. A composer pick persists as `ProjectUserEntry::effort_pin` in the user
config, one of `defaults::EFFORT_LEVELS` (`low`, `medium`, `high`, `xhigh`,
`max`), written under the config lock by `pin_cmd::set_effort_pin`; every spawn
of a project with a pin passes exactly one `--effort <pin>`
(`chat.rs::launch_effort_level` returns `Option`). The carrier left Claude
Code's `effortLevel` key for two documented reasons: that key accepts only
`low`..`xhigh` while `--effort` also takes `max` (cli-reference: "Options:
`low`, `medium`, `high`, `xhigh`, `max`, or `ultracode`"), and since Claude Code
2.1.257 the launch flag releases the premium hold only for that session
(model-config: "Leaves the hold in place for later sessions: `--effort` at
launch"), so the flag has to travel with every spawn anyway - the
`unpinOpus48LaunchEffort`-style persistence described in the earlier amendment
no longer applies. A legacy `effortLevel` written by earlier builds of this
branch is taken over once (`claude_settings::take_legacy_effort_pin` via
`pin_cmd::ensure_effort_pin_migrated_in`, run before every spawn and by
`get_effort_pin`) and the key is removed from the file. Ordering in
`ChatStateService.applyEffortSelection`: pin write first, wire `/effort` second
(queued when a turn is streaming); a failed write blocks the wire and surfaces
in the composer; with no live session the eagerly spawned idle pre-first-turn
process is respawned so the first reply honours the pin (the same rule as the
persistent model pick, decision 3 amendment). Speedwave never sets
`CLAUDE_CODE_EFFORT_LEVEL`: it outranks both `--effort` and the wire `/effort`
(env-vars.md) and compose bakes env in at container create; the renderer guard
`assert_no_effort_level_forced` pins that.

**Amendment (2026-09-15: an empty conversation respawns instead of taking the
wire).** A process spawned without `--effort` keeps the launch hold described
above and refuses a live `/effort`, and that refusal never reaches the chat: the
control chip is emitted from the outgoing line (`chat.rs::send_message_with_emit`)
and Claude Code's synthetic confirmation is not rendered. The accepted gap therefore
cannot rely on the verbatim reply. `ChatStateService.applyEffortSelection` now
respawns whenever the conversation is still empty (`hasConversation()` false),
live session or not, so the pin reaches the new process as `--effort` at launch.
A pick while any turn streams, including a first turn whose session id has not
arrived yet, is queued and wired when the turn ends. A pick in a non-empty
conversation still takes the wire, so the gap remains only for a session that
switched to a hold model before its first effort pick. Both idle-respawn paths
(model and effort) claim `initialized` like `startNewConversation`, so a remounted
chat view cannot start a second session over the respawned one.

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

**Amendment (SPEED-539: account-type default table correction).** The
"Opus 4.8" default cited above is out of date. Claude Code's model
configuration page states today: "Max, Team Premium, Enterprise, and
Anthropic API: defaults to Opus 5" and "Pro and Team Standard: defaults to
Sonnet 5", noting "Before v2.1.219, `default` resolved to Opus 4.8 on the
Anthropic API, Max, Team Premium, and Enterprise pay-as-you-go from
v2.1.154"[^5]. The pinned Claude Code build (`defaults.rs::CLAUDE_VERSION`)
is well past 2.1.219, so **Opus 5**, not Opus 4.8, is the correct
account-type default for Max/Team Premium/Enterprise/API today; Sonnet 5
remains correct for Pro/Team Standard. This is a factual correction only -
decision 7's own conclusion (no Anthropic model configured anywhere, so
Claude Code resolves whichever account-type default applies) is unchanged.
Separately, SPEED-539 gives the composer's own pick a persistent home again
(the `settings.json` `model` key, see the amendment under decision 3 above);
once a pin exists it outranks both the organization default and the
account-type default at every subsequent spawn, exactly as the precedence
order already stated in this decision predicts.

**Amendment (SPEED-648: the `opus` alias is no longer pinned for Anthropic
kinds).** `defaults.rs::anthropic_default_models_env` pinned
`ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5[1m]` next to the SONNET and
HAIKU pins. That pin is plan-dependent: Claude Code's model configuration
page lists Opus with 1M context as "Included with subscription" on Max, Team
and Enterprise, as "Requires usage credits" on Pro, and as "Full access" on
API and pay-as-you-go, and states that with the `[1m]` suffix "the 1M context
window applies to all usage of the pinned alias, including the plan-mode Opus
phase of `opusplan` and subagents whose `model` frontmatter names the
alias"[^1]. On a Pro account the pin therefore forced every `opus` alias
resolution onto a window that needs usage credits. A capture of the pinned
Claude Code 2.1.267 on a Max account
(`desktop/src-tauri/tests/fixtures/cc-2.1.267-control-responses.sanitized.json`,
`run_A` with the pins, `run_B` without) shows what the pins change: without
them `default` still resolves to `claude-opus-5[1m]`, `opus` and `sonnet`
resolve to the bare 200k ids, and `haiku` resolves to the dated
`claude-haiku-4-5-20251001`. The OPUS entry is removed; SONNET keeps `[1m]`
(the same page states that Sonnet 5 needs "no usage credits required on any
plan"[^1]) and HAIKU keeps the undated catalog id. The non-Anthropic
routed-alias remap in `compose/llm.rs` is unchanged and still covers all four
aliases.

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

**Amendment (SPEED-555: the auto-default probe is preceded by a UI
connection test, and a missing Messages API blocks Save).** Once the
composer became the only model picker (decision 8's own premise - Settings
carries no model selector), the Settings discovery button's old name
("discover models") stopped matching what it does: there is no model list
left to populate by hand. It is renamed `test connection` on both the local
card and the OpenRouter row
(`desktop/src/src/app/settings/llm-provider/llm-provider.component.ts`) and
becomes a save gate rather than an optional convenience. `saveConfig` for a
routed active provider (local, OpenRouter) computes a fingerprint of the
connection fields (`base_url` + key state for local; key state alone for
OpenRouter, via `localConnectionFingerprint`/`extraKeyFingerprint`) and
probes only when no passing test is on record for that exact fingerprint
and the fields differ from the last-persisted configuration
(`needsConnectionProbe`); a save whose fields are unchanged from disk never
re-probes, and editing `base_url` or the key invalidates the recorded
result. A probe that fails - including a local server that returns a model
list but does not answer `POST /v1/messages` - blocks the save outright: no
`update_llm_config` call, no proxy reload, no container restart. The prior
behavior ("Save is allowed, but chat will fail") is removed; a missing
Messages API is exactly as fatal to Save as an unreachable server or a
rejected key. OpenRouter's success criterion stays narrower than the local
card's: the catalog endpoint accepting the key is sufficient, and the
presence of the auto-default model (`anthropic/claude-sonnet-5`) in that
catalog response is never checked. The connection-test state (does a
passing result exist for the current fingerprint) is component memory only:
it is not persisted, and a provider switch, project switch, or reload
clears it. The success line names the model new sessions will actually
start on after this Save. When the provider entry already carries a model,
that model is named: a composer pick persists into the entry through
`set_provider_model` (`desktop/src-tauri/src/containers_cmd.rs`), and Save
passes the entry model through untouched, so the auto-default of this
section never applies to it. Only an entry without a model gets the
auto-default named instead: for local the first probed model, the same
value `ModelAutoDefaultProbe::first_local_model` (same file) picks; for
OpenRouter the `OPENROUTER_DEFAULT_MODEL` constant
(`crates/speedwave-runtime/src/consts.rs`), read through the
`get_openrouter_default_model` Tauri command, never a literal in Angular.
A Save issued while a button-triggered test is still running joins that
test (`discoverExtraModels` hands back the in-flight promise) and gates on
its outcome; it never skips the gate or silently does nothing.

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
- Sonnet 5 costs $2/$10 per million input/output tokens. That price was
  announced at launch as introductory pricing through August 31, 2026;
  Anthropic's pricing page now states that it "is now the standard price"
  and that the increase to $3/$15 per million tokens scheduled for
  September 1, 2026 "will not occur"[^4], so the catalog's
  `SONNET_5_PRICING` needs no change.
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

**Amendment (SPEED-641, ADR-089: `[1m]` handling, plan awareness and the
legacy rows).** Three statements of this section no longer describe the
product; they stay above as the record of what was known when this ADR was
written, and ADR-089 carries the current decision. First, the `[1m]` bullet
describes the Anthropic API, not a Speedwave session: a capture of the
pinned Claude Code 2.1.267
(`desktop/src-tauri/tests/fixtures/cc-2.1.267-control-responses.sanitized.json`)
shows every bare id, Sonnet 5 and the Fable models included, running with a
200k window and only `<id>[1m]` running with 1M. Every session routes
through the per-project proxy, and the model configuration page documents
that case for Sonnet 5: with `ANTHROPIC_BASE_URL` pointing at an LLM gateway
"Claude Code can't verify 1M support"[^1] and budgets the window at 200K;
the capture shows the same for every other model. The catalog no longer
exposes a `[1m]` variant as a separate picker entry: the composer
shows one row per model and `defaults.rs::anthropic_wire_model_id` picks the
bare or the `[1m]` id from the catalog's `one_million_context` attribute and
the account's plan, and no user-visible string carries `[1m]` or `(1M)`.
Second, the composer is now plan-aware in two ways: for Anthropic providers
its rows come from the model list Claude Code reports for the signed-in
account over the `initialize` control request, with the static catalog as
the fallback, and the 1M window is chosen by plan as above. Claude Code's
`/model` stays the runtime authority for a selection the account cannot
use. Third, the `selectable` field is gone: the legacy entries are appended
to the composer picker after the rows Claude Code lists, so a past model
stays selectable without typing its id.

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
  choice lives only in the composer, persisted via the `settings.json`
  `model` pin (SPEED-539 amendment) and applied to the current session over
  the wire.

[^1]: Claude Code model configuration - default model resolution and precedence order (`/model`, `--model`/`ANTHROPIC_MODEL`, settings, org default, account-type default), per-plan account defaults, the `[1m]` context-window suffix, effort-level persistence and settings-file constraints (`low`/`medium`/`high`/`xhigh` only), and Fable 5's own availability gating. https://code.claude.com/docs/en/model-config

[^2]: OpenRouter model catalog entry for Claude Sonnet 5, confirming the `anthropic/claude-sonnet-5` id and 1M-context standard pricing. https://openrouter.ai/anthropic/claude-sonnet-5

[^3]: Anthropic API model deprecations page - status table showing `claude-opus-4-6`, `claude-opus-4-7`, and `claude-sonnet-4-6` as Active with no retirement date, and `claude-opus-4-1-20250805` as Deprecated with retirement date August 5, 2026. https://platform.claude.com/docs/en/about-claude/model-deprecations

[^4]: Anthropic API pricing page - Claude Sonnet 5 at $2/$10 per MTok, announced as introductory pricing through August 31, 2026 and since confirmed as the standard price; the previously scheduled increase to $3/$15 per MTok on September 1, 2026 will not occur. https://platform.claude.com/docs/en/about-claude/pricing

[^5]: Claude Code settings - the `model` key's "Any file" scope, "Set the key in the tool that generates the file" guidance for a pick that must survive when Claude Code itself cannot persist it, and the account-type default model table ("Max, Team Premium, Enterprise, and Anthropic API: defaults to Opus 5"; "Pro and Team Standard: defaults to Sonnet 5"; "Before v2.1.219, `default` resolved to Opus 4.8"). https://code.claude.com/docs/en/settings and https://code.claude.com/docs/en/model-config

[^6]: Claude Code settings - "Claude Code reads some keys only once, at session start, so an edit to one of them doesn't reach the running session," naming `model` among them; `/model` in `-p` mode "applies to the current session only and isn't saved as your default." https://code.claude.com/docs/en/settings and https://code.claude.com/docs/en/model-config
