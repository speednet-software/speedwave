# ADR-045: One-Slot Queued Message Per Session (Replace, Not FIFO)

> **Status:** Accepted
> **Context:** Users type ahead while a turn is still streaming — what happens to a message submitted mid-turn?

## Decision

Each session has exactly one queued-message slot. Sending while a turn is in flight does NOT append to a backlog; it replaces the slot (most recent message wins, the displaced one is returned to the caller for a "replaced" UX hint). On turn completion the runtime drains the slot once and starts the next turn from it. The queue's presence is a field on the conversation state-tree (`pending_queue`): the frontend sets it locally on enqueue/cancel and clears it on the `QueueDrained` `chat_stream` event (the JSON-Patch mirror that originally synchronized it was retired — see the ADR-042 status note).

## Why

- Users never wait on the composer: they can always type and always Send, even while streaming.
- "What runs next" is always a single visible message, never a hidden FIFO backlog the user must re-assemble after seeing the first answer.
- Replace semantics match how people actually work mid-stream — re-think, re-type, re-send. The system honors final intent, not a history of intents.
- Cancel is first-class: one button, one state to clear, no "cancel which one?" ambiguity.
- Concurrent `queue` / `take` / `cancel` arrive from UI input, stream-end handlers, and shutdown paths at once; a `DashMap` gives per-key lock serialization so every outcome is well-formed (queue-first → runs now; take-first → waits one turn). No global mutex.
- No persistence: a queued message that outlived the app would re-issue with stale context on next launch, which is worse than losing it.

## How it works

- While streaming, Send submits to the queue (replace) instead of an immediate turn; the composer input clears. Replacement is debounced by send action, not keystroke — typing does not touch the slot.
- Drain point is exactly one place: the turn-end handler, immediately after the stream-json `Result` event commits the assistant entry. If `Some(msg)`, a new turn is fed to the same long-lived `claude` process via stdin (never a second concurrent process against the same session JSONL); the `QueueDrained` chunk then clears `pending_queue` to `None`. If `None`, the session is idle and Send resumes immediate semantics.
- Stays out of the queue: client-side slash commands (e.g. `/clear`), cancel requests, and permission/ask-user responses (these have their own reply channel and are not turn starts).

## Where it lives in code

- Queue service (`queue` / `take` / `cancel` / `peek` / `stats` / `is_empty`) — `crates/speedwave-runtime/src/session/queue.rs`. `QueuedMessageService` wraps `Arc<DashMap<String, QueuedMessage>>`; methods take `session_id: &str`. `queue` returns the displaced `Option<QueuedMessage>`; `cancel` returns `bool` (whether a slot was occupied).
- `QueuedMessage` type (`text: String` — full content, not a preview; `queued_at: u64` — Unix-ms) — `crates/speedwave-runtime/src/stream/state_tree.rs`.
- State-tree field `pending_queue: Option<QueuedMessage>` — `crates/speedwave-runtime/src/stream/state_tree.rs`.
- TS mirror `QueuedMessageState` (`text: string`, `queued_at: number`) and `pending_queue` on the state model — `desktop/src/src/app/models/state-tree.ts`. UI derives the preview from the full `text`; the projection lives in `desktop/src/src/app/services/chat-state.service.ts`.
- Desktop wiring: enqueue/cancel Tauri commands in `desktop/src-tauri/src/queue_cmd.rs`; drain-on-turn-end in `desktop/src-tauri/src/chat.rs::drain_queued_message`, which emits the `QueueDrained` chunk.

## Rejected alternatives

- **Block the composer while streaming.** Honest but slow; users who know their next message sit idle.
- **Send immediately on a second concurrent process.** A second process writing the same session JSONL violates Claude Code's single-stdin input contract.
- **FIFO queue.** Sending three premature thoughts yields three back-to-back runs with no way to cancel the first; a multi-message backlog is hard to review and reason about. The one-slot replace model keeps the next message visible and reviewable.

## Known limitations

- Per-session slots: two open sessions have two independent slots (correct — different conversations).
- The runtime `queue()` method enforces no max length itself; the upper bound is the `MAX_QUEUED_LEN` (1 MB) cap in `desktop/src-tauri/src/queue_cmd.rs::queue_message`, which rejects oversized text before it reaches the slot. The composer has no client-side character limit.
- `take` does not record why the slot was drained (turn-end vs. cancel vs. shutdown). Every caller already knows its own context, so a callback API would add no value.
