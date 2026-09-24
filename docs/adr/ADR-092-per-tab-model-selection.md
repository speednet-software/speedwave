# ADR-092: Per-tab model selection with a config-backed project default

Date: 2026-09-24
Status: Accepted (supersedes the ADR-088 decision-3 amendment, SPEED-539, and its `settings.json` model-pin store)
Refs: SPEED-388

## Context

Since parallel chat tabs (ADR-090), one composer model pick still changed the model for the whole project: the pick was persisted into the container's `~/.claude/settings.json` `model` key (the SPEED-539 pin), which every new session of every tab reads at spawn. Claude Code itself also writes that key on a wire `/model`[^1], so even a session-scoped switch in one tab leaked into the next spawn of a sibling tab.

The requested behavior: a new tab opens on the project default model, and a model change made in a tab (composer pick or `/model`) applies to that tab only.

## Decision

1. **The project default model moves to project config.** `ProjectUserEntry.model_pin` (`crates/speedwave-runtime/src/config.rs`) is the only persistent store of the default model for new sessions, exactly like `effort_pin` (SPEED-664/SPEED-538 pattern). The container `settings.json` `model` key is never a store: `pin_cmd::ensure_model_pin_migrated_in` strips it before every Desktop spawn, adopting its value into `model_pin` only once per project (the `model_pin_migrated` marker), because after the first migration any reappearing `model` key is Claude Code's own session-scoped `/model` persistence, never a new default. Migration on an unreadable `settings.json` is skipped without consuming the marker.
2. **Every Anthropic spawn resolves its model explicitly**: the tab's model override (highest), else the config `model_pin`, else no `--model` flag (account default). The override and the pin pass `chat::validate_launch_model` (alias or `claude-*` shape, argv-safe charset, 128-char cap); an invalid pin is skipped, an invalid override fails the start. Non-Anthropic providers never take `--model` (their model is container env, ADR-073/ADR-088); an override sent against a routed provider is ignored with a log line.
3. **The tab owns its model.** The frontend `ChatSessionStore` (one per tab, ADR-090) records the picked wire id and passes it as the `model` parameter of `start_chat`, `resume_conversation`, and `retry_last_turn`; the Rust side threads it into `ChatSession::prepare_args`. A composer pick therefore: wires `/model <wire id>` into a live session (queued while streaming, unchanged), and rides every later respawn/resume/retry of that tab as `--model`. Picking the row marked Default sends that row's concrete wire id, so a tab can return to the account default even when a project pin exists. A typed `/model claude-*` is recorded as the tab override too; aliases stay session-scoped. No composer pick writes any project-level store.
4. **The project default is set from the picker's per-row "Set default" action** (`set_model_pin`/`clear_model_pin`, now config-backed; picking the account-default row as default clears the pin). Setting the default never touches a live session; it applies to new tabs and to tabs without an override on their next spawn. `normalize_pin_for_session` keeps normalizing the pin's wire form ([1m] by plan) against the config store.

## Consequences

- A model picked in one tab can no longer change what a sibling or future tab runs; the SPEED-535 e2e block was rewritten accordingly (`20-slash-and-model-selector.spec.ts`).
- Tab overrides live in frontend state, so they do not survive an app restart; the config `model_pin` and `effort_pin` do.
- Like `effort_pin`, `model_pin` is Desktop-only on both ends: the CLI neither strips the legacy `settings.json` key nor passes `--model`, so CLI sessions keep Claude Code's own persistence semantics.
- The `get_model_hint` fallback (composer badge before the first session) now reads the config pin instead of `settings.json`.

[^1]: Claude Code settings precedence and `/model` persistence: https://docs.anthropic.com/en/docs/claude-code/settings
