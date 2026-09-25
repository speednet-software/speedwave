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
does not cover this case: it fires on the `system/init` line
(`chat.rs::soft_impose_step`), which arrives inside the first turn, so its
repair lands no earlier than the second one - the field-tested first-turn gap
recorded in the first amendment above (badge `claude-fable-5`, first reply
`claude-opus-4-8`), which the Anthropic side closed with the `settings.json`
pin. The routed branch now applies the pick the way Settings
has applied one since `model` became part of `computeActiveKey`
(`desktop/src/src/app/settings/llm-provider/llm-provider.component.ts`):
`ProjectStateService.restartContainers()` (`restart_integration_containers`,
which re-renders the compose and recreates the containers), followed by the
same idle respawn. A restart that fails, and one already in flight, both
surface in the composer with no respawn behind them, so the silent no-op
cannot return through a second entry point - `restartContainers` reports
which of the three outcomes it reached, so a restart it never started is not
read back through the `restartError` of an older one. A failed restart
additionally raises the standing restart prompt (`requestRestart`), because
the config write commits first and the badge is read back from it, so the one
state where a saved model outlives the container it never reached must stay
visible and one click from being retried. A live session still takes the
wire `/model` (the proxy routes on the id prefix,
`containers/proxy/src/router.rs`) and a mid-stream pick still defers its
override; neither restarts a container.

