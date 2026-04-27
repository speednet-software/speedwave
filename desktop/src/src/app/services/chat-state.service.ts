import { Injectable, computed, inject, signal, type Signal } from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import { calculateCost } from '../chat/pricing';
import { applyPatch, type Patch } from './json-patch';
import {
  DEFAULT_STATE_TREE,
  type ConversationEntryState,
  type ConversationStateTree,
  type LogMsgEnvelope,
  type MessageBlockState,
} from '../models/state-tree';
import type {
  ChatMessage,
  MessageBlock,
  SessionStats,
  StreamChunk,
  ToolUseBlock,
  AskUserQuestionBlock,
  ProjectList,
  RateLimitInfo,
  EntryMeta,
  TurnUsage,
  QueuedMessage,
} from '../models/chat';

// Re-export types consumed by components
export type {
  ChatMessage,
  MessageBlock,
  StreamChunk,
  ProjectList,
  SessionStats,
  AskUserQuestionBlock,
  RateLimitInfo,
  EntryMeta,
  TurnUsage,
  QueuedMessage,
};

/** Maximum time to wait for a chat session to start before surfacing a timeout error. */
const SESSION_START_TIMEOUT_MS = 30_000;
/** Polling interval while waiting for a session to start. */
const SESSION_START_POLL_MS = 500;

/** Singleton service that holds chat session state across navigation. */
@Injectable({ providedIn: 'root' })
export class ChatStateService {
  private _messages: ChatMessage[] = [];
  /** Completed messages (immutable — replaced on each change). */
  get messages(): readonly ChatMessage[] {
    return this._messages;
  }

  private _currentBlocks: MessageBlock[] = [];
  /** Blocks accumulating during the current streaming assistant turn. */
  get currentBlocks(): readonly MessageBlock[] {
    return this._currentBlocks;
  }

  isStreaming = false;

  /** ADR-045 — current queued message (null when slot is empty). */
  private _pendingQueue: QueuedMessage | null = null;
  /** Public read-only accessor for the queued slot. */
  get pendingQueue(): QueuedMessage | null {
    return this._pendingQueue;
  }

  private _sessionStats: SessionStats | null = null;
  /** Session cost/usage stats from the most recent result. */
  get sessionStats(): SessionStats | null {
    return this._sessionStats;
  }

  private _model = '';
  private _rateLimit: RateLimitInfo | null = null;
  private _totalOutputTokens = 0;
  private _contextWindowSize = 200_000;

  /**
   * Monotonically increasing turn id. Bumped by both `sendMessage` (new turn
   * starts) and `stopConversation` (turn cancelled). Used across awaits by
   * `answerQuestion` to detect whether the turn it was answering has since
   * been superseded, so late backend errors from the dying turn can be
   * suppressed.
   */
  private _turnId = 0;
  /** Test-only read access. */
  get turnId(): number {
    return this._turnId;
  }

  private unlisten: UnlistenFn | null = null;
  private listenerReady = false;
  private initialized = false;
  private startingSession = false;
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private unsubProjectChange: (() => void) | null = null;

  /**
   * ADR-042 / ADR-043 — full state-tree signal driven by JSON Patches.
   *
   * Held alongside the legacy `_messages`/`_currentBlocks` shape during
   * the bridge period. Backend pushes patches into a per-session MsgStore;
   * `subscribeToSession` wires `chat_patch::<id>` events through
   * `applyLogMsg`, which routes to `applyPatch` for `JsonPatch` variants
   * and to a wholesale replace for `Resync`.
   */
  private readonly _state = signal<ConversationStateTree>({ ...DEFAULT_STATE_TREE });
  /** Public read-only signal exposed to components. */
  readonly state: Signal<ConversationStateTree> = this._state.asReadonly();

  /**
   * ADR-042 — Project the state-tree's committed entries onto the legacy
   * `ChatMessage[]` shape so components can read state-tree as their
   * source of truth without changing their templates. The trailing
   * "live streaming" entry (no committed UUID, no meta) is excluded —
   * `currentBlocksFromState` exposes it separately for the streaming view.
   */
  readonly messagesFromState: Signal<readonly ChatMessage[]> = computed(() =>
    stateEntriesToChatMessages(this._state().entries)
  );

  /** ADR-042 — projection of `state().is_streaming` onto a signal. */
  readonly isStreamingFromState: Signal<boolean> = computed(() => this._state().is_streaming);

