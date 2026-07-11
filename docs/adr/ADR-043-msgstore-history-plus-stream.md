# ADR-043: MsgStore — Broadcast Channel Plus Bounded History

> **Status:** Retired (2026-06-10) — `MsgStore`, the `MsgStoreRegistry`, and the `subscribe_session`/`chat_patch::*` Tauri bridge were deleted together with the JSON-Patch wire transport (see the [ADR-042](ADR-042-json-patch-stream-protocol.md) status note). This document records the original design.
> **Context:** The JSON-Patch stream of a live Claude Code session[^1] (ADR-042) must reach multiple consumers — the chat view, a re-opened window, a diagnostic export — without racing, dropping, or duplicating state, and a late subscriber must see the full conversation from the start.

## Decision

Each active session owns one `MsgStore` (keyed by `session_id`) that combines a live `tokio::broadcast` channel[^2] with a bounded in-memory replay buffer. A subscriber calls `history_plus_stream()` to receive the full history first and then transition seamlessly to live events. A subscriber that falls behind the broadcast channel gets a single `Resync` snapshot of the current state rather than a crash or silent drift.

## Why

- A plain per-session `mpsc` channel handles only the single live consumer: a late subscriber sees nothing before it subscribed, and there is no replay.
- A broadcast-only channel handles multiple consumers but is bounded; a slow consumer hits `RecvError::Lagged` and, with no replay, its state-tree silently diverges from the publisher's.
- Combining a broadcast sender with a byte-capped history gives every consumer a consistent snapshot through one API, and makes backpressure explicit and recoverable.
- History is capped by serialized byte budget, not entry count, because entries vary from a few hundred bytes (a text delta) to several megabytes (a large tool result). The cap is `DEFAULT_HISTORY_BYTES = 100 * 1024 * 1024` (100 MiB); on overflow the oldest entries are dropped from the front, preserving patch ordering. A single oversized message is always kept rather than producing an empty history.
- Design is modelled on a known production implementation (BloopAI/vibe-kanban's `MsgStore`)[^3], so corner cases have a readable reference; the byte cap value is Speedwave's own round constant.

## How it works

- `push()` appends to history under a `parking_lot::Mutex` and broadcasts to live subscribers while holding the same lock. `history_plus_stream()` takes that lock across `subscribe` + snapshot, so a concurrent push cannot land the same message in both the snapshot and the new receiver's queue (no duplicate delivery). A regression test exercises this under a multi-threaded runtime.
- On `RecvError::Lagged`, the stream replays the current history through the reducer and yields one `LogMsg::Resync` carrying the full snapshot; the frontend treats it as: clear the state-tree, replay. The reducer is idempotent for `Replace`, so resync needs no special-casing.
- On `RecvError::Closed` (the sender dropped, session over) the stream ends. There is no explicit `finish()` call and no `Finished` message — the lifecycle markers are the `LogMsg::SessionStarted` / `LogMsg::SessionEnded` variants pushed as ordinary history entries.

## API surface

- `MsgStore` (`crates/speedwave-runtime/src/stream/msg_store.rs`): `new()`, `with_capacity(max_bytes)`, `push(msg)`, `history_plus_stream()` (returns a `futures_core::stream::BoxStream<'static, LogMsg>`), `subscribe()` (live-only `broadcast::Receiver`, fully `pub`), `history_bytes()`, `history_len()`, and `snapshot_state()` (replay history into a `ConversationState`).
- The broadcast channel capacity is `BROADCAST_CAPACITY = 1024` message slots — large enough to smooth normal UI jitter; a receiver that lags past it recovers via `Resync`. This slot count is independent of the 100 MiB byte cap on the replay buffer.
- `LogMsg` (defined in this module per ADR-042) is an adjacently-tagged serde enum with variants `JsonPatch`, `Resync`, `SessionStarted`, `SessionEnded`. Its `Debug` impl redacts `session_id`.

## Where it lives in code

- Store + history cap + lag handling — `crates/speedwave-runtime/src/stream/msg_store.rs`
- Module exports (`LogMsg`, `MsgStore`, `DEFAULT_HISTORY_BYTES`) — `crates/speedwave-runtime/src/stream/mod.rs`
- State-tree and reducer the snapshot replays through — `crates/speedwave-runtime/src/stream/state_tree.rs`, `crates/speedwave-runtime/src/stream/patch.rs`
- Tauri bridge — `desktop/src-tauri/src/subscribe_cmd.rs`. The command is `subscribe_session(session_id, state: State<MsgStoreRegistry>, app: AppHandle) -> Result<SubscribeAck, String>`. It validates the `session_id`, resolves the store, spawns a detached forwarder that drains `history_plus_stream()` and forwards each `LogMsg` via `app.emit("chat_patch::<session_id>", …)` (a Tauri event, not an `ipc::Channel`), and returns a `SubscribeAck` carrying the event name the frontend must listen on.

## Lifecycle and memory

- The registry is `MsgStoreRegistry`, an `Arc<DashMap<String, Arc<MsgStore>>>` holding strong references (`desktop/src-tauri/src/subscribe_cmd.rs`). `store_for(session_id)` is get-or-create and only ever inserts; the only removal path is a `#[cfg(test)]` helper. Stores are therefore NOT released when subscribers disconnect — they persist for the process lifetime, and no replay survives a process restart. Each store bounds its own memory at the 100 MiB cap; with a typical 1–3 concurrent sessions this is an acceptable budget for a desktop app.

## Known limitations

- The byte cap is approximate: it counts the serialized JSON size at push time, while the in-memory `LogMsg` (especially a `Patch`) is structurally larger. Accepted as-is; tightening it would require storing pre-serialized bytes and reserializing on the live path.
- A lagged subscriber's `Resync` is a full history replay, which for a mature session can be megabytes over local Tauri IPC. Acceptable for the rare lag event.
- The single mutex is a contention point for push + snapshot, but push is fast and snapshots happen only at subscription time, so contention is theoretical.

## Rejected alternatives

- **Per-session `mpsc` channel** — handles the live consumer but cannot replay for a late or re-opened subscriber.
- **Broadcast-only, no history** — multi-consumer but a lagged receiver silently diverges with no recovery path.

## References

[^1]: Claude Code CLI `--output-format stream-json`: https://code.claude.com/docs/en/cli-reference

[^2]: `tokio::sync::broadcast` (channel + `RecvError::Lagged` semantics): https://docs.rs/tokio/latest/tokio/sync/broadcast/index.html

[^3]: BloopAI/vibe-kanban `MsgStore` (the reference design - broadcast sender + `VecDeque` history + `history_plus_stream`): https://github.com/BloopAI/vibe-kanban