**Amendment (SPEED-669, 2026-09-24: the pick also stores the model's context
window).** `set_provider_model` no longer mutates only `providers[].model`: it
also takes the picked row's discovered window and writes it to the same
entry's `context_tokens`. A known window is stored; a pick of a different
model whose window is unknown clears the stored one, since it belonged to the
previous model; re-picking the same model without a window keeps it. The
window reaches Claude Code the way the model does, as container environment
(`CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `crates/speedwave-runtime/src/compose/llm.rs`),
so a pick with no live session applies it through the re-render above, while
a live-session wire `/model` leaves the running container on the previous
window until its next render.

**Amendment (SPEED-696, 2026-09-24: a model switch on a live session is a
`set_model` control request, not a `/model` input).** Speedwave writes two
switches into a live chat process: the soft-impose above and the composer
pick of decision 3. Both wrote `/model <id>` to Claude Code's stdin as a user
input. That had three defects, found on the e2e rig and confirmed with the
pinned 2.1.267 binary driven against a stub API:

1. **A `/model` written while a turn uses a tool never runs.** Claude Code
   does not run the queued input as a command.
   - `desktop/src-tauri/tests/fixtures/cc-2.1.267-model-command-mid-tool-turn.sanitized.ndjson`
     holds the stdout of a run that wrote it at the first `init` of such a
     turn; the input itself is not part of the file. No command answer
     follows, and both `init` lines, the later turn's included, report the
     old model.
   - A composer pick deferred to a turn end landed in the same place when the
     backend had already started a queued message at that turn end
     (`chat.rs::drain_queued_message`).
2. **An executed `/model` answers as an input of its own.**
   - `desktop/src-tauri/tests/fixtures/cc-2.1.267-model-picks.sanitized.ndjson`
     ends with one typed into an idle session. The answer is an `init`, a
     `<synthetic>` "Set model to `Haiku 4.5` for this session only" and a
     `result` with `num_turns: 0`. The confirmation names the model's family,
     not the id that was written.
   - The stdout reader emitted that `result` like any turn end. A message the
     user sent before it arrived had its turn ended by it, and the chat
     listener (`chat-state.service.ts::setupStreamListener`) then dropped that
     turn's answer. This failed spec 13 on the macOS rig.
3. **The soft-impose could switch a user's pick back.** The decision compared
   the observed model with the configuration read at spawn. Claude Code emits
   `system/init` for every input it starts, a local command included, so a
   composer pick made after the spawn was switched back at the next input.

Writing the soft-impose only when a turn ends fixes the first defect but not
the second: behind a message sent right after Stop, or queued before the
command, the command still runs as an input the chat does not expect, and a
later Stop can interrupt it instead of the user's turn.

Both switches are now `set_model`, the control request behind the Agent
SDK's `Query.setModel()`. The SDK types describe the method as changing "the
model used for subsequent responses", and the request type says that an
omitted, null or `default` model "resets to the session default model"[^7].

- **The soft-impose.** On the first `system/init` whose model differs from
  the configured wire id, the reader sends it once per session
  (`chat.rs::soft_impose_step`). A rejected or unanswered request is logged,
  and the session stays on the model from the container environment.
- **A composer pick on a live session.** It goes through
  `chat_session_cmd.rs::switch_chat_model`, which sends the request and waits
  for the answer without holding the session mutex (`chat.rs::ModelSwitch`).
  Angular adds the `/model` chip once Claude Code confirms
  (`chat-state.service.ts::switchLiveModel`), and no turn starts in the chat.
  A pick made while a turn streams or a session starts is still deferred to
  the turn end or the start's completion. It then applies to whatever turn
  Claude Code is running, from its next model request. The default row sends
  `set_model` with `default`: in the capture Claude Code confirms the account
  default (`claude-opus-5[1m]` in the stub run), and the next `init` reports
  it.
- **What Claude Code does with it.** Claude Code handles a control request
  outside its input queue. The capture
  `desktop/src-tauri/tests/fixtures/cc-2.1.267-soft-impose.sanitized.ndjson`
  sends it at the first `init` of a tool-using turn:
  - the answer arrives before the turn's next model response;
  - the request after the tool result already goes to the new model, and the
    next `init` reports it;
  - no `init`, `<synthetic>` line or `result` belongs to the switch;
  - the only other line is a `user` line whose content is a
    `<local-command-stdout>` string, and the stream parser makes no chunk of
    it.

  Nothing is withheld from the chat, and the switch does not interact with
  Stop or with queued messages.

- **The transcript.** Claude Code records the switch the way it records an
  executed `/model`: a caveat, `<command-name>/model</command-name>` with its
  arguments, and the confirmation. These entries follow the turn that was
  running. A conversation rebuilt from history therefore shows the `/model`
  chip between those turns
  (`history.rs::a_set_model_switch_is_rebuilt_as_a_model_chip_between_the_turns`,
  which uses the captured entries).
- **Settling.** A pick settles the session's model (`ModelSettled`), as does a
  `/model` the user types, which still goes to Claude Code as an input. Both
  settle it under the stdin lock, and the soft-impose checks and settles it
  under the same lock before it writes, so a pick written first always wins.
- **ADR-089 decision 1.** It said proxy-routed providers send no control
  request. Besides `interrupt` on Stop, they now send this one. `set_model`
  changes the session and asks Claude Code for no data, so the reason routed
  sessions send no query does not apply (see the ADR-089 amendment of the
  same date).

The first-turn gap recorded above now covers only the model requests Claude
Code sends before it applies the switch: at least the first request of the
first turn. The three captures are pinned to the Claude Code version.
`the_soft_impose_captures_are_of_the_pinned_claude_code` fails on a bump until
they are re-captured.

**Amendment (SPEED-709, 2026-09-24: the captures move to Claude Code 2.1.282).**
The three captures were recorded again from the 2.1.282 binary and are now named
`cc-2.1.282-*`. The `cc-2.1.267-*` paths above name the files they replaced. What
2.1.282 changes:

- **Defect 1 turned into defect 2.** A `/model` written at the first `init` of a
  tool-using turn now runs after that turn, as an input of its own. The turn ends on
  the old model; then the command answers with its own `init`, a `<synthetic>`
  "Set model to ... for this session only" and a `result` with `num_turns: 0`; and
  the next `init` reports the new model
  (`cc-2.1.282-model-command-mid-tool-turn.sanitized.ndjson`,
  `chat.rs::a_model_command_written_during_a_tool_using_turn_runs_after_it_as_an_input_of_its_own`).
  An input the chat does not expect ends the user's turn, so both switches stay
  `set_model` requests. `/effort` behaves the same way: in the 2.1.282 recording of
  the `apply_flag_settings` contract (`cc-2.1.282-apply-effort.sanitized.json`,
  `effort_command_mid_tool_turn`) an `/effort low` written at the same point answered
  after the turn with a `result` of `num_turns: 0`, and the next turn carried `low`.
- **`set_model` is unchanged in the stream.** The soft-impose capture still shows the
  switch applied from the tool-using turn's next model request, no `init`,
  `<synthetic>` line or `result` of its own, and one `<local-command-stdout>` user
  line before the control response, in the same order as on 2.1.267.
- **`set_model` now checks the new model.** Before it answers, Claude Code sends the
  new model a request that is not streamed and asks for one token (`max_tokens: 1`),
  and it answers with an error when that request fails. The stub run of the model
  picks received it for `set_model` with `claude-haiku-4-5` and none for `default`
  (`cc-2.1.282-model-picks-requests.sanitized.json`,
  `chat.rs::set_model_checks_a_catalog_id_with_a_one_token_request_and_default_with_none`). On a Max account `set_model` with `claude-sonnet-4-6[1m]` was refused with
  `API error: 429 Usage credits are required for long context requests · model not
changed` (ADR-089, SPEED-709 amendment). A refused composer pick keeps the
  session on its model, is not saved, and shows the error in the composer (next
  amendment).
- **The account default moved.** The default row's `set_model` with `default` now
  confirms `claude-opus-5-5[1m]` in the stub run (`cc-2.1.282-model-picks.sanitized.ndjson`),
  where 2.1.267 confirmed `claude-opus-5[1m]`.
- **A settings-writing request can now write effort, and Speedwave does not use
  it.** `update_settings` already existed in the 0.3.267 SDK types, for the local
  settings file only. The 0.3.282 types add a `userSettings` source that takes
  `effortLevel` and saves it as the default for the session's current model, "under
  modelSettings as /effort saves it", and state that `apply_flag_settings`, by
  contrast, "only touches the session-scoped flag layer"[^9]. `effort_pin` stays the
  only store (decision 5, SPEED-707 amendment), so Speedwave never sends
  `update_settings`.
- **The launch hold is gone.** Claude Code 2.1.280 "Changed Opus 4.7, Opus 4.8 and
  Fable 5 to stop holding their launch-default effort over `/effort` in `-p` or the
  Agent SDK, a project, managed or `--settings` `effortLevel`, or a per-model
  level"[^10]. This is why the first `apply_flag_settings` on 2.1.282 records no
  `unpin…LaunchEffort` flags in `.claude.json`. The same release "Changed an effort
  level saved before `/effort` became per-model to no longer apply to newly released
  models such as Opus 5.5"[^10]; Speedwave's `--effort <pin>` still applies to every
  model.
- **Pro accounts now default to Opus.** Claude Code 2.1.280 "Changed the default model
  on Pro and Team Standard plans from Sonnet to Opus, matching Max, Team Premium, and
  Enterprise"[^10]. A project without a model pin on such an account moves from
  Sonnet to Opus 5.5 with this bump.
- **The IDE bridge needs no change.** 2.1.282 carries the MCP `server/discover`
  version probe, and `bridges/ide_bridge.rs` answers every method it does not know
  with JSON-RPC error -32601. The negotiation code in the pinned binary treats any
  error answer to `server/discover` other than its unsupported-version error as a
  server that predates the probe and falls back to `initialize`, and its default
  negotiation mode sends no probe at all. A stub run of the `-p` stream-json
  session, with a valid IDE lock file, opened no IDE connection on 2.1.282 or on
  2.1.267: the binary connects to an IDE only from its interactive UI, so only a
  session in the terminal reaches the bridge.

**Amendment (SPEED-709, 2026-09-25: a live model pick is saved once Claude Code
accepts it).** Decision 3 saved a pick before the switch. Since `set_model` can
refuse a switch (previous amendment), that order left the pin or the provider config
on a model the session had refused, and the next spawn launched with it; a model that
needs usage credits then fails every turn. A pick that goes to a running process is
now sent first and saved after Claude Code's answer
(`chat-state.service.ts::sendModelToSession`). `switch_chat_model` answers
`control_channel::ModelSwitchOutcome`:

- `confirmed`: the pick is saved and the `/model` chip is added.
- `refused`: nothing is saved. The composer shows Claude Code's reason, and the badge
  goes back to the pick the session confirmed last in the same conversation, or to
  the model the session reported before. A `system/init` reported after that
  confirmation replaces it, since it names the model the turn runs on (a typed
  `/model` switches the model without naming its id). A refusal answered after the
  chat moved to another conversation is only logged.
- `unconfirmed`: no answer within `control_channel::SET_MODEL_TIMEOUT`, raised from
  10 s to 15 s. Claude Code gives its one-token request about 5 s: against a stub that
  answered after 20 s, after 70 s or never, `set_model` answered 5.4 s after it was sent
  with `Couldn't confirm model "<id>" with the API. Try again, or run /model to see
available models.` and `error_code: check_failed`, which is a refusal. A model the
  upstream must load first, as a local server does on its first request, can therefore
  be refused and picked again once it is loaded. The pick is saved on `unconfirmed`,
  since a late answer may still apply it, and the composer says the session did not
  confirm it.
- An error (no live process, a session another command holds, a failed write): the
  pick is saved for the next spawn and the error is shown.

A pick that reaches no running process is still saved before it is taken: an idle
chat saves it and respawns, a routed pick after a compose re-render. A pick queued
while a turn streams or a session starts is saved when it is taken, or when it is
dropped, so the next spawn still launches with it; every spawn first waits for the
model picks in flight (`ChatStateService.modelPicksSettled`). Model picks go to the
session one at a time, in pick order. A pick that a newer one supersedes before its
turn is neither sent nor saved, and only the newest pick reports an error; a failed
re-render is reported by the newest pick whose save went through. Effort
picks keep their order (decision 5): `apply_flag_settings` does not check the level
with a model request, so it cannot refuse one.

**Amendment (SPEED-709, 2026-09-25: the soft-impose goes out before the first turn,
and a switch that does not apply is shown).** On 2.1.282 the soft-impose sent at the
first `init` makes Claude Code check the configured model while the first turn's
first request to the launch model is still open: a stub run recorded the one-token
check 0.1 ms after that request arrived, with the request open for another 3 s. A
server that swaps models on one GPU then serves two models at once, and the check
can be refused, which only a log line recorded. The session start therefore reads
the claude service's `ANTHROPIC_MODEL` from the rendered compose
(`compose::rendered_service_env_in`) and, when it differs from the configured model,
sends `set_model` before the first user message. A thread of its own waits for the
answer and then opens the session's first-turn gate (`chat.rs::FirstTurnGate`):
`start_chat` and `resume_conversation` wait on it before they return and
`send_message` before it writes, each with the session mutex released, since no Tauri
command holds that mutex while it waits (ADR-089). The recording
`cc-2.1.282-set-model-check.sanitized.json`
shows the switch applied there: the one-token check went to the new model, the
first `init` reported it, and the first turn's request carried it; a refused check
(404, `error_code: catalog_unknown`) left the launch model. The first-turn gap of the
earlier amendments is closed for this case. When the rendered compose cannot be read,
the soft-impose falls back to the first `init`. Either way a soft-impose that is
refused, gets no answer or finds no process emits `chat_model_switch_failed`
(`control_channel::ModelSwitchFailedEvent`), and the composer of that project shows
Claude Code's reason; it is not retried, since a retry at the next `init` would race
a turn again.

A typed `/model` goes to Claude Code as an input (decision 3), and 2.1.282 checks it
the same way. The same recording shows its answer: a `<synthetic>` assistant line,
`Set model to \`Haiku 4.5\` for this session only` when the check passed, and the
error text (`API error: 429 ... · model not changed`) when it did not, followed by a
`result`with`num_turns: 0`and`is_error: false`in both cases. The stream parser
drops every`<synthetic>`line, so a refused typed`/model`looked applied. The stdout
reader now shows the reply to a typed`/model`as an error block when it does not start
with`Set model to` (`chat.rs::refused_model_command`). The chip stays, since it shows
what the user typed.

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

**Amendment (SPEED-664, 2026-09-22: the bundled settings template stops seeding
`effortLevel`, and the migration removes the key whether or not a pin exists).**
Two defects kept a second effort store alive on disk, and only together do they
explain the observation that opened the ticket: on a dev instance every project's
`settings.json` carried `effortLevel` `high` regardless of its pin, one of them
next to an `effort_pin` of `low`.

The first is the bundled template `containers/claude-resources/settings.json`,
which has shipped `"effortLevel": "high"` since the statusline change (#430),
predating this decision's SPEED-538 amendment. `containers/entrypoint.sh` merges
the template under the container's own file (`Object.assign({}, tmpl, cur)`) and
rewrites it whenever a template key is missing from it, pinned by the entrypoint
test "merges new template keys into existing settings.json without overwriting
user values". So the template re-seeded the key at every container start, and
Claude Code read `high` for any project without a pin, silently overriding the
SPEED-538 rule that an unpinned project gets the model's own default effort
(`high` everywhere except Opus 4.7's `xhigh`, `defaults::ANTHROPIC_MODELS`). The
template no longer carries the key; `tests/claude_settings_template_guard.rs`
fails if it, or a `model` default, comes back.

The second is the takeover gate: `pin_cmd::ensure_effort_pin_migrated_in`
returned before `take_legacy_effort_pin` whenever the project already had an
`effort_pin`, so the removal half could never run for exactly the projects where
the two values could disagree. No Desktop chat session reads the stale key,
because every Desktop spawn passes `--effort <pin>`, but a spawn path that drops
the flag would apply the file's level under a composer showing the pin, and one
such path exists today: the CLI, below. The migration now strips the key on every
run for a registered project and adopts its value only when the project has no
pin; with a pin the value is discarded, never reconciled, because the composer
writes the pin before the wire `/effort`
(`ChatStateService.applyEffortSelection`) and so the pin is never older than a
value Speedwave caused. Unregistered projects and an unreadable file are left
alone as before.

**Both halves are Desktop-only, and the CLI is out of scope of this decision.**
`--effort <pin>` is pushed in `chat.rs::prepare_args` and the migration lives in
`desktop/src-tauri/src/pin_cmd.rs`; `crates/speedwave-cli` depends only on
`speedwave-runtime`, so `crates/speedwave-cli/src/main.rs` spawns Claude Code with
`config::resolve_project_config`'s flags alone, which never carry `--effort`. A
CLI session therefore gets Claude Code's own default effort, or whatever
`effortLevel` the user set interactively in a CLI session, which Claude Code
persists to the settings file[^1] and honours on the next one. That is coherent
for a CLI-only project, which has no composer and no pin the user could have set.
It is incoherent for a project used from both surfaces: the CLI ignores the
Desktop pin, and a level set from the CLI sits in the file until Desktop next
opens that project, which then adopts it when there is no pin or discards it when
there is. Carrying the pin into the CLI spawn means lifting both halves into
`speedwave-runtime`; it is not done here and is tracked separately.

Three residuals inside Desktop. An `effortLevel` written while a session runs
survives until the next spawn or `get_effort_pin` of that project. On an existing
install the template's `high` is still in the file at upgrade time, so the first
migration run for a project that has no pin adopts it as one: that preserves the
level the user experiences today, at the cost of recording a template default as
an explicit pick and of holding Opus 4.7 at `high` instead of its `xhigh`
default.

The third is the write itself. `take_legacy_effort_pin` is a read-modify-write of
the whole file behind Speedwave's `.settings.json.lock`, which Claude Code does
not take, so a Claude Code write landing between the read and the rename is lost,
and not only for `effortLevel`. This is the hazard `set_model_pin`,
`clear_model_pin` and `normalize_model_pin` already carry on the same file; the
migration widens it only as far as its writes go, and those are bounded: the
function returns before writing when the key is absent, so once the template stops
seeding it and one pass has stripped it, every later call is a locked read.

**Amendment (SPEED-650, 2026-09-22: a pick in a process that holds its launch
effort is deferred to the next session, with an explicit restart).** This closes
the gap the 2026-09-15 amendment accepted, the second of the two outcomes the
ticket allowed. Each spawn records whether `prepare_args` passed `--effort`
(`desktop/src-tauri/src/chat.rs`, `PreparedSpawn::with_effort`, stored on the
`ChatSession`), and `ChatSession::takes_wire_effort` is true only for a live
process that launched with it.
`desktop/src-tauri/src/chat_session_cmd.rs::get_chat_takes_wire_effort` takes the
start lock (`START_SERIALIZE`) and then the session lock, so a start through
`start_session_inner`, including the window where it has swapped in an empty
session and stops the old process, is waited out and never read as a hold. A retry
(`retry_cmd.rs`) does not take the start lock, but it streams, so the frontend
queues a pick until it ends. Before wiring a composer pick into a live conversation,
`ChatStateService.applyEffortToConversation`
(`desktop/src/src/app/services/chat-state.service.ts`) asks. A process that takes
the wire gets the wire `/effort`, as before. For any other process, and for a
failed check, the pin is saved and the chat shows "Effort <Level> applies from the
next session" with a Restart now action (`ChatStateService.restartForDeferredEffort`).
The action resumes the conversation through `resumeConversation`, so the new
process launches with `--resume <session>` and `--effort <pin>`, and it names the
cost: restarting stops the session's background tasks.

Why no automatic respawn. A first version respawned the process in place without
asking, and two local reviews found that design racy by nature. A retry
(`retry_cmd.rs`) and a project rebind (`project_cmd::rebind_chat`) replace the
session without the start lock. A non-terminal `Error` chunk ends the frontend's
streaming state while Claude Code keeps working on the turn. A restart that fails
after the process was stopped leaves the next send to open a fresh conversation.
Above all, it stops what a Claude Code process keeps between turns (background
Bash tasks, monitors, subagents) whenever the user moves a slider. A restart the
user asks for keeps that cost visible and reuses the existing resume path.

Timing. A pick is queued and applied at the next turn end while a turn streams or
a session starts or resumes, and a pick made during a resume is applied as soon as
the resume completes. Each pick carries a sequence number, so only the latest one
is wired or shown. A turn end without a session id holds the pick until one
arrives. A turn that ends in an API error (an `is_error` result) now releases
pending picks as a `Result` does: the backend marks that `Error` chunk `turn_ended`
(`chat.rs::StreamChunk::Error`) and the frontend flushes the pending model and
effort picks on it. Every other `Error` chunk (a system message that can arrive
mid-turn, a stream that ended) leaves the picks queued.

The condition is the launch flag, not the model. The hold is per model (the 2.1.267
re-verification above: Opus 4.8 and Fable 5, not Fable 5.1 or Sonnet 5), but a
model list would drift with every Claude Code bump, and a session can switch
models on the wire after it spawned; the flag is a fact Speedwave decided itself.
The cost is one notice the first time an unpinned project changes effort
mid-conversation, also on a model without the hold. No Speedwave code path clears
an effort pin (`desktop/src-tauri/src/pin_cmd.rs` only sets one or adopts a legacy
`effortLevel`), so every later spawn of the project carries `--effort` and the
notice does not return. Not measured: whether a process launched with `--effort`
on one model keeps accepting a wire `/effort` after a wire `/model` switch to a
hold model; the probes above do not cover a model switched to after launch. The
model-config page[^1] no longer describes the hold at the time of this amendment.
If a later Claude Code pin drops it, the notice stays truthful (the session keeps
its level until it restarts) and is merely no longer needed.

Two residuals predate this change and are not fixed by it. The frontend ends its
streaming state on every `Error` chunk, including a system message that can arrive
mid-turn, so for the rest of such a turn a pick is wired instead of queued and
Restart now is enabled. And Restart now inherits the failure mode of every resume:
when the new process fails to start after the old one was stopped, the next send
recovers with a fresh `start_chat`, not a resume, under the old history. The notice
itself is cleared by every spawn the frontend starts (a start, a resume, a retry,
and the send recovery), since each of those launches with the pin.

**Amendment (SPEED-707, 2026-09-24: a composer pick reaches a live session as an
`apply_flag_settings` control request).** Speedwave no longer writes `/effort` into
a live chat process and no longer asks whether the process launched with
`--effort`. `ChatStateService.sendEffortToSession` calls
`chat_session_cmd.rs::apply_chat_effort`, which validates the level against
`defaults::EFFORT_LEVELS` (`pin_cmd::validate_effort_level`), sends
`{subtype: "apply_flag_settings", settings: {effortLevel: <level>}}` through the
session's control channel (`control_channel.rs::ControlHandle::apply_effort`) and
waits for the answer after it has released the session mutex, as
`switch_chat_model` does. The Agent SDK types describe the request as merging the
settings "into the flag settings layer, dynamically updating the active
configuration", a layer that sits above user, project and local settings and below
managed policy, and `effortLevel` there also accepts `max` for the session[^8].
`PreparedSpawn::with_effort`, `ChatSession::takes_wire_effort` and
`get_chat_takes_wire_effort` are gone.

Measured on the pinned 2.1.267 and on 2.1.282 (the darwin-arm64 binaries, checked
against their release manifests, run with the stream-json arguments of
`chat.rs::build_claude_args` against a stub `/v1/messages`):

- Fable 5 spawned without `--effort`, the hold model of this decision, with a
  `settings.json` already in the config directory, as in the container: the first
  request carried `output_config.effort: high`, the request after
  `apply_flag_settings` with `low` carried `low`, and after `max` it carried `max`.
  Each request was answered `success` at once and nothing else was written to
  stdout. `settings.json` was left byte for byte unchanged.
  - On 2.1.267 the config directory's `.claude.json` gained the launch-hold release
    flags `unpinFable5LaunchEffort`, `unpinOpus47LaunchEffort` and
    `unpinOpus48LaunchEffort`, each set to `true`. They store no level; a later
    process started without `--effort`, such as a CLI session, simply starts without
    the hold.
  - On 2.1.282 `.claude.json` gained nothing.

  `effort_pin` therefore stays the only level store, and every spawn still passes
  `--effort <pin>`. This run is recorded in
  `desktop/src-tauri/tests/fixtures/cc-<version>-apply-effort.sanitized.json`;
  `control_channel.rs::the_apply_effort_capture_is_of_the_pinned_claude_code` fails
  on every Claude Code bump until it is recorded again from the new binary.

- A request sent before the first user message was answered `success` the same way,
  and the first model request already carried its level. The recording holds this
  run too (`before_first_turn`): the process launched with `--effort high` and sent
  `low` before the first turn, whose request carried `low`.
- Opus 5.5 on 2.1.282, spawned with `--effort high`, behaved the same.
- `set_model` keeps the flag-layer level: after `low` was applied on Opus 4.8 and
  the session switched to Sonnet 5, the Sonnet request carried `low`.
- An unknown level (`turbo`) was answered `success` and changed nothing: the next
  request still carried `max`. An unchecked pick would therefore report success for
  a level that never applied, so the command validates the level with
  `pin_cmd::validate_effort_level`, the check the pin write uses, before it writes
  anything.
- `CLAUDE_CODE_EFFORT_LEVEL` outranks the request: with the variable set to `high`,
  the request after `apply_flag_settings` with `low` kept `high`. Speedwave never
  sets that variable (ADR-017).
- Routed models take every level. On both versions, with the routed env of
  `compose/llm.rs` for `openrouter/anthropic/claude-sonnet-5` and for
  `local/gemma-4-26b-a4b`, the first request carried `output_config.effort: high`
  and each later one carried the level of the `apply_flag_settings` before it:
  `low`, `medium`, `high`, `xhigh`, `max`.

The request needs no launch flag, so the condition of the SPEED-650 amendment is
removed together with the notice an unpinned project saw on its first pick. It
also keeps effort picks away from how Claude Code treats an `/effort` input written
during a tool-using turn. On 2.1.267 such an input never runs: the recording's
`effort_command_mid_tool_turn` run, launched with `--effort high`, wrote
`/effort low` at the first `init` of a turn whose first answer was a tool call, and
no answer of its own followed that turn while the next turn still carried `high`.
The same run on 2.1.282 answered after the turn with its own `init` and `result`
(`num_turns: 0`), and the next turn carried `low`; an input answered that way ends
the user's turn in the chat (the second defect of the SPEED-696 amendment). A
`/effort` the user types still goes to Claude Code as an input.

The effort control is rendered for every provider kind. This replaces the sentence
of this decision that renders it only for Anthropic provider kinds. For an
Anthropic provider the slider stops stay per model: the picker row, else the
catalog entry. For a local or OpenRouter provider the slider offers every level of
`defaults::EFFORT_LEVELS`. The composer receives that list as
`containers_cmd.rs::ActiveProviderSummary::effort_levels`, which is now the slider
order for every provider kind; the picker's `effort_order` field is gone. Until a
level is pinned, the routed slider shows no position, because an unpinned routed
session runs at the level Claude Code picks for a model id outside its catalog.

The upstreams were checked on 2026-09-24 with the request shape Claude Code sends:
streamed, with `thinking: {type: adaptive}` and `output_config.effort`. Every level
got HTTP 200 and `end_turn` from each of:

- LiteLLM's native `/v1/messages` passthrough with `gemma-4-26b-a4b`;
- OpenRouter's `/api/v1/messages` with `openai/gpt-4o-mini`;
- OpenRouter's `/api/v1/messages` with `anthropic/claude-sonnet-5`.

e2e spec 11 picks a level on the live local session and spec 20 on the live
OpenRouter session, and each checks that the next turn still answers.

The timing rules of the SPEED-650 amendment stand: a pick made while a turn streams,
or while a session starts or resumes, waits. Only the latest pick is applied:

- Picks go to the session one at a time, in pick order. `ChatStateService.sendEffortToSession`
  calls the command, and `applyEffortToConversation` chains the calls.
- A pick is dropped once a newer one is made, even while the newer one is still
  saving its pin.
- The pins are written in pick order, the model pins too.
- When the newest pick's pin cannot be written, the session is sent the level the
  pin holds, so the session never keeps a level the composer no longer shows.
- A pick belongs to the project it was made in. It counts only while the app is
  settled on that project and no switch has started since the pick, even one that
  failed back to the project (`ProjectStateService.settledMark` at the pick,
  `isStillSettledOn` after every wait). A pick made before or during a switch is
  therefore neither sent nor queued, and its error and notice never reach the other
  project. The switch also clears the composer's selection error.
- Model picks follow the same project rule. A newer model pick replaces or clears the
  queued one, so a queued pick never undoes a later one. Only the newest model pick
  reports a failed save, and only the newest pick whose pin was saved reports a failed
  switch or re-render: a switch that fails behind a newer pick whose save failed is
  still shown, because the session is then on neither model.

A waiting pick is released at the turn end, when a Stop the user clicks succeeds
(the interrupted turn's own `result` is dropped while nothing streams) and no container
restart began during it, since that restart's own rules then apply, when a resume
or a fresh start completes, and when a container restart fails. A restart that failed
before it recreated the containers leaves the process running, and the process takes
the picks; one that failed later leaves none, and the requests fail and say so.

A released pick goes to the running process at once, also before the process has
reported a session id: a request sent before the first user message already sets the
first model request's level (measured above). The one exception is a routed model
pick released when a fresh start completes: it re-renders the containers and respawns
the session, because its model and window reach Claude Code only as container
environment and the new session has no conversation yet.

A first start that fails drops the waiting picks, and so do a resume and a New chat
that fail to spawn, because the backend stops the earlier process before it spawns the
new one; their pins carry them to the next spawn. The header's New chat drops them when
it resets the chat, and its session launches with the pins. A New chat started from a
transcript (`startNewConversation`) and a resume keep them, but only when the backend
refused the start before it stopped the earlier process: images that are not ready, a
sign-in check that fails or says no, or a poisoned session lock. `start_session_inner`
prefixes exactly those failures with `chat_session_cmd::MSG_SESSION_KEPT`, so the
frontend does not infer the order from an error text of its own, and the frontend
strips the prefix from every error it shows. The chat returns to that process and shows
its conversation again, with its messages, session id and effort notice restored, and
the process takes them at its next turn end. A resume belongs to the project it began
in: one begun while a project switch runs never reaches the backend, and one that a
switch overtakes loads no transcript and shows neither its error nor the conversation
it kept. A New chat started from a transcript that a switch overtakes fails with
`NEW_CONVERSATION_PROJECT_CHANGED`, so nothing is restored or staged into the other
project's chat, and a start, the fresh start after a container restart included,
reports its failure only while the app is settled on the project it started for. A
resume begun while a turn streams stops that turn first, so a conversation the backend
keeps shows the turn stopped rather than streaming without end, and then waits out a
container restart that began during that stop. The fresh start after a container
restart drops them even then, since the restart
already ended the earlier process. A pick made while a resume waits out a container
restart is dropped when the resume begins, since the resumed process launches with the
pins. The Stop a container restart begins with releases nothing: the restart resumes
the conversation in a process that launches with the pins.

A pick in a chat without a session id restarts the idle session, even when the chat
shows messages, so the session launches with the pin; a routed pick re-renders the
containers first. Without a session id the chat cannot tell a live process from none,
and a conversation without one cannot be resumed. Restart now in such a chat restarts
it the same way. This includes a turn the user stopped before Claude Code reported its
session id: the next pick replaces that process and the messages it shows. Telling a
live process from a dead one there would take a liveness signal besides the session id,
for the moment between a send and Claude Code's `system/init`.

A routed pick skips the re-render and the respawn when the running process was
launched right after a re-render for the same model and nothing has switched its model
since, because that process already runs it; a direct pick and a released one follow
the same rule. `ChatStateService` records the launch only for the newest pick and only
for the session generation it started, and clears it when that start does not
complete, on a live switch and on a container restart. A live switch changes the model and the configuration but renders
nothing, so a process started after it, such as a New chat's, runs with containers
rendered for an earlier model, and its soft-impose then moves it to the configured one.

Any failure of the request keeps the pin and shows the notice with Restart now,
which is the notice's only remaining role. The failures are:

- a rejection;
- a timeout (`control_channel::APPLY_EFFORT_TIMEOUT`, 10 s);
- a session with no live process;
- a session another command holds (`chat session is busy`).

A request made after the process's output has ended fails at once, because the
stdout reader closes the control channel when the stream ends. A timed-out request
may still be applied late. The notice therefore says that the level is saved for new
sessions and that this session did not confirm it, never that the session keeps its
old level. No automatic respawn is added, for the reasons above.

Two limits remain:

- A `CLAUDE_CODE_EFFORT_LEVEL` the user puts into the project's `claude.env`
  outranks every pick, as measured above. Each pick is then answered `success` and
  changes nothing, and no notice says so.
- An upstream that rejects a level fails every turn with its error until the user
  picks another level. Only the three upstreams above were checked.

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

**Amendment (SPEED-707, 2026-09-24: effort does reach routed upstreams).** The
claim that no effort-carrying body is generated for a non-Anthropic route was
never true. Measured on 2.1.267 and 2.1.282, Claude Code puts
`output_config.effort` into every request for a routed model id: its default
`high`, or the level of the `--effort <pin>` a project saved while it used an
Anthropic provider. Since SPEED-707 the composer also offers every effort level for
local and OpenRouter providers (decision 5, SPEED-707 amendment). The forwarding
facts above are what carry the level to the upstream unchanged.

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

**Amendment (SPEED-709, 2026-09-25: the `opus` alias is pinned again).** The
model configuration page now says: "On the Anthropic API, Fable 5.1, Fable 5,
Sonnet 5, and Opus 4.7 and later run with the 1M window on every plan, including
Pro. You don't select a `[1m]` variant or turn on usage credits for the 1M window on
these models"; its plan table covers only Opus 4.6 and Sonnet 4.6[^1]. The reason of
the SPEED-648 amendment is therefore gone for the latest Opus, while the reason the
SONNET pin exists applies to it too: "when `ANTHROPIC_BASE_URL` points at a gateway,
Claude Code can't verify 1M support" and budgets the window at 200K unless the
`[1m]` variant is chosen[^1]. `defaults.rs::anthropic_default_models_env` pins
`ANTHROPIC_DEFAULT_OPUS_MODEL` to the latest catalog Opus with `[1m]`
(`claude-opus-5-5[1m]`), so subagents with `model: opus` and the plan phase of
`opusplan` keep the 1M window every plan includes. The suffix follows the catalog's
`one_million_context` policy rather than the window size: `[1m]` only for
`EveryPlan`, the bare id for `Never`, and no pin for a latest model whose window
depends on the plan. The catalog policy moves the same way (ADR-089, SPEED-709
amendment of decision 5).

**Amendment (2026-09-24: the self-heal carries a stored model into the pin
before clearing it).** Decision 7 was written while an Anthropic pick was
session-scoped, so clearing the stored value lost nothing. Since SPEED-539
the pick has a persistent home, the `settings.json` `model` key, but the
one-time self-heal (`config.rs::heal_llm_config_in`) still only cleared the
stored model. The 0.18.1 renderer injected that model as `ANTHROPIC_MODEL`
and 0.18.1 had no `settings.json` pin, so an upgrade to 0.19.0 reset every
project whose Anthropic model had been chosen in Settings to the account
default, with no warning and no copy of the old value. Seen on a real
upgrade: a project on `claude-fable-5` came back on `claude-opus-5[1m]`.
The self-heal now moves the model into the pin
(`config.rs::carry_anthropic_model_to_pin`). It writes through
`claude_settings::set_model_pin`, which moved from the Desktop crate to
`speedwave-runtime` because the CLI runs the same heal. The carried value is
the active Anthropic entry's model. Only when the active entry is not
Anthropic is it the model an inactive Anthropic entry kept for a switch back.
An active Anthropic entry without a model ran on the account default in
0.18.1, so nothing is carried for it. The heal clears the config, saves it,
and only then writes the pin. A failed config save therefore writes no pin
and leaves the model for the next start, which is still the first 0.19 start
and has no later pick to overwrite. The pin write overwrites an existing pin:
in 0.18.1 `ANTHROPIC_MODEL` outranked a `settings.json` model, so the stored
value is the model those sessions actually ran on. A pin write that fails (a
value `set_model_pin` rejects, or a malformed `settings.json`) is logged as an
error naming the model. The value is not kept in the config for a retry: the
composer and Settings read the config, so a leftover would name a model
Claude Code is not running, and a Settings save would clear it anyway. A
retry at a later start could also overwrite a model the user picked in
between. `update_llm_config` now clears the model of every Anthropic entry,
not only the active one (`LlmConfig::clear_anthropic_models`, which replaces
`clear_active_anthropic_model`). No Anthropic model reaches the config after
the first 0.19 start, so the carry never runs again. A carried model that
Claude Code no longer lists, such as `claude-fable-5`, still runs, because
Claude Code honors the pin; the picker shows no row for it (ADR-089, SPEED-663
amendment). Configs that 0.19.0 already healed no longer hold the value, so
this change cannot restore their pick. Guards: the `heal_*` tests in
`config.rs` and the `update_llm_config_in_stores_no_model_*` tests in
`containers_cmd.rs`.

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

[^7]: `@anthropic-ai/claude-agent-sdk` 0.3.267, the SDK release for Claude Code 2.1.267: `Query.setModel(model?)` "Change the model used for subsequent responses. Only available in streaming input mode", and `SDKControlSetModelRequest` (`subtype: 'set_model'`), whose `model` field reads "Omitted, null, or 'default' resets to the session default model". https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.267/sdk.d.ts

[^8]: `@anthropic-ai/claude-agent-sdk` 0.3.267: `Query.applyFlagSettings(settings)` "Merge the provided settings into the flag settings layer, dynamically updating the active configuration. ... Flag settings sit above user/project/local settings and below managed policy settings in the precedence order", with "`effortLevel` additionally accepts `'max'`, which is session-scoped"; the request type `SDKControlApplyFlagSettingsRequest` (`subtype: 'apply_flag_settings'`, `settings`). https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.267/sdk.d.ts

[^9]: `@anthropic-ai/claude-agent-sdk` 0.3.282, the SDK release for Claude Code 2.1.282: `SDKControlUpdateSettingsRequest` (`subtype: 'update_settings'`), which for `userSettings` "takes effortLevel only and saves it as the default for the session's current model, under modelSettings as /effort saves it ... the running session's level is not set here — send apply_flag_settings for that. Unlike apply_flag_settings, which only touches the session-scoped flag layer". https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.282/sdk.d.ts

[^10]: Claude Code changelog, 2.1.280: "Changed the default model on Pro and Team Standard plans from Sonnet to Opus, matching Max, Team Premium, and Enterprise"; "Changed an effort level saved before `/effort` became per-model to no longer apply to newly released models such as Opus 5.5; they start at their default until you pick a level"; "Changed Opus 4.7, Opus 4.8 and Fable 5 to stop holding their launch-default effort over `/effort` in `-p` or the Agent SDK, a project, managed or `--settings` `effortLevel`, or a per-model level". https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