  /**
   * Signal mirror of {@link canRetryLastAssistant}. Backed by the same
   * `_state` projection that drives `messagesFromState`, so OnPush
   * components binding `[disabled]="!retryEnabled()"` re-evaluate without
   * a manual `markForCheck` whenever the retry anchor flips.
   */
  readonly retryEnabled: Signal<boolean> = computed(() => {
    const tree = this._state();
    if (tree.is_streaming) return false;
    if (!tree.session_id) return false;
    const entries = tree.entries;
    let lastAssistantIdx = -1;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i].role === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx < 0) return false;
    const assistant = entries[lastAssistantIdx];
    if (assistant.uuid_status !== 'committed') return false;
    for (let i = lastAssistantIdx - 1; i >= 0; i -= 1) {
      const m = entries[i];
      if (m.role !== 'user') continue;
      return Boolean(m.uuid) && m.uuid_status === 'committed';
    }
    return false;
  });

  /**
   * ADR-042 — projection of the live (uncommitted) trailing entry's blocks.
   * "Live" means: the trailing entry is an assistant turn that has no
   * meta yet (Result hasn't fired) AND no committed UUID. Once Result
   * settles meta or commits the UUID the entry is no longer live and
   * its blocks belong on `messagesFromState` instead.
   */
  readonly currentBlocksFromState: Signal<readonly MessageBlock[]> = computed(() => {
    const entries = this._state().entries;
    const last = entries[entries.length - 1];
    if (!last || last.role !== 'assistant') return [];
    if (last.uuid_status === 'committed' || last.meta !== null) return [];
    return stateBlocksToMessageBlocks(last.blocks);
  });

  /** ADR-042 — projection of `state().pending_queue`. */
  readonly pendingQueueFromState: Signal<QueuedMessage | null> = computed(
    () => this._state().pending_queue
  );

  /** Per-session unlisten handle for `chat_patch::<id>` subscriptions. */
  private patchUnlisten: UnlistenFn | null = null;
  /** Active session id we've subscribed to (avoids re-subscribe loops). */
  private subscribedSessionId: string | null = null;

  /**
   * Test-only setter for private backing fields.
   * @internal
   * @param state - partial state to merge into the service
   */
  _setState(
    state: Partial<{
      messages: ChatMessage[];
      currentBlocks: MessageBlock[];
      sessionStats: SessionStats | null;
      pendingQueue: QueuedMessage | null;
    }>
  ): void {
    if (state.messages !== undefined) this._messages = state.messages;
    if (state.currentBlocks !== undefined) this._currentBlocks = state.currentBlocks;
    if (state.sessionStats !== undefined) this._sessionStats = state.sessionStats;
    if (state.pendingQueue !== undefined) this._pendingQueue = state.pendingQueue;
  }

  /** Subscribers notified on every state change (components call markForCheck). */
  private changeListeners: Array<() => void> = [];

  /**
   * Registers a callback invoked on every state mutation.
   * @param cb - The callback to invoke on change.
   */
  onChange(cb: () => void): () => void {
    this.changeListeners.push(cb);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== cb);
    };
  }

  /** Notifies all registered change listeners. */
  private notifyChange(): void {
    // ADR-042/043 — keep the state-tree signal in lockstep with the legacy
    // fields. Every notifyChange call rebuilds the state-tree from the
    // post-mutation legacy state, so consumers can read either the legacy
    // gettters (`messages`, `currentBlocks`, `isStreaming`, `sessionStats`,
    // `pendingQueue`) or the unified `state()` signal and see consistent
    // values. The backend MsgStore keeps history; this rebuild keeps the
    // live signal honest without introducing drift.
    this.rebuildStateTree();
    for (const cb of this.changeListeners) {
      cb();
    }
  }

  /**
   * Project the legacy fields onto a fresh `ConversationStateTree` and
   * write it to `_state`. Called from `notifyChange()` so the signal
   * always reflects the latest mutation.
   */
  private rebuildStateTree(): void {
    this._state.set(
      buildStateTreeFromLegacy({
        messages: this._messages,
        currentBlocks: this._currentBlocks,
        isStreaming: this.isStreaming,
        pendingQueue: this._pendingQueue,
        sessionStats: this._sessionStats,
        model: this._model,
      })
    );
  }

  /** Ensures the stream listener runs exactly once. Waits for project ready before starting chat. */
  async init(): Promise<void> {
    console.debug(
      '[chat-state] init: listenerReady=%s initialized=%s',
      this.listenerReady,
      this.initialized
    );
    if (!this.listenerReady) {
      this.listenerReady = true;
      await this.setupStreamListener();
      this.setupProjectStateListeners();
    }
    if (!this.initialized) {
      this.initialized = true;
      // Start chat session in the background — don't await so the UI stays
      // responsive.  If the user sends a message before start_chat completes,
      // sendMessage's auto-retry handles "no active session" transparently.
      if (this.projectState.status === 'ready') {
        this.startChatSession();
      } else {
        const unsub = this.projectState.onProjectReady(() => {
          unsub();
          this.startChatSession();
        });
      }
    }
  }

  private async startChatSession(): Promise<void> {
    const project = this.projectState.activeProject;
    if (project && !this.startingSession) {
      this.startingSession = true;
      console.debug('[chat-state] startChatSession: project=%s', project);
      try {
        await this.tauri.invoke('start_chat', { project });
        console.debug('[chat-state] startChatSession: success');
      } catch (err) {
        const msg = String(err);
        if (msg.includes('not authenticated')) {
          this.projectState.status = 'auth_required';
          this.notifyChange();
        } else {
          console.error('Failed to start chat session:', err);
        }
      } finally {
        this.startingSession = false;
      }
    }
  }

  /**
   * Sends a user message to Claude via the backend.
   * @param text - The message text to send. May be the user's raw input or
   *   a prefixed payload (e.g. plan-mode prefix); when `displayText` is
   *   provided it is used for the local bubble while `text` is what the
   *   backend receives.
   * @param displayText - Optional surface-level text rendered in the chat
   *   list. Falls back to `text` when omitted.
   */
  async sendMessage(text: string, displayText?: string): Promise<void> {
    if (!text || this.isStreaming) return;
    console.debug('[chat-state] sendMessage: isStreaming=%s', this.isStreaming);

    this._messages = [
      ...this._messages,
      {
        role: 'user',
        blocks: [{ type: 'text', content: displayText ?? text }],
        timestamp: Date.now(),
      },
    ];
    this.isStreaming = true;
    this._turnId += 1;
    this._currentBlocks = [];
    this.notifyChange();

    try {
      await this.tauri.invoke('send_message', { message: text });
    } catch (err) {
      const errStr = String(err);
      // Session died (broken pipe, exited) — restart transparently
      if (
        errStr.includes('session exited') ||
        errStr.includes('no active session') ||
        errStr.includes('Broken pipe')
      ) {
        try {
          // If startChatSession is already in progress (from init), wait for
          // it to finish rather than starting a competing session.
          if (this.startingSession) {
            const deadline = Date.now() + SESSION_START_TIMEOUT_MS;
            while (this.startingSession && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, SESSION_START_POLL_MS));
            }
            if (this.startingSession) {
              // Timed out — session startup is still running (likely
              // container recreation).  Show an error instead of hanging.
              this.isStreaming = false;
              this._messages = [
                ...this._messages,
                {
                  role: 'assistant',
                  blocks: [
                    {
                      type: 'error',
                      content:
                        'Session is still starting (containers may be restarting). Please try again in a moment.',
                    },
                  ],
                  timestamp: Date.now(),
                },
              ];
              this.notifyChange();
              return;
            }
            // After waiting, try to send — session should be ready now
            try {
              await this.tauri.invoke('send_message', { message: text });
            } catch (postWaitErr) {
              this.isStreaming = false;
              this._messages = [
                ...this._messages,
                {
                  role: 'assistant',
                  blocks: [
                    {
                      type: 'error',
                      content: `Failed to send message after session started: ${postWaitErr}`,
                    },
                  ],
                  timestamp: Date.now(),
                },
              ];
              this.notifyChange();
            }
            return;
          }
          const result = await this.tauri.invoke<ProjectList>('list_projects');
          if (result.active_project) {
            this.startingSession = true;
            try {
              await this.tauri.invoke('start_chat', { project: result.active_project });
            } finally {
              this.startingSession = false;
            }
            await this.tauri.invoke('send_message', { message: text });
            return;
          }
          // No active project — surface actionable error
          this.isStreaming = false;
          this._messages = [
            ...this._messages,
            {
              role: 'assistant',
              blocks: [
                {
                  type: 'error',
                  content: 'No active project. Please select or add a project first.',
                },
              ],
              timestamp: Date.now(),
            },
          ];
          this.notifyChange();
          return;
        } catch (retryErr) {
          const retryMsg = String(retryErr);
          if (retryMsg.includes('not authenticated')) {
            this.projectState.status = 'auth_required';
            this.isStreaming = false;
            this.notifyChange();
            return;
          }
          this.isStreaming = false;
          this._messages = [
            ...this._messages,
            {
              role: 'assistant',
              blocks: [{ type: 'error', content: `Failed to restart session: ${retryErr}` }],
              timestamp: Date.now(),
            },
          ];
          this.notifyChange();
          return;
        }
      }
      this.isStreaming = false;
      this._messages = [
        ...this._messages,
        {
          role: 'assistant',
          blocks: [{ type: 'error', content: `Failed to send message: ${err}` }],
          timestamp: Date.now(),
        },
      ];
      this.notifyChange();
    }
  }

  /**
   * Sends an answer to an AskUserQuestion prompt back to Claude.
   * @param toolUseId - The tool_use_id of the AskUserQuestion.
   * @param selectedValues - The selected option value(s).
   */
  async answerQuestion(toolUseId: string, selectedValues: string[]): Promise<void> {
    const answer = selectedValues.join(', ');
    const capturedTurn = this._turnId;

    // Mark the question as answered in currentBlocks
    this._currentBlocks = this._currentBlocks.map((b) =>
      b.type === 'ask_user' && b.question.tool_id === toolUseId
        ? { ...b, question: { ...b.question, answered: true, selected_values: selectedValues } }
        : b
    );
    this.notifyChange();

    try {
      await this.tauri.invoke('answer_question', { toolUseId, answer });
    } catch (err) {
      // If stopConversation ran while answer_question was in flight, _turnId has
      // moved on. Suppress the error block: the user deliberately cancelled, a
      // "Broken pipe" / "no active session" surfacing would be confusing noise.
      if (capturedTurn !== this._turnId) {
        console.debug('[chat-state] answerQuestion: suppressing error after stop', err);
        return;
      }
      this.isStreaming = false;
      this._currentBlocks = this._currentBlocks.map((b) =>
        b.type === 'ask_user' && b.question.tool_id === toolUseId
          ? { ...b, question: { ...b.question, answered: false, selected_values: [] } }
          : b
      );
      this._currentBlocks = [
        ...this._currentBlocks,
        { type: 'error', content: `Failed to send answer: ${err}` },
      ];
      this.notifyChange();
    }
  }

  /**
   * Stops the current Claude turn. Safe to call when not streaming (no-op).
   * Synchronously resets UI state so the input is re-enabled immediately,
   * then fires the backend stop in the background.
   */
  async stopConversation(): Promise<void> {
    if (!this.isStreaming) return;

    // 1. Invalidate any in-flight / buffered stream events from the dying turn.
    this._turnId += 1;

    // 2. Synchronous UI reset — must precede any await so re-entrant calls see
    //    isStreaming=false and early-return (prevents double invoke of stop_chat).
    this.isStreaming = false;

    // 3. Preserve the partial assistant reply but drop ask_user blocks and
    //    finalize running tool_use blocks. The interrupt aborts the in-flight
    //    turn; Claude will not answer any rendered question (the matching
    //    tool_use_id is abandoned), so ask_user is unanswerable. Running tools
    //    would otherwise render a permanent "running" spinner inside a closed
    //    message — flip them to status: 'error' with an "Interrupted" marker.
    const keptBlocks = this._currentBlocks
      .filter((b) => b.type !== 'ask_user')
      .map((b) => {
        if (b.type === 'tool_use' && b.tool.status === 'running') {
          return {
            ...b,
            tool: {
              type: 'tool_use' as const,
              tool_id: b.tool.tool_id,
              tool_name: b.tool.tool_name,
              input_json: b.tool.input_json,
              status: 'error' as const,
              result: 'Interrupted',
              result_is_error: true as const,
            },
          };
        }
        return b;
      });
    if (keptBlocks.length > 0) {
      this._messages = [
        ...this._messages,
        { role: 'assistant', blocks: keptBlocks, timestamp: Date.now() },
      ];
    }
    this._currentBlocks = [];
    this.notifyChange();

    // 4. Fire the backend interrupt. "no active session" is benign (idle or
    //    already exited); any other failure means the turn may still be
    //    running on the backend, so surface an error block to the user.
    try {
      await this.tauri.invoke('stop_chat');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('no active session')) {
        console.debug('[chat-state] stopConversation: backend already idle', err);
        return;
      }
      console.error('[chat-state] stopConversation: invoke failed', err);
      this._messages = [
        ...this._messages,
        {
          role: 'assistant',
          blocks: [
            {
              type: 'error',
              content: `Stop failed — the current turn may still be running. ${msg}`,
            },
          ],
          timestamp: Date.now(),
        },
      ];
      this.notifyChange();
    }
  }

  /**
   * Processes a streaming chunk from the Claude subprocess.
   * Uses immutable updates: currentBlocks is replaced on every mutation.
   * @param chunk - The stream chunk to handle.
   */
  handleStreamChunk(chunk: StreamChunk): void {
    switch (chunk.chunk_type) {
      case 'Text':
        this.isStreaming = true;
        this._currentBlocks = appendOrCreateTextBlock(this._currentBlocks, chunk.data.content);
        break;

      case 'Thinking':
        this.isStreaming = true;
        this._currentBlocks = appendOrCreateThinkingBlock(this._currentBlocks, chunk.data.content);
        break;

      case 'ToolStart': {
        const newTool: ToolUseBlock = {
          type: 'tool_use',
          tool_id: chunk.data.tool_id,
          tool_name: chunk.data.tool_name,
          input_json: '',
          status: 'running',
        };
        this._currentBlocks = [...this._currentBlocks, { type: 'tool_use', tool: newTool }];
        break;
      }

      case 'ToolInputDelta':
        this._currentBlocks = updateToolInput(
          this._currentBlocks,
          chunk.data.tool_id,
          chunk.data.partial_json
        );
        break;

      case 'ToolResult':
        this._currentBlocks = completeToolBlock(this._currentBlocks, chunk.data);
        break;

      case 'AskUserQuestion': {
        const askBlock: AskUserQuestionBlock = {
          tool_id: chunk.data.tool_id,
          question: chunk.data.question,
          options: chunk.data.options,
          header: chunk.data.header,
          multi_select: chunk.data.multi_select,
          answered: false,
          selected_values: [],
        };
        this._currentBlocks = [...this._currentBlocks, { type: 'ask_user', question: askBlock }];
        break;
      }

      case 'SystemInit':
        this._model = chunk.data.model;
        break;

      case 'RateLimit':
        if (chunk.data.utilization !== null) {
          this._rateLimit = {
            status: chunk.data.status,
            utilization: chunk.data.utilization,
            resets_at: chunk.data.resets_at,
          };
          // Update existing sessionStats immediately if present
          if (this._sessionStats) {
            this._sessionStats = { ...this._sessionStats, rate_limit: this._rateLimit };
          }
        }
        break;

      case 'Result': {
        if (chunk.data.result_text) {
          // Only append result_text when no streamed text blocks exist yet.
          // Claude Code always copies the full response into `result`, so for
          // normal turns the text was already streamed via Text deltas.  Slash
          // commands (e.g. /cost) produce *only* a result — no text deltas.
          const hasStreamedText = this._currentBlocks.some((b) => b.type === 'text');
          if (!hasStreamedText) {
            this._currentBlocks = [
              ...this._currentBlocks,
              { type: 'text', content: chunk.data.result_text },
            ];
          }
        }
        const resolvedModel = chunk.data.model ?? (this._model || undefined);
        const meta = buildEntryMeta(chunk.data, resolvedModel);
        if (this._currentBlocks.length > 0) {
          const assistantUuid = chunk.data.assistant_uuid;
          const assistantEntry: ChatMessage = {
            role: 'assistant',
            blocks: [...this._currentBlocks],
            timestamp: Date.now(),
            uuid: assistantUuid,
            uuid_status: assistantUuid ? 'Committed' : undefined,
          };
          if (meta) {
            assistantEntry.meta = meta;
          }
          this._messages = [...this._messages, assistantEntry];
          this._currentBlocks = [];
        }
        this.isStreaming = false;
        if (chunk.data.usage) {
          this._totalOutputTokens += chunk.data.usage.output_tokens;
        }
        if (chunk.data.context_window_size) {
          this._contextWindowSize = chunk.data.context_window_size;
        }
        this._sessionStats = {
          session_id: chunk.data.session_id,
          total_cost: chunk.data.total_cost ?? 0,
          usage: chunk.data.usage,
          model: resolvedModel,
          rate_limit: this._rateLimit ?? undefined,
          context_window_size: this._contextWindowSize,
          total_output_tokens: this._totalOutputTokens,
        };
        // ADR-042/043 — once the backend has committed a session id,
        // attach the patch-stream subscription so future events update
        // the state-tree signal in lock-step with the legacy chunk path.
        // Idempotent for the same session id.
        if (chunk.data.session_id) {
          void this.subscribeToSession(chunk.data.session_id);
        }
        break;
      }

      case 'UserMessageCommit': {
        // ADR-046: the parser has seen `user.message.id` for the most recent
        // user prompt. Commit it onto the last user entry that still lacks a
        // UUID — walking from the end handles out-of-order arrivals where the
        // commit chunk lands after several intermediate events.
        const uuid = chunk.data.uuid;
        const idx = findLastUserIndexMissingUuid(this._messages);
        if (idx >= 0) {
          const updated: ChatMessage = {
            ...this._messages[idx],
            uuid,
            uuid_status: 'Committed',
          };
          this._messages = [
            ...this._messages.slice(0, idx),
            updated,
            ...this._messages.slice(idx + 1),
          ];
        }
        break;
      }

      case 'Error':
        this._currentBlocks = [
          ...this._currentBlocks,
          { type: 'error', content: chunk.data.content },
        ];
        // Finalize as error turn
        this._messages = [
          ...this._messages,
          { role: 'assistant', blocks: [...this._currentBlocks], timestamp: Date.now() },
        ];
        this._currentBlocks = [];
        this.isStreaming = false;
        break;

      case 'QueueDrained': {
        // ADR-045: backend sent the queued payload to stdin as the next
        // turn. Mirror that into local state so the composer's "queued: …"
        // line clears, and synthesise the user entry so the streamed
        // response below has its retry anchor in place.
        this._pendingQueue = null;
        this._messages = [
          ...this._messages,
          {
            role: 'user',
            blocks: [{ type: 'text', content: chunk.data.text }],
            timestamp: Date.now(),
          },
        ];
        this.isStreaming = true;
        this._turnId += 1;
        this._currentBlocks = [];
        break;
      }

      default:
        return; // unknown chunk type — no state change, no notification
    }
    this.notifyChange();
  }

  /** Clears all chat state to start a fresh conversation. */
  resetForNewConversation(): void {
    console.debug('[chat-state] resetForNewConversation');
    this._messages = [];
    this._currentBlocks = [];
    this.isStreaming = false;
    this._sessionStats = null;
    this._model = '';
    this._rateLimit = null;
    this._totalOutputTokens = 0;
    this._contextWindowSize = 200_000;
    this._pendingQueue = null;
    this.initialized = false;
    this.startingSession = false;
    this.notifyChange();
  }

  /**
   * Replaces the current messages with a pre-loaded set (e.g. from a transcript).
   * @param msgs - The messages to load.
   */
  loadMessages(msgs: ChatMessage[]): void {
    this._messages = msgs;
    this.notifyChange();
  }

  /**
   * Seeds the session id immediately after a resume so retry / queue can run
   * without waiting for the first `Result` event. Stamps a minimal stats
   * object — token counters / cost stay zero until the next live turn fills
   * them in.
   * @param sessionId - Resumed JSONL session uuid.
   */
  seedResumedSession(sessionId: string): void {
    if (!sessionId) return;
    if (this._sessionStats?.session_id === sessionId) return;
    this._sessionStats = {
      session_id: sessionId,
      total_cost: this._sessionStats?.total_cost ?? 0,
      context_window_size: this._sessionStats?.context_window_size ?? 200_000,
      total_output_tokens: this._sessionStats?.total_output_tokens ?? 0,
      ...(this._sessionStats?.usage ? { usage: this._sessionStats.usage } : {}),
      ...(this._sessionStats?.model ? { model: this._sessionStats.model } : {}),
      ...(this._sessionStats?.rate_limit ? { rate_limit: this._sessionStats.rate_limit } : {}),
    };
    this.notifyChange();
  }

  /**
   * Queue a message to be sent as the next turn (ADR-045). Replace
   * semantics — calling this while a slot is already occupied displaces the
   * previous queued message and returns its preview text. Returns `null`
   * when the slot was empty before this call.
   *
   * The composer calls this when the user hits send while
   * `isStreaming === true`. Backend drains the slot when the running turn
   * emits its `Result` event.
   * @param text - The message to queue.
   */
  async queueMessage(text: string): Promise<string | null> {
    const sessionId = this._sessionStats?.session_id;
    if (!sessionId || !text) return null;
    try {
      const prior = await this.tauri.invoke<{ text: string; queued_at: number } | null>(
        'queue_message',
        { sessionId, text }
      );
      this._pendingQueue = { text, queued_at: Date.now() };
      this.notifyChange();
      return prior?.text ?? null;
    } catch (err) {
      console.warn('[chat-state] queueMessage: backend invoke failed', err);
      return null;
    }
  }

  /**
   * Cancel the queued message for the active session. No-op when no slot
   * is occupied or no session is active. Composer wires this to the X
   * button on the "queued: …" preview line.
   */
  async cancelQueuedMessage(): Promise<void> {
    const sessionId = this._sessionStats?.session_id;
    if (!sessionId) {
      // No session yet — but local slot may still be set if we got ahead
      // of the first Result. Clear locally either way.
      this._pendingQueue = null;
      this.notifyChange();
      return;
    }
    try {
      await this.tauri.invoke('cancel_queued_message', { sessionId });
    } catch (err) {
      console.warn('[chat-state] cancelQueuedMessage: backend invoke failed', err);
    }
    this._pendingQueue = null;
    this.notifyChange();
  }

  /**
   * Copies the textual content of the message at `index` to the system
   * clipboard. Returns `true` on success, `false` on failure (out-of-range
   * index, missing `navigator.clipboard`, write rejection). Block kinds that
   * carry no user-facing prose — `tool_use`, `thinking`, `ask_user` — are
   * elided; `text` and `error` blocks are joined with a blank line.
   *
   * The component layer owns the "copied" indicator timing so this method can
   * stay pure and testable.
   * @param index - Index into `messages` of the entry to copy.
   */
  async copyMessage(index: number): Promise<boolean> {
    const msg = this._messages[index];
    if (!msg) return false;
    const text = blocksToPlainText(msg.blocks);
    if (!text) return false;
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn('[chat-state] copyMessage: clipboard write failed', err);
      return false;
    }
  }

  /**
   * Returns whether the last assistant turn can be retried (ADR-046).
   * Requires:
   *   - not streaming (would race with the live turn),
   *   - a session id from the most recent Result chunk,
   *   - a user entry preceding the last assistant entry whose UUID is committed.
   *
   * The component layer reads this on every change-detection cycle to gate
   * the retry button — it must be cheap and side-effect free.
   */
  canRetryLastAssistant(): boolean {
    return this.findRetryAnchor() !== null;
  }

  /**
   * Walks the message list from the end to find the retry anchor: the user
   * entry immediately preceding the last committed assistant entry. Returns
   * `null` when no such pair exists, when streaming, or when the session id
   * is missing.
   */
  private findRetryAnchor(): {
    sessionId: string;
    userUuid: string;
    lastAssistantIdx: number;
    userIdx: number;
  } | null {
    if (this.isStreaming) return null;
    const sessionId = this._sessionStats?.session_id;
    if (!sessionId) return null;
    let lastAssistantIdx = -1;
    for (let i = this._messages.length - 1; i >= 0; i -= 1) {
      if (this._messages[i].role === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx < 0) return null;
    const assistant = this._messages[lastAssistantIdx];
    if (assistant.uuid_status && assistant.uuid_status !== 'Committed') return null;
    for (let i = lastAssistantIdx - 1; i >= 0; i -= 1) {
      const m = this._messages[i];
      if (m.role !== 'user') continue;
      if (!m.uuid || (m.uuid_status && m.uuid_status !== 'Committed')) return null;
      return { sessionId, userUuid: m.uuid, lastAssistantIdx, userIdx: i };
    }
    return null;
  }

  /**
   * Retries the last assistant turn via the backend `retry_last_turn` Tauri
   * command (ADR-046). Trims the last assistant entry from local state,
   * stamps `edited_at` on the anchor user entry, flips `isStreaming` so the
   * input bar disables and the next stream chunks are accepted, and asks the
   * backend to relaunch Claude Code with `--resume-session-at`.
   *
   * On backend failure the optimistic state changes are reverted and an error
   * block is appended so the user sees what went wrong.
   */
  async retryLastAssistant(): Promise<void> {
    const anchor = this.findRetryAnchor();
    if (!anchor) return;
    const { sessionId, userUuid, lastAssistantIdx, userIdx } = anchor;

    const trimmed = this._messages.slice(0, lastAssistantIdx);
    trimmed[userIdx] = { ...trimmed[userIdx], edited_at: Date.now() };
    const before = this._messages;
    this._messages = trimmed;
    this._currentBlocks = [];
    this.isStreaming = true;
    this._turnId += 1;
    this.notifyChange();

    try {
      await this.tauri.invoke('retry_last_turn', {
        sessionId,
        userUuid,
      });
    } catch (err) {
      console.error('[chat-state] retryLastAssistant: invoke failed', err);
      this._messages = [
        ...before,
        {
          role: 'assistant',
          blocks: [{ type: 'error', content: `Retry failed: ${err}` }],
          timestamp: Date.now(),
        },
      ];
      this._currentBlocks = [];
      this.isStreaming = false;
      this.notifyChange();
    }
  }

  /**
   * Subscribes to ProjectStateService for project switching lifecycle.
   * On switching: clears chat state immediately (cross-project leak prevention).
   */
  private setupProjectStateListeners(): void {
    this.unsubProjectChange = this.projectState.onChange(() => {
      if (this.projectState.status === 'switching') {
        this._messages = [];
        this._currentBlocks = [];
        this.isStreaming = false;
        this._sessionStats = null;
        this._model = '';
        this._rateLimit = null;
        this._totalOutputTokens = 0;
        this._contextWindowSize = 200_000;
        this.notifyChange();
      }
    });
  }

  /** Sets up the Tauri event listener for streaming chat responses. */
  private async setupStreamListener(): Promise<void> {
    try {
      this.unlisten = await this.tauri.listen<StreamChunk>('chat_stream', (event) => {
        const chunk = event.payload;
        // Metadata-only chunks never mutate _messages / _currentBlocks and
        // are legitimate between or after turns (e.g. trailing RateLimit).
        if (chunk.chunk_type === 'SystemInit' || chunk.chunk_type === 'RateLimit') {
          this.handleStreamChunk(chunk);
          return;
        }
        // Content-bearing chunks belong to a specific turn. If isStreaming is
        // false (stopConversation already ran, or the turn already finished),
        // drop the chunk so it cannot write into _messages or flip isStreaming
        // back on. That single check is sufficient in single-threaded JS:
        // stopConversation sets isStreaming = false synchronously before any
        // await, so every subsequent event-loop tick observes the reset.
        if (!this.isStreaming) return;
        this.handleStreamChunk(chunk);
      });
    } catch (err) {
      if (this.tauri.isRunningInTauri()) {
        console.error('Failed to set up stream listener:', err);
        this.projectState.status = 'error';
        this.projectState.error = `Failed to set up stream listener: ${err}`;
      }
    }
  }

  /**
   * ADR-042/043 — subscribe to a session's JSON-Patch stream.
   *
   * Calls the `subscribe_session` Tauri command, listens on the resolved
   * `chat_patch::<session_id>` event channel, and routes each `LogMsg`
   * payload through `applyLogMsg`. Idempotent: re-subscribing to the same
   * session is a no-op; switching to a different session unsubscribes
   * the previous one first.
   * @param sessionId The Claude Code session id to subscribe to.
   */
  async subscribeToSession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    if (this.subscribedSessionId === sessionId) return;
    await this.unsubscribeFromSession();
    let ack: { event_name: string };
    try {
      ack = await this.tauri.invoke<{ event_name: string }>('subscribe_session', {
        sessionId,
      });
    } catch (err) {
      console.warn('[chat-state] subscribeToSession: invoke failed', err);
      return;
    }
    try {
      const unlisten = await this.tauri.listen<LogMsgEnvelope>(ack.event_name, (event) => {
        this.applyLogMsg(event.payload);
      });
      this.patchUnlisten = unlisten;
      this.subscribedSessionId = sessionId;
    } catch (err) {
      console.warn('[chat-state] subscribeToSession: listen failed', err);
    }
  }

  /** Drop the active patch subscription, if any. */
  async unsubscribeFromSession(): Promise<void> {
    if (this.patchUnlisten) {
      try {
        this.patchUnlisten();
      } catch (err) {
        console.warn('[chat-state] unsubscribeFromSession failed', err);
      }
      this.patchUnlisten = null;
    }
    this.subscribedSessionId = null;
  }

  /**
   * Apply a single `LogMsg` envelope to the state-tree signal. Pure
   * router — `JsonPatch` runs through the RFC 6902 reducer, `Resync`
   * does a wholesale replace, and lifecycle markers update specific
   * fields. Test-only API: components consume `state` (the read-only
   * signal) instead of calling this directly.
   * @internal
   * @param msg One `LogMsg` envelope from `MsgStore.history_plus_stream()`.
   */
  applyLogMsg(msg: LogMsgEnvelope): void {
    if (msg.type === 'json_patch') {
      try {
        const patch = msg.data as Patch;
        this._state.set(applyPatch(this._state(), patch));
      } catch (err) {
        console.warn('[chat-state] applyLogMsg: bad patch dropped', err);
      }
      return;
    }
    if (msg.type === 'resync') {
      this._state.set(msg.data);
      return;
    }
    if (msg.type === 'session_started') {
      this._state.update((s) => ({ ...s, session_id: msg.data.session_id }));
      return;
    }
    if (msg.type === 'session_ended') {
      this._state.update((s) => ({ ...s, is_streaming: false }));
      return;
    }
  }
}

