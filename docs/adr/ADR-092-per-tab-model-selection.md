# ADR-092: Per-tab model selection with a settings.json-backed project default

Date: 2026-09-24
Status: Accepted; decisions 1-3 revised 2026-10-11 (see below) to revert the project-default store from a dedicated config field back to the container's `settings.json` pin
Refs: SPEED-388

## Context

Since parallel chat tabs (ADR-090), one composer model pick still changed the model for the whole project: the pick was persisted into the container's `~/.claude/settings.json` `model` key (the SPEED-539 pin), which every new session of every tab reads at spawn. Claude Code itself also writes that key on a wire `/model`[^1], so even a session-scoped switch in one tab leaked into the next spawn of a sibling tab.

The requested behavior: a new tab opens on the project default model, and a model change made in a tab (composer pick or `/model`) applies to that tab only.

## Decision

1. **The project default model stays the container's `settings.json` `model` key — unchanged from dev, no config field, no migration.** `crates/speedwave-runtime/src/claude_settings.rs` (`get_model_pin`/`set_model_pin`/`clear_model_pin`/`restore_model_pin`/`normalize_model_pin`) is the one reader and writer of that key, locked and atomic, keeping every other key in the file. There is no `ProjectUserEntry::model_pin` field and no one-shot migration: an attempt to move this store into `config.json` (2026-09-24 through 2026-10-10 of this ADR) was reverted because it duplicated the store this ADR already named, and reintroduced the exact migration hazard `effort_pin`'s own `settings.json` takeover was built to retire. Claude Code's own `/model` writes to the same key; Speedwave does not distinguish "its" pin from Claude Code's, because both are the project default for the next tab that has not yet resolved one.
2. **Every Anthropic spawn carries an explicit `--model`, resolved by the frontend before it asks the backend to spawn:** the tab's own override when one is already recorded, else the `settings.json` pin (`get_model_pin`), else the Claude Code alias `default`. This explicit flag is what isolates one tab's picks from another's, not a second store: two tabs can read the same pin at different times and then diverge the moment either one picks a model, because each tab resolves the pin exactly once, at its own first spawn, and keeps what it resolved from then on (`ChatSessionStore.resolveLaunchModel`, `tabModel`) — a later change to the pin never reaches a tab that has already launched. `chat::validate_launch_model` still guards the value Rust actually places in argv; an invalid pin is skipped in favor of `default`, an invalid tab override fails the start. Non-Anthropic providers never take `--model` (their model is container env, ADR-073/ADR-088); an override sent against a routed provider is ignored with a log line.
3. **A composer pick, and a typed `/model <id>`, do two things at once: they become this tab's override, and they write the project's `settings.json` pin for tabs that have not resolved one yet.** These are not two independent stores: a concrete pick calls `set_model_pin`; picking the row Claude Code reports as the account default — or typing `/model default` — calls `clear_model_pin` and tracks the alias `default` rather than that row's current concrete id, so a tab stays on "the account default" even after the account default itself changes. On a live session the tab override is recorded as soon as the `set_model` control request is answered at all (confirmed, unconfirmed, or the request failing outright, ADR-088/ADR-089's `switch_chat_model`), but the `settings.json` pin is written only once Claude Code **confirms** the switch — an unconfirmed or refused pick still updates this tab's own badge but never changes what a sibling or future tab will launch with. `/model` and `set_model` sent to a `-p`/stream-json session persist nothing to `settings.json` on their own[^2]; writing the pin from the frontend is exactly how Speedwave gives that session a project-wide default despite that, the same way it already does for `effort_pin`. There is no separate "Set default" action: every pick is both the tab's override and, once confirmed, the project default.

## Consequences

- A model picked in one tab changes what that tab runs immediately and what a *future* tab (one that has not yet resolved its own model) opens on; it does not change a sibling tab that already launched.
- A tab's own override lives in frontend state and does not survive an app restart (a fresh process means a fresh, unresolved `ChatSessionStore`); the `settings.json` pin and the config `effort_pin` do, so a restarted tab's first spawn resolves back to whatever pin a confirmed pick last wrote.
- Like `effort_pin`, this pin is Desktop-only: the CLI neither reads nor writes the `settings.json` model key for its own spawns, so a CLI session keeps Claude Code's native `/model` persistence, unaffected by anything Desktop does to the same file.
- The `get_model_hint` fallback (composer badge before the first session reports its model) reads the same `settings.json` pin via `get_model_pin`.
- A tab whose session is kept across a failed New-chat/resume (ADR-090's session-kept rules) restores both halves of a dropped pending pick on write-back: its own tab override, and the `settings.json` pin it read before taking that pick (`ChatSessionStore.detachPendingModelPick`/`readSavedSelection`/`writeSavedSelection`, mirroring `restore_model_pin`) — unless a newer pick already saved over it, in which case the write-back is skipped so it cannot undo that newer save.

## Amendment (2026-09-28, merge of dev after SPEED-709)

Decision 3's live transport changes: a composer pick on a live session is a `set_model` control request to that tab's process (`switch_chat_model` with `tab_id`), never a wire `/model` input (ADR-088 SPEED-696/SPEED-709 amendments). A refused pick records nothing in this tab and hands the badge back; the sentence above this amendment about what an unconfirmed/refused pick does to the project pin reflects the 2026-10-11 revision, not the config-store design this amendment originally described.

## Amendment (2026-10-10, review of PR #1261)

Model ids have one length cap: `chat.rs::MAX_MODEL_ID_LEN` (128) bounds both `validate_launch_model` and the live pick validator `chat_session_cmd.rs::validate_model_pick`, so a `set_model` pick can no longer be accepted at a length the next spawn rejects. The `default` alias literal is `defaults.rs::DEFAULT_MODEL_ALIAS`, read by the alias list and the picker's default row.

The per-tab model selection of this ADR is not beta-gated: a composer pick always applies to this tab for every user. Only the tab strip and its surfaces are beta-gated (desktop-ui rules).

## Amendment (2026-10-11, revert of the config-backed store, SPEED-388)

Decisions 1-3 above are the current design. Between 2026-09-24 and 2026-10-10 this ADR instead moved the project default into a dedicated `ProjectUserEntry::model_pin` config field with a one-shot migration out of `settings.json`; that design was reverted in full because it duplicated the SSOT this ADR had already named in its own Context section, and because the migration marker reintroduced exactly the kind of one-shot adoption hazard the `effort_pin` design exists to avoid. The picker's per-row "Set default" action from the reverted decision 4 is gone: there is no action that sets the project default without also being a normal pick, because every confirmed pick now does both.

[^1]: Claude Code settings precedence and `/model` persistence: https://docs.anthropic.com/en/docs/claude-code/settings
[^2]: ADR-073, "Verified on the pinned binary" table: "`/model` in `-p`/stream-json mode (Desktop chat)" is "for this session only"; nothing is persisted.
