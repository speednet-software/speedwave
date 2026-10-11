# ADR-092: Per-tab model selection with a settings.json-backed project default

Date: 2026-09-24
Status: Accepted; decisions 1-3 revised 2026-10-11 (see the last amendment)
Refs: SPEED-388

## Context

Before parallel chat tabs (ADR-090) there was one session per project. A composer pick wrote the container's `~/.claude/settings.json` `model` key (the SPEED-539 pin), and the next spawn launched without `--model`, so Claude Code read that key. With several tabs on one container, every spawn that relies on that key follows the most recent pick of any tab: a restart of tab A after a pick in tab B would come back on B's model.

The requested behavior: a new tab opens on the project default model, a model change made in a tab applies to that tab and becomes the default for tabs opened afterwards, and a tab that already runs keeps its model across restarts, resumes and retries.

## Decision

1. **The project default model stays the container's `settings.json` `model` key, as before this ADR.** `crates/speedwave-runtime/src/claude_settings.rs` (`get_model_pin`, `set_model_pin`, `clear_model_pin`, `restore_model_pin`, `normalize_model_pin`) is the only reader and writer of that key; every write is locked and atomic and keeps the other keys. There is no config field and no migration.
2. **Every Anthropic spawn carries an explicit `--model`.** `chat.rs::launch_model_id` resolves it: the tab's model when the frontend sends one, else the `settings.json` pin when `chat::validate_launch_model` accepts it, else the Claude Code alias `default` (`defaults::DEFAULT_MODEL_ALIAS`). The frontend resolves a tab's model once, before the tab's first spawn (`ChatSessionStore.resolveLaunchModel`: the pin read by `get_model_pin`, else `default`), records it as the tab's model (`tabModel`) and sends it with every later start, resume and retry of that tab. The explicit flag is what keeps a running tab on its model after another tab changes the pin. An invalid pin is skipped in favor of `default`; an invalid tab model fails the start. Non-Anthropic providers never take `--model` (their model is container env, ADR-073/ADR-088); a tab model sent against a routed provider is ignored with a log line.
3. **A composer pick or a typed `/model <id>` sets the tab's model and the project default.** A concrete pick writes the pin with `set_model_pin`. Picking the row Claude Code reports as the account default, or typing `/model default`, sets the tab's model to the alias `default` and clears the pin with `clear_model_pin`, so the tab follows the account default even after the account default changes. A typed `/model <id>` is written with `restore_model_pin`, which accepts Claude ids and the Claude Code aliases, and becomes the tab's model only after that write succeeds, so a rejected id never reaches the next spawn. On a live session a pick is a `set_model` control request (`switch_chat_model`); a refused pick records nothing, and any other outcome (confirmed, unconfirmed, or the request failing) records the tab's model and writes the pin. `/model` and `set_model` in `-p`/stream-json mode persist nothing to `settings.json` themselves[^1], so Speedwave writes the pin. There is no separate "Set default" action.

## Consequences

- A pick in one tab changes that tab immediately and the model of tabs opened afterwards; it does not change a tab that already launched.
- A tab's own model lives in frontend state and does not survive an app restart. After a restart, each tab resolves the pin again at its first spawn, so it opens on the model of the last pick in any tab.
- Without a pick the spawn passes `--model default` instead of no flag. Claude Code resolves the alias to the account default, so the launched model is the same as before this ADR [Unverified on the pinned binary: alias resolution is taken from the Claude Code settings documentation[^2]].
- A tab whose session is kept across a failed New chat or resume (ADR-090's session-kept rules) restores both halves of a dropped pending pick: its own tab model, and the pin it read before taking the pick (`ChatSessionStore.readSavedSelection`/`writeSavedSelection`, `restore_model_pin`), unless a newer pick already saved over it.
- The `get_model_hint` fallback (composer badge before the first session reports its model) reads the same `settings.json` pin.

## Amendment (2026-09-28, merge of dev after SPEED-709)

A composer pick on a live session is a `set_model` control request to that tab's process (`switch_chat_model` with `tab_id`), never a wire `/model` input (ADR-088 SPEED-696/SPEED-709 amendments). A refused pick records nothing and hands the badge back.

## Amendment (2026-10-10, review of PR #1261)

Model ids have one length cap: `chat.rs::MAX_MODEL_ID_LEN` (128) bounds both `validate_launch_model` and the live pick validator `chat_session_cmd.rs::validate_model_pick`, so a `set_model` pick can no longer be accepted at a length the next spawn rejects. The `default` alias literal is `defaults.rs::DEFAULT_MODEL_ALIAS`, read by the alias list and the picker's default row.

Per-tab model selection is not beta-gated: a composer pick always applies to the current tab. Only the tab strip and its surfaces are beta-gated (desktop-ui rules).

## Amendment (2026-10-11, settings.json store kept, SPEED-388)

Between 2026-09-24 and 2026-10-10 this ADR moved the project default into a `ProjectUserEntry::model_pin` config field, with a one-shot migration out of `settings.json` (a `model_pin_migrated` marker), a strip of the `settings.json` key before every spawn, and a per-row "Set default" action in the picker; a composer pick changed only its tab. That design is replaced by decisions 1-3 above. Reasons: the migration marker had no point at which it could be removed; every new `ProjectUserEntry` field cost about 90 struct literal edits; and once every spawn passes an explicit `--model`, tabs are isolated from each other without moving the store, so the `settings.json` key can stay the project default, a pick can set it, and existing users keep their saved model without a migration.

[^1]: ADR-073, "Verified on the pinned binary" table: "`/model` in `-p`/stream-json mode (Desktop chat)" is "for this session only"; nothing is persisted.

[^2]: Claude Code settings and model aliases: https://docs.anthropic.com/en/docs/claude-code/settings