// ── Immutable helper functions ─────────────────────────────────────────

function appendOrCreateTextBlock(blocks: MessageBlock[], content: string): MessageBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text') {
    return [...blocks.slice(0, -1), { type: 'text', content: last.content + content }];
  }
  return [...blocks, { type: 'text', content }];
}

function appendOrCreateThinkingBlock(blocks: MessageBlock[], content: string): MessageBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'thinking') {
    return [
      ...blocks.slice(0, -1),
      { type: 'thinking', content: last.content + content, collapsed: last.collapsed },
    ];
  }
  return [...blocks, { type: 'thinking', content, collapsed: true }];
}

function updateToolInput(blocks: MessageBlock[], toolId: string, delta: string): MessageBlock[] {
  return blocks.map((b) => {
    if (b.type !== 'tool_use' || b.tool.tool_id !== toolId) return b;
    return { ...b, tool: { ...b.tool, input_json: b.tool.input_json + delta } };
  });
}

/**
 * Builds per-turn metadata for the assistant entry just finalized by a
 * `Result` chunk. Prefers the backend's authoritative `turn_cost`; falls
 * back to `calculateCost()` against the per-model pricing table when the
 * backend didn't provide it. Returns `undefined` when the chunk carries
 * no usage or model information.
 * @param data - Relevant fields copied from the `Result` chunk payload.
 * @param data.turn_usage - Per-turn token usage (required for fallback cost).
 * @param data.turn_cost - Authoritative per-turn cost from the backend.
 * @param data.model - Model id attached to the `Result` chunk, if any.
 * @param resolvedModel - Model id already resolved by the reducer.
 */
