# ADR-043: MsgStore — Broadcast Channel Plus Bounded History

**Status:** Accepted
**Date:** 2026-04-25

## Context

The stream of JSON Patches emitted by a live Claude Code session (ADR-042) must reach multiple consumers without racing, dropping, or duplicating state. Concrete consumers:

- The Angular chat component, which subscribes on mount and unsubscribes on unmount.
- A second desktop window or tab opened on the same session — must see the full conversation from the start, not only events that arrived after it opened.
- A diagnostic export ("copy conversation JSON") that walks the full history.
- Transient re-subscriptions when the UI component is destroyed and re-created (e.g. switching sidebar views and returning).

A naive design — one `tokio::mpsc` channel per session — handles the live case but fails the others: a late subscriber sees nothing before its subscription, and there is no way to replay. A naive broadcast-only design with `tokio::broadcast`[^1] handles multi-consumer but the channel is bounded and a slow consumer causes `RecvError::Lagged`[^1] — with no replay, the lagged consumer's state-tree is now inconsistent with the publisher.

BloopAI/vibe-kanban's solution is a small store that combines both: a `tokio::broadcast`[^1] sender for live events and a bounded `VecDeque` for replay, exposed as `history_plus_stream()` which yields history first and then seamlessly transitions to live.[^2] The history is capped by a serialized byte budget (`HISTORY_BYTES = 100_000 * 1024` ≈ 97.7 MiB in vibe-kanban[^2]), not entry count, because individual entries vary from a few hundred bytes (a text delta) to several megabytes (a large tool result). Lagged subscribers receive an explicit `Resync` patch (a snapshot of the current state-tree) rather than a crash.

Speedwave adopts the same design with a round 100 MiB cap (`100 * 1024 * 1024` = 104,857,600 bytes) — close to vibe-kanban's value but a more natural constant. Same API shape, same lag-handling strategy.

## Decision

**Module: `crates/speedwave-runtime/src/stream/msg_store.rs`.**

One `MsgStore` instance per active session, keyed by `session_id`. The store owns:

1. **A `tokio::broadcast::Sender<LogMsg>`**[^1] with a channel capacity sized for ~10 seconds of peak emit rate (100 000 message slots — above this a lagged receiver flips to `Resync` mode rather than blocking the publisher). This channel capacity is a slot count and is independent of the 100 MiB byte cap on the replay buffer described below; the byte cap bounds memory in the `VecDeque`, the slot count bounds how far a live receiver may lag before resync.
2. **A `Mutex<VecDeque<LogMsg>>`** replay buffer, sized by cumulative serialized payload bytes (not entry count).
3. **A `usize` running byte total** for O(1) cap enforcement — increment on push, decrement on pop_front until under the cap.

**API:**

```
impl MsgStore {
    pub fn new(session_id: SessionId) -> Self;

    pub fn push(&self, msg: LogMsg);
    // Appends to history (with cap enforcement) and sends on the broadcast channel.
    // Never fails: if history would overflow, oldest entries are popped until under cap.
    // If broadcast send fails (no subscribers), the message is still in history.

    pub fn history_plus_stream(&self) -> BoxStream<'static, LogMsg>;
    // Returns a stream that yields every message currently in history,
    // then chains to a live broadcast::Receiver. The transition is done
    // atomically under the history lock so no message is missed between
    // the last history entry and the first live event.

    pub(crate) fn subscribe_live(&self) -> broadcast::Receiver<LogMsg>;
    // Live-only subscription — visibility restricted to the runtime crate.
    // External callers must use `history_plus_stream` to avoid missing replay
    // on (re)connect; a direct broadcast receiver sees only events sent after
    // `subscribe` and would silently drop everything already in history.

    pub fn finish(&self);
    // Emits LogMsg::Finished on the broadcast channel. Drops the sender; new
    // subscribers receive full history and then end-of-stream.
}
```

`LogMsg` is defined in ADR-042.

**History cap — 100 MiB (`DEFAULT_HISTORY_BYTES = 100 * 1024 * 1024` = 104,857,600 bytes).** Close to — but not identical to — vibe-kanban's `HISTORY_BYTES = 100_000 * 1024` (~97.7 MiB)[^2]; Speedwave rounds to a power-of-two MiB for readability in logs and debugging. Sized per serialized `LogMsg` bytes (via `serde_json::to_vec` length at push time — cheap because the payload is already JSON). On overflow, drop from the front (oldest first) until under the cap. Never drop from the middle; never drop a patch that mutates state without also dropping all preceding patches to that path (dropping from the front preserves this invariant because patches are ordered).

**Lag handling — Resync patch.** A frontend subscriber that lags beyond the broadcast channel capacity receives `broadcast::error::RecvError::Lagged(n)`[^1]. The subscription wrapper catches it and:

