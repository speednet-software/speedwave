# ADR-045: One-Slot Queued Message Per Session (Replace, Not FIFO)

**Status:** Accepted
**Date:** 2026-04-25

## Context

Users type ahead. The chat composer must accept keystrokes, and the Send button must accept clicks, while the previous turn is still streaming. Empirically, streaming turns take seconds to tens of seconds (internal observation, no external authority) — blocking input across that window is a poor UX. The question is what to do with a message submitted while a turn is in flight.

Options considered:

1. **Block — disable the composer while streaming.** Honest but slow; users who know what they want next sit idle.
2. **Send immediately on a new turn.** Not supported — the Claude Code CLI consumes user input through a single process running `--input-format stream-json`[^1]. Spawning a second concurrent process against the same session would write concurrently to the session JSONL, which is an internal contract of Claude Code (internal design decision, no external authority).
3. **FIFO queue — buffer every Send and flush in order after the current turn.** Matches "mail queue" mental model. Fails in practice: user types a premature hypothesis ("look at file X"), watches a streamed answer unfold and refines their thinking, types a better question ("actually look at file Y"), sends — and now gets _both_ runs back-to-back with no way to cancel the first. A multi-message backlog is essentially impossible to review and reason about.
4. **One-slot queue with replace semantics.** Only one pending message per session; a new Send replaces it. The composer always shows exactly what will be sent next: `queued: "…preview…"` with a cancel button. User knows what they asked for; if they change their mind, they either Send again (replacing) or Cancel (clearing). No surprises.

BloopAI/vibe-kanban implements option 4 and has run it in production for months.[^2] The behavior ("your queued message replaces the previous queued message") is explained in the UI and users have not reported confusion. Speedwave adopts the same design.

## Decision

**Service — `crates/speedwave-runtime/src/session/queue.rs`:**

```
pub struct QueuedMessage {
    pub text: String,
    pub queued_at: DateTime<Utc>,
}

pub struct QueuedMessageService {
    slots: DashMap<SessionId, QueuedMessage>,
}

impl QueuedMessageService {
    pub fn queue(&self, session: SessionId, msg: QueuedMessage) -> Option<QueuedMessage>;
    // Replaces the existing slot; returns the evicted previous message (for UI diffing if wanted).

    pub fn take(&self, session: SessionId) -> Option<QueuedMessage>;
    // Removes and returns the slot; called exactly once per turn completion.

    pub fn cancel(&self, session: SessionId);
    // Removes the slot without returning it.

    pub fn peek(&self, session: SessionId) -> Option<QueuedMessage>;
    // Non-destructive read.
}
```

API naming mirrors vibe-kanban's `queue_message` / `take_queued` / `cancel_queued` / `get_queued` / `has_queued` / `get_status`[^2] with small simplifications.

**Concurrency — `DashMap`.** `DashMap<SessionId, QueuedMessage>`[^3] is the same primitive vibe-kanban uses.[^2] It provides fine-grained per-shard locking for the concurrent `queue` / `take` / `cancel` calls that can arrive from UI input, stream-end handlers, and session-shutdown paths simultaneously. No global mutex.

**Queue state is in the conversation state-tree.** Per ADR-042, the frontend does not subscribe to a separate queue channel — the queue's presence/absence is a field on the state-tree:

```
ConversationState {
    …
    pending_queue: Option<QueuedMessagePreview>,
    …
}
```

`QueuedMessagePreview = { text_head: String (first 80 chars), queued_at: Timestamp }`. On every `queue` / `cancel` call the service emits a `Replace` patch at `/pending_queue` (a `ConversationPatch::set_pending_queue` helper per ADR-042). The UI receives queue updates through the same pipeline as everything else — no extra subscription to maintain, no races between the queue channel and the patch channel.

**Drain point.** `take` is called in exactly one place: the session's turn-end handler, immediately after the stream-json `Result` event[^4] commits the assistant entry. Flow:

1. Assistant turn finishes → `Result` emitted → reducer commits the assistant entry.
2. Session runner calls `QueuedMessageService::take(session_id)`.
3. If `Some(msg)`, a new turn is spawned with `msg.text` as user input — via stdin to the same `claude -p --input-format stream-json --output-format stream-json`[^1] process, not a new process.
4. A `Replace` patch clears `pending_queue` to `None`.
5. If `None`, the session is idle; the composer resumes normal (non-queued) send semantics.