function buildEntryMeta(
  data: {
    turn_usage?: TurnUsage;
    turn_cost?: number;
    model?: string;
  },
  resolvedModel: string | undefined
): EntryMeta | undefined {
  const { turn_usage, turn_cost } = data;
  const model = data.model ?? resolvedModel;
  if (!turn_usage && !model && turn_cost === undefined) {
    return undefined;
  }
  const meta: EntryMeta = {};
  if (model) meta.model = model;
  if (turn_usage) meta.usage = turn_usage;

  // Cost: prefer backend turn_cost (authoritative); fallback to computed cost
  // from pricing.ts when usage is available. Leave undefined otherwise so
  // the renderer hides the segment rather than showing $0.000.
  if (turn_cost !== undefined) {
    meta.cost = turn_cost;
  } else if (model && turn_usage) {
    const computed = calculateCost(model, turn_usage);
    if (computed !== null) meta.cost = computed;
  }
  return meta;
}

function completeToolBlock(
  blocks: MessageBlock[],
  data: { tool_id: string; content: string; is_error: boolean }
): MessageBlock[] {
  return blocks.map((b) => {
    if (b.type !== 'tool_use' || b.tool.tool_id !== data.tool_id) return b;
    const base = {
      type: 'tool_use' as const,
      tool_id: b.tool.tool_id,
      tool_name: b.tool.tool_name,
      input_json: b.tool.input_json,
    };
    const tool: ToolUseBlock = data.is_error
      ? { ...base, status: 'error', result: data.content, result_is_error: true }
      : { ...base, status: 'done', result: data.content, result_is_error: false };
    return { ...b, tool };
  });
}