1. Drops the old receiver.
2. Calls `history_plus_stream()` for a fresh snapshot — which the frontend treats as a full `Resync`: clear the current state-tree, replay the received history.

The frontend's reducer (ADR-042) must be idempotent for `Replace`, which it is by construction. `Add` operations are replayed against a freshly cleared state-tree, so no duplicate-add conflict. This makes resync recoverable without special-casing in the reducer.

**Tauri exposure.** One Tauri command wires it up:

```
#[tauri::command]
async fn subscribe_session(
    session_id: String,
    on_event: tauri::ipc::Channel<LogMsg>,
) -> Result<(), String>;
```

The frontend calls this on chat-init for the active session. Internally it resolves the `MsgStore`, calls `history_plus_stream()`, and forwards each `LogMsg` to the Tauri channel. Existing per-type event APIs (if any) are removed.

**Lifecycle.** `MsgStore` is created when a session starts (`claude -p --output-format=stream-json`[^3] process spawns) and dropped when the session's last subscriber disconnects _and_ `finish()` has been called. A small `Weak`-based registry in runtime state maps `SessionId -> Weak<MsgStore>`; `Arc` counts release the store when no live subscribers remain and no new ones reference the weak entry — this bounds memory across dozens of historical sessions without keeping them resident.

## Consequences

### Positive

- Second desktop windows, tab reopens, and diagnostic exports all work out of the box — each caller gets a consistent snapshot through the same API.
- Backpressure is explicit and recoverable: slow consumers degrade gracefully via `Resync` rather than crashing or silently drifting from the publisher's state.
- The 100 MiB cap bounds memory per session regardless of conversation length or tool-output size. A runaway tool that emits 500 MiB of patches fills history up to the cap and then rolls, leaving the live stream unaffected.
- Cleanly layered: ADR-042 defines the patch payload, ADR-043 defines the transport, ADR-044 defines the addressing — each can be understood in isolation.
- Direct parallel to a production implementation (vibe-kanban `MsgStore`[^2]) — when we hit a corner case the reference is readable, and divergences from their behavior are intentional and documented.

### Neutral

- Requires one `Arc<MsgStore>` kept alive per active session. At 100 MiB per session and a typical user running 1–3 sessions simultaneously, that is ≤300 MiB in the worst case — acceptable for a desktop app with multi-GB RAM budgets.
- Adds a dependency on `futures::stream::BoxStream`[^4] to type-erase the chained history-then-live stream — standard pattern, no new dependency family.

### Negative

- The byte cap is approximate: the count is the serialized JSON size at push time, but memory held is the in-memory `LogMsg` (which for a `Patch` is structurally larger than its JSON). A future refactor could store already-serialized bytes in the history and defer deserialization to the reader to tighten the accounting, at the cost of reserialization on the live path. Accepted as-is.
- A lagged subscriber's `Resync` is a full history replay. For a mature session this can be megabytes sent over a local Tauri IPC channel. Measured latency on local IPC is sub-millisecond per MB, acceptable for the rare lag event.
- The `Mutex<VecDeque>` is a single contention point for push + history-snapshot. Push is fast (append + byte accounting) and history snapshots are infrequent (subscription time only), so contention is theoretical. If a future profile shows otherwise, switch to a lock-free ring buffer; not today.

## Known Limitations

- `broadcast::Receiver::recv`[^1] returns `Lagged(n)` once per lag event and then resumes; the subscription wrapper must call `recv` in a loop to observe and handle the lag. An inattentive implementation that unwraps the error will panic — the wrapper is mandatory, not optional.
- The store does not persist across process restarts. On app relaunch, sessions that were active at quit are not replayable. Persistence is deliberately out of scope; if a user needs a transcript, export from the active session is the supported path.
- `finish()` may be called from both a `Drop` impl and an explicit shutdown path; the implementation is idempotent — the second call is a no-op. Callers should not rely on double-calling as a feature.

## References

[^1]: `tokio::sync::broadcast` — multi-producer multi-consumer channel, `RecvError::Lagged` semantics, in-order delivery: https://docs.rs/tokio/latest/tokio/sync/broadcast/index.html

[^2]: BloopAI/vibe-kanban — `MsgStore` with `tokio::broadcast` sender, `VecDeque` history, 100 MB cap (`HISTORY_BYTES = 100_000 * 1024`), `history_plus_stream` method: https://github.com/BloopAI/vibe-kanban/blob/main/crates/utils/src/msg_store.rs

[^3]: Anthropic Claude Code CLI reference — `--output-format stream-json`: https://code.claude.com/docs/en/cli-reference

[^4]: `futures::stream::BoxStream` — type-erased owned stream: https://docs.rs/futures/latest/futures/stream/type.BoxStream.html