**Composer UX requirements (documented here because the backend contract depends on them):**

- While streaming, Send submits to the queue (replace semantics) instead of issuing an immediate turn. The composer input clears after Send.
- The composer shows a `queued: "<preview>"` row with a Cancel button. Cancel calls `QueuedMessageService::cancel`.
- A second Send while already queued replaces the slot — the composer displays the new preview instead of the old.
- Send on an idle session is unchanged (immediate turn, no queue interaction).
- Replacement is debounced by _send action_, not by _keystroke_. Typing in the composer does not replace the queued message — only pressing Send does. This prevents "every keystroke updates the queue" surprises and keeps the composer's input and the queued slot as two independent pieces of state.

**What stays out of the queue:**

- Slash commands that are handled client-side (e.g. `/clear` restarting the session in the UI). Those never enter the queue; the UI handles them synchronously.
- Cancel requests. Cancel is an explicit UI action that calls the service directly.
- Permission responses (ask_user, permission prompts). These have their own reply channel; they are _not_ turn starts and must not be queued.

## Consequences

### Positive

- Users never wait for the composer. They can always type and always Send.
- The "what's next" state is always visible and always a single message — no hidden FIFO backlog that the user has to mentally re-assemble after seeing the first turn's answer.
- The replace semantics match how users actually work mid-stream: re-think, re-type, re-send. The system honors the final intent, not the history of intents.
- Cancel is a first-class UX — one button, one state to clear, no ambiguity about "cancel which one?".
- Queue state synchronizes through the same JSON Patch pipeline as everything else (ADR-042). Opening a second window sees the pending queue; a lag-and-Resync (ADR-043) re-hydrates it correctly.
- Design is a direct parallel to vibe-kanban's `queued_message.rs`[^2], which has been in production at scale with no reported regressions around queue semantics.

### Neutral

- `DashMap`[^3] is already an implicit dependency in many Rust projects; adding it explicitly for one more use is zero marginal cost.
- The service has no persistence. Queued messages are lost on app quit / crash before the turn completes. This is correct: a queued message that outlives the app would re-issue itself on next launch with stale context, which is worse than losing it.

### Negative

- Not a FIFO queue — users from other tools (ChatGPT web UI, Cursor) sometimes expect "type three things, get three answers". The composer helper text must be unambiguous: "queued (will replace if you send another)". This is a UX education cost, not a design flaw.
- Concurrent `queue` + `take` from different threads is race-prone if the contract is not followed. Specifically: if the session runner calls `take` at turn-end and a UI click calls `queue` at the same nanosecond, the ordering determines whether the new message runs next or waits another turn. `DashMap`'s per-key lock serializes the ops, and either outcome is correct (queue-first → runs now; take-first → waits one turn). The outcome is not deterministic but it is always well-formed. Documented; accepted.
- The single slot means a user who types faster than Claude answers will experience "my earlier queued message was replaced without me realizing" if they Send twice quickly. Mitigation: the preview shows `queued_at` so the user sees the timestamp change; the previous preview is briefly animated out. Not perfect, better than the alternatives.

## Known Limitations

- The service is per-session. A user with two sessions has two independent slots — correct behavior (they're different conversations), but worth noting for anyone debugging "why is my queued message not appearing in _this_ session".
- The service does not enforce a maximum queued message length. The backend accepts whatever string the UI sends. The composer's existing character-limit UX (shared with immediate sends) is the only upper bound. If this ever matters, a simple `max_len` check on `queue()` suffices.
- `take` does not surface "why was this drained" (was it a normal turn-end, or a cancel, or a session shutdown). Every caller that invokes `take` knows its context. A callback-based API would provide that context but adds no value; the service stays minimal.

## References

[^1]: Anthropic Claude Code CLI reference — `--input-format=stream-json` feeds user turns via stdin; `--output-format stream-json` emits structured events: https://code.claude.com/docs/en/cli-reference

[^2]: BloopAI/vibe-kanban — `QueuedMessageService`, one-slot-per-session, replace semantics, `DashMap` storage: https://github.com/BloopAI/vibe-kanban/blob/main/crates/services/src/services/queued_message.rs

[^3]: `dashmap` crate — concurrent hashmap, per-shard locks: https://docs.rs/dashmap/latest/dashmap/

[^4]: Anthropic Claude Code stream-json output — `Result` event marks turn completion: https://code.claude.com/docs/en/cli-reference