/**
 * Returns the index of the most recent user entry that has not yet had a UUID
 * committed onto it (ADR-046). Returns -1 when no such entry exists. Walking
 * from the end is correct because `UserMessageCommit` chunks always belong to
 * the latest pending user prompt — earlier prompts already carry their UUIDs.
 * @param msgs - Snapshot of `_messages` at the time the commit chunk arrives.
 */
function findLastUserIndexMissingUuid(msgs: readonly ChatMessage[]): number {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m.role === 'user' && !m.uuid) return i;
  }
  return -1;
}

/** Snapshot of the legacy `ChatStateService` fields needed for projection. */
export interface LegacyStateSnapshot {
  messages: readonly ChatMessage[];
  currentBlocks: readonly MessageBlock[];
  isStreaming: boolean;
  pendingQueue: QueuedMessage | null;
  sessionStats: SessionStats | null;
  model: string;
}

/**
 * Project legacy ChatStateService fields onto a `ConversationStateTree`.
 *
 * The patch protocol (ADR-042) defines `state()` as the source of truth.
 * During the bridge period, this projection rebuilds the state-tree from
 * the legacy fields after every mutation so the signal stays consistent
 * without introducing drift. Once a forklift removes the legacy fields,
 * this becomes obsolete.
 * @param src - Snapshot of legacy backing fields.
 */
export function buildStateTreeFromLegacy(src: LegacyStateSnapshot): ConversationStateTree {
  const entries: ConversationEntryState[] = [];
  let nextIdx = 0;
  for (const m of src.messages) {
    entries.push({
      index: nextIdx,
      role: m.role,
      uuid: m.uuid ?? null,
      uuid_status: m.uuid_status === 'Committed' ? 'committed' : 'pending',
      blocks: messageBlocksToState(m.blocks),
      meta: m.meta
        ? {
            model: m.meta.model,
            usage: m.meta.usage,
            cost: m.meta.cost,
          }
        : null,
      edited_at: m.edited_at ?? null,
      timestamp: m.timestamp,
    });
    nextIdx += 1;
  }
  if (src.currentBlocks.length > 0) {
    entries.push({
      index: nextIdx,
      role: 'assistant',
      uuid: null,
      uuid_status: 'pending',
      blocks: messageBlocksToState(src.currentBlocks),
      meta: null,
      edited_at: null,
      timestamp: 0,
    });
  }
  const totals: ConversationStateTree['session_totals'] = {
    input_tokens: src.sessionStats?.usage?.input_tokens ?? 0,
    output_tokens: src.sessionStats?.usage?.output_tokens ?? 0,
    cache_read_tokens: src.sessionStats?.usage?.cache_read_tokens ?? 0,
    cache_write_tokens: src.sessionStats?.usage?.cache_write_tokens ?? 0,
    cost: src.sessionStats?.total_cost ?? 0,
    turn_count: src.messages.filter((m) => m.role === 'assistant').length,
  };
  return {
    session_id: src.sessionStats?.session_id ?? null,
    entries,
    session_totals: totals,
    pending_queue: src.pendingQueue,
    model: src.sessionStats?.model ?? src.model ?? null,
    is_streaming: src.isStreaming,
  };
}

/**
 * Project committed `state().entries` onto the legacy `ChatMessage[]` shape.
 * The trailing live-streaming entry (uuid_status=pending and no meta) is
 * dropped — it lives separately under `currentBlocksFromState`.
 * @param entries - State-tree entries to convert.
 */
export function stateEntriesToChatMessages(
  entries: readonly ConversationEntryState[]
): readonly ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const isLastLive =
      i === entries.length - 1 &&
      e.role === 'assistant' &&
      e.uuid_status !== 'committed' &&
      e.meta === null &&
      e.timestamp === 0; // legacy current-blocks projection sets timestamp=0

    if (isLastLive) continue;
    out.push({
      role: e.role,
      blocks: stateBlocksToMessageBlocks(e.blocks),
      timestamp: e.timestamp,
      uuid: e.uuid ?? undefined,
      uuid_status: e.uuid_status === 'committed' ? 'Committed' : 'Pending',
      meta: e.meta ?? undefined,
      edited_at: e.edited_at ?? undefined,
    });
  }
  return out;
}

/**
 * Convert state-tree blocks back to the legacy MessageBlock union.
 * @param blocks - State-tree blocks to convert.
 */
export function stateBlocksToMessageBlocks(blocks: readonly MessageBlockState[]): MessageBlock[] {
  const out: MessageBlock[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'text':
        out.push({ type: 'text', content: b.content });
        break;
      case 'thinking':
        out.push({ type: 'thinking', content: b.content, collapsed: true });
        break;
      case 'tool_use': {
        const baseTool = {
          type: 'tool_use' as const,
          tool_id: b.tool_id,
          tool_name: b.tool_name,
          input_json: b.input,
        };
        const tool: ToolUseBlock =
          b.result === null
            ? { ...baseTool, status: 'running' }
            : b.is_error
              ? { ...baseTool, status: 'error', result: b.result, result_is_error: true }
              : { ...baseTool, status: 'done', result: b.result, result_is_error: false };
        out.push({ type: 'tool_use', tool });
        break;
      }
      case 'ask_user':
        out.push({
          type: 'ask_user',
          question: {
            tool_id: b.tool_id,
            question: b.question,
            options: b.options.map((o) => ({ label: o.label, value: o.value })),
            header: b.header,
            multi_select: b.multi_select,
            answered: b.answer !== null,
            selected_values: b.answer ? [...b.answer] : [],
          },
        });
        break;
      case 'error':
        out.push({ type: 'error', content: b.content });
        break;
    }
  }
  return out;
}

function messageBlocksToState(blocks: readonly MessageBlock[]): MessageBlockState[] {
  const out: MessageBlockState[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        out.push({ kind: 'text', content: b.content });
        break;
      case 'thinking':
        out.push({ kind: 'thinking', content: b.content });
        break;
      case 'tool_use': {
        const t = b.tool;
        out.push({
          kind: 'tool_use',
          tool_id: t.tool_id,
          tool_name: t.tool_name,
          input: t.input_json,
          result: t.status === 'done' || t.status === 'error' ? t.result : null,
          is_error: t.status === 'error',
        });
        break;
      }
      case 'ask_user':
        out.push({
          kind: 'ask_user',
          tool_id: b.question.tool_id,
          header: b.question.header,
          question: b.question.question,
          options: b.question.options.map((o) => ({ label: o.label, value: o.value })),
          multi_select: b.question.multi_select,
          answer: b.question.answered ? b.question.selected_values : null,
        });
        break;
      case 'error':
        out.push({ kind: 'error', content: b.content });
        break;
      case 'permission_prompt':
        // Permission prompts are not part of the patch state-tree shape;
        // they're an in-flight UI affordance not persisted as conversation.
        // Skipping is consistent with how the backend never emits them as
        // state — they're surfaced via control-request channel.
        break;
    }
  }
  return out;
}

/**
 * Flattens a message's blocks into a copy-friendly plain-text string. Tool
 * inputs and outputs are intentionally elided — the user wants the assistant's
 * prose, not the JSON of every Bash command. Thinking blocks, ask_user, and
 * tool_use are dropped; text and error contents are concatenated with a blank
 * line between blocks for readability.
 * @param blocks - The message blocks to flatten.
 */
export function blocksToPlainText(blocks: readonly MessageBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push(b.content);
    else if (b.type === 'error') parts.push(b.content);
  }
  return parts.join('\n\n').trim();
}
