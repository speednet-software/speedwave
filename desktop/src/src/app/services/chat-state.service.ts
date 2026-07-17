import { Injectable, computed, inject, signal, type Signal } from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { warn as pluginLogWarn } from '@tauri-apps/plugin-log';
import { Clipboard } from '@angular/cdk/clipboard';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import { AnthropicModelsService } from './anthropic-models.service';
import { LoggerService } from './logger.service';
import { isBlankOrSlashOnly, isControlShaped } from '../chat/slash/slash.service';
import {
  DEFAULT_CONTEXT_TOKENS,
  isLocalProvider,
  isTerminalCostSource,
  type LlmConfigResponse,
  type ResponseUsage,
} from '../models/llm';
import {
  DEFAULT_STATE_TREE,
  type ConversationEntryState,
  type ConversationStateTree,
  type MessageBlockState,
} from '../models/state-tree';
import {
  chatInputFromText,
  chatInputToBlocks,
  contextTokensFrom,
  type ChatInput,
  type ChatMessage,
  type MessageBlock,
  type SessionStats,
  type StreamChunk,
  type ToolUseBlock,
  type AskUserQuestionBlock,
  type AskUserQuestionItem,
  type ProjectList,
  type RateLimitInfo,
  type EntryMeta,
  type TurnUsage,
  type QueuedMessage,
  type WireContentBlock,
  type ConversationTranscript,
} from '../models/chat';

// Re-export types consumed by components
export type {
  ChatInput,
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

/**
 * Returns null for anything but the two known backend phrasings.
 * @param raw - Raw error message from the backend.
 */
export function mapContextOverflowError(raw: string): string | null {
  if (/exceeds the available context size/i.test(raw) || /context length exceeded/i.test(raw)) {
    return 'This conversation’s history is larger than the selected model’s context window. Pick a model with a bigger window, or start a new conversation.';
  }
  return null;
}

/**
 * Claude Code's own message points at `/login`, which doesn't apply here.
 * @param raw - Raw error message from the backend.
 */
export function mapNotLoggedInError(raw: string): string | null {
  if (/not logged in/i.test(raw) || /not authenticated/i.test(raw)) {
    return 'Not logged in. Go to Settings and choose an LLM provider.';
  }
  return null;
}

/**
 * Gate predicate: the backend failure means the session is unauthenticated, so the UI
 * routes to auth_required (display mapping stays in `mapNotLoggedInError`).
 * @param msg - Raw error message from the backend.
 */
export function isNotAuthenticatedError(msg: string): boolean {
  return msg.includes('not authenticated');
}

/** Composer model-selector pick handed to `applyModelSelection` (Task 16 contract). */
export interface ModelSelectionInput {
  catalogId: string;
  wireId: string;
  providerId: string;
  kind: string;
}

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
  /** Queue accepted before the session id was known; flushed on first seed. */
  private _queueAwaitingSession = false;
  /** Public read-only accessor for the queued slot. */
  get pendingQueue(): QueuedMessage | null {
    return this._pendingQueue;
  }

  /** Anthropic model chosen while no session was live (composer, Task 16); sent once after the next SystemInit. */
  private readonly _pendingModelOverride = signal<string | null>(null);
  /** Read-only: the composer's queued model switch, or null when none/already sent. */
  readonly pendingModelOverride: Signal<string | null> = this._pendingModelOverride.asReadonly();

  /**
   * Queues an Anthropic model switch to send once the next SystemInit arrives.
   * @param modelId - Wire model id to switch to, or null to clear the queue.
   */
  setPendingModelOverride(modelId: string | null): void {
    this._pendingModelOverride.set(modelId);
  }

  /** Sends the queued override as a normal `/model` message and clears it (fires at most once per queued value). */
  private flushPendingModelOverride(): void {
    const pending = this._pendingModelOverride();
    // Never consume into sendMessage's silent isStreaming drop: keep the queue
    // and retry on the next flush point (SystemInit / turn end) instead.
    if (!pending || this.isStreaming) return;
    this._pendingModelOverride.set(null);
    void this.sendMessage(`/model ${pending}`);
  }

  /** Surface for a failed write-through from the composer model selector. */
  private readonly _modelSelectionError = signal('');
  /** Read-only: last composer write-through error, or '' when none. */
  readonly modelSelectionError: Signal<string> = this._modelSelectionError.asReadonly();

  /**
   * The single handler for a composer model-selector pick (Task 16): config
   * write first for non-anthropic kinds, then live wire switch / pending override.
   * @param sel - Selected model triad emitted by the model selector.
   */
  async applyModelSelection(sel: ModelSelectionInput): Promise<void> {
    this._modelSelectionError.set('');
    const isAnthropic = sel.kind === 'anthropic_oauth' || sel.kind === 'anthropic_api_key';
    if (!isAnthropic) {
      try {
        await this.anthropicModels.setProviderModel(
          this.projectState.activeProject() ?? '',
          sel.providerId,
          sel.catalogId
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log.warn(`model selection write-through failed: ${msg}`);
        this._modelSelectionError.set(msg);
        return;
      }
    }
    if (this.hasLiveSession()) {
      // Mid-turn sendMessage silently drops on isStreaming; queue for turn end.
      if (this.isStreaming) this.setPendingModelOverride(sel.wireId);
      else await this.sendMessage(`/model ${sel.wireId}`);
    } else if (isAnthropic) {
      this.setPendingModelOverride(sel.wireId);
    }
  }

  /** True once a session id has been seeded for the current conversation. */
  private hasLiveSession(): boolean {
    return this._lastKnownSessionId !== null;
  }

  /** Session cost/usage stats signal — drives the OnPush footer reactively. */
  private readonly _sessionStats = signal<SessionStats | null>(null);
  /** Session cost/usage stats from the most recent result. */
  get sessionStats(): SessionStats | null {
    return this._sessionStats();
  }
  /** Read-only signal mirror so OnPush components re-render on stats changes. */
  readonly sessionStatsFromState: Signal<SessionStats | null> = this._sessionStats.asReadonly();

  /** Context tokens of the last main-chain API call; survives stream reset. */
  get lastContextTokens(): number | null {
    return this._lastContextTokens;
  }

  private _model = '';
  private _rateLimit: RateLimitInfo | null = null;
  private _totalOutputTokens = 0;
  private _lastContextTokens: number | null = null;
  /** Context window for the active model; `null` until populated or if unknown. */
  private _contextWindowSize: number | null = null;
  /** Active LLM provider id from `get_llm_config().provider`. */
  private _currentProvider: string | null = null;

  /** Last-known persisted context window from `claude.llm.context_tokens`. */
  private _persistedContextTokens: number | null = null;

  /** Monotonically increasing turn id; bumped on `sendMessage` and `stopConversation`. */
  private _turnId = 0;
  /** Test-only read access. */
  get turnId(): number {
    return this._turnId;
  }

  private unlisten: UnlistenFn | null = null;
  private listenerReady = false;
  private initialized = false;
  private startingSession = false;
  /**
   * Bumped whenever a resume supersedes the session; a stale background
   * start_chat that finishes later no-ops instead of clobbering the resume.
   */
  private _sessionGeneration = 0;

  /** Durable session id; survives a container restart that nulls live stats. */
  private _lastKnownSessionId: string | null = null;
  /** Optimistic session id stamped on resume (drawer accent before first Result). */
  private _optimisticSessionId: string | null = null;
  /** Re-entrancy guard for resumeConversation. */
  private _resumeInProgress = false;
  /** Set by a mounted ChatComponent to ask the user on context overflow; null when unmounted. */
  private _resumeDecider: (() => Promise<'resume' | 'fresh'>) | null = null;

  /** Durable session id (test/Component read). */
  get lastKnownSessionId(): string | null {
    return this._lastKnownSessionId;
  }
  /** Optimistic resume stamp (read by the view-session-id getter). */
  get optimisticSessionId(): string | null {
    return this._optimisticSessionId;
  }

  /**
   * Unregistering (null) makes overflow default to auto-resume.
   * @param cb - Decider callback, or null to unregister.
   */
  setResumeDecider(cb: (() => Promise<'resume' | 'fresh'>) | null): void {
    this._resumeDecider = cb;
  }

  /** Clears durable + optimistic session tracking (new conversation / delete). */
  clearSessionTracking(): void {
    this._lastKnownSessionId = null;
    this._optimisticSessionId = null;
  }

  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private anthropicModels = inject(AnthropicModelsService);
  private clipboard = inject(Clipboard);
  private log = inject(LoggerService);
  private unsubProjectChange: (() => void) | null = null;

  /** ADR-042 — full state-tree signal, rebuilt after every mutation. */
  private readonly _state = signal<ConversationStateTree>({ ...DEFAULT_STATE_TREE });
  /** Public read-only signal exposed to components. */
  readonly state: Signal<ConversationStateTree> = this._state.asReadonly();

  /** ADR-042 — committed state-tree entries projected onto `ChatMessage[]`. */
  readonly messagesFromState: Signal<readonly ChatMessage[]> = computed(() =>
    stateEntriesToChatMessages(this._state().entries)
  );

  /** ADR-042 — projection of `state().is_streaming` onto a signal. */
  readonly isStreamingFromState: Signal<boolean> = computed(() => this._state().is_streaming);

  /** True while a resumed conversation's transcript is being fetched. */
  private readonly _loadingTranscript = signal<boolean>(false);
  /** Read-only signal: drives the transcript-loading spinner. */
  readonly loadingTranscriptFromState: Signal<boolean> = this._loadingTranscript.asReadonly();

  /** Mark the start of a transcript fetch (shows the loader). */
  beginTranscriptLoad(): void {
    this._loadingTranscript.set(true);
  }

  /** Mark the end of a transcript fetch (hides the loader). */
  endTranscriptLoad(): void {
    this._loadingTranscript.set(false);
  }

  /**
   * Mark a session start in progress (resume) so a concurrent `sendMessage` waits;
   * bumps the generation to no-op in-flight starts. Returns a flag-clearing disposer.
   */
  beginStartingSession(): () => void {
    this.startingSession = true;
    this._sessionGeneration += 1;
    return () => {
      this.startingSession = false;
    };
  }

  /** Signal mirror of {@link canRetryLastAssistant}. */
  readonly retryEnabled: Signal<boolean> = computed(() => {
    const tree = this._state();
    if (tree.is_streaming || !tree.session_id) return false;
    return findRetryAnchorIn(tree.entries, 'committed') !== null;
  });

  /** ADR-042 — projection of the live (uncommitted) trailing entry's blocks. */
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

  /**
   * Test-only setter for private backing fields.
   * @param state - Partial state to merge into the service.
   * @internal
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
    if (state.sessionStats !== undefined) this._sessionStats.set(state.sessionStats);
    if (state.pendingQueue !== undefined) this._pendingQueue = state.pendingQueue;
  }

  /** Rebuilds the state-tree signal from legacy fields after a mutation. */
  private notifyChange(): void {
    this.rebuildStateTree();
  }

  /** Project legacy fields onto a fresh `ConversationStateTree` and write `_state`. */
  private rebuildStateTree(): void {
    this._state.set(
      buildStateTreeFromLegacy({
        messages: this._messages,
        currentBlocks: this._currentBlocks,
        isStreaming: this.isStreaming,
        pendingQueue: this._pendingQueue,
        sessionStats: this._sessionStats(),
        model: this._model,
      })
    );
  }

  /** Ensures the stream listener runs exactly once. Waits for project ready before starting chat. */
  async init(): Promise<void> {
    this.log.debug(
      `[chat-state] init: listenerReady=${this.listenerReady} initialized=${this.initialized}`
    );
    if (!this.listenerReady) {
      this.listenerReady = true;
      await this.setupStreamListener();
      this.setupProjectStateListeners();
      this.setupRestartResumeListeners();
      // Best-effort cache warm so the chat footer has a context window
      // ready before the first Result chunk lands.
      void this.refreshLlmConfigCache();
    }
    if (!this.initialized) {
      this.initialized = true;
      // Start session in background (UI stays responsive); sendMessage
      // auto-retries on "no active session" if a message races start_chat.
      if (this.projectState.status() === 'ready') {
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
    const project = this.projectState.activeProject();
    // A resume owns the session; a remount must not clobber it with a fresh start.
    // newConversation/delete null _lastKnownSessionId, so this gates only resume.
    if (this._resumeInProgress || this._lastKnownSessionId) {
      this.log.debug('[chat-state] startChatSession: skipped (resume owns the session)');
      return;
    }
    if (project && !this.startingSession) {
      this.startingSession = true;
      const gen = this._sessionGeneration;
      this.log.debug(`[chat-state] startChatSession: project=${project}`);
      try {
        await this.tauri.invoke('start_chat', { project });
        this.log.debug('[chat-state] startChatSession: success');
      } catch (err) {
        // A resume superseded this start while it was in flight — don't surface
        // its failure as the resumed session's error.
        if (gen !== this._sessionGeneration) {
          this.log.debug('[chat-state] startChatSession: superseded by resume, ignoring');
          return;
        }
        const msg = String(err);
        if (isNotAuthenticatedError(msg)) {
          this.projectState.status.set('auth_required');
          this.notifyChange();
        } else {
          // Non-auth start failure is fatal — surface it in project state so
          // the UI shows an error instead of a silently dead chat.
          this.log.error(`[chat-state] Failed to start chat session: ${msg}`);
          this.projectState.status.set('error');
          this.projectState.error = `Failed to start chat session: ${msg}`;
          this.notifyChange();
        }
      } finally {
        this.startingSession = false;
      }
    }
  }

  /**
   * Accepts a plain string (text-only) or `ChatInput` with attachments.
   * @param input - Raw text or composer bundle.
   * @param displayText - Overrides the bubble's surface text (plan-mode prefix flow).
   */
  async sendMessage(input: string | ChatInput, displayText?: string): Promise<void> {
    const chatInput: ChatInput = typeof input === 'string' ? chatInputFromText(input) : input;
    const wireBlocks: WireContentBlock[] = chatInputToBlocks(chatInput);
    const hasContent = wireBlocks.length > 0;
    if (!hasContent || this.isStreaming) return;
    // Drop whitespace-only or bare-slash input before streaming; hasContent
    // misses these and the backend would bail with a stray error bubble.
    if (chatInput.attachments.length === 0 && isBlankOrSlashOnly(chatInput.text)) return;
    this.log.debug(`[chat-state] sendMessage: isStreaming=${this.isStreaming}`);

    const displayBlocks: MessageBlock[] = [];
    const surfaceText = displayText ?? chatInput.text;
    if (surfaceText.length > 0) {
      displayBlocks.push({ type: 'text', content: surfaceText });
    }
    for (const att of chatInput.attachments) {
      // State-tree carries metadata only (ADR-065); bytes live on disk.
      displayBlocks.push({ type: 'image', media_type: att.mediaType, alt: att.filename });
    }
    // A control-shaped send (`/model x`, `/effort y`) arrives via a `ControlChip`
    // stream event instead — skip the optimistic bubble to avoid double-rendering.
    // Must check the wire text (what the backend's parse_control_command sees),
    // not the display text — plan mode prefixes only the wire text.
    const isControlSend = chatInput.attachments.length === 0 && isControlShaped(chatInput.text);
    if (!isControlSend) {
      this._messages = [
        ...this._messages,
        {
          role: 'user',
          blocks: displayBlocks,
          timestamp: Date.now(),
        },
      ];
    }
    this.isStreaming = true;
    this._turnId += 1;
    this._currentBlocks = [];
    this.notifyChange();

    const invokeArgs = { blocks: wireBlocks, displayText: surfaceText };
    try {
      await this.tauri.invoke('send_message', invokeArgs);
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
              await this.tauri.invoke('send_message', invokeArgs);
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
            await this.tauri.invoke('send_message', invokeArgs);
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
          if (isNotAuthenticatedError(retryMsg)) {
            this.projectState.status.set('auth_required');
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
   * Records one slot's answer for a multi-question AskUserQuestion block.
   * @param toolUseId - Tool_use_id of the AskUserQuestion control_request.
   * @param questionIdx - Slot index being answered (0-based).
   * @param value - Chosen value (multi-select labels pre-joined with `", "`).
   */
  async submitAnswer(toolUseId: string, questionIdx: number, value: string): Promise<void> {
    const capturedTurn = this._turnId;

    // Snapshot the pre-mutation current_index so the error path reverts precisely
    // (resetting to questionIdx breaks on out-of-order submits).
    let prevIndex: number | null = null;

    this._currentBlocks = this._currentBlocks.map((b) => {
      if (b.type !== 'ask_user' || b.question.tool_id !== toolUseId) return b;
      const answers = b.question.answers.slice();
      if (questionIdx < 0 || questionIdx >= answers.length) return b;
      prevIndex = b.question.current_index;
      answers[questionIdx] = value;
      const nextNull = answers.findIndex((a) => a === null);
      const nextIndex = nextNull === -1 ? answers.length : nextNull;
      return {
        ...b,
        question: { ...b.question, answers, current_index: nextIndex },
      };
    });
    this.notifyChange();

    try {
      await this.tauri.invoke('submit_question_answer', {
        toolUseId,
        questionIdx,
        answer: value,
      });
    } catch (err) {
      // If stop ran while submit was in flight (`_turnId` moved on), suppress the
      // error: the user cancelled, so a "Broken pipe" surfacing is just noise.
      if (capturedTurn !== this._turnId) {
        this.log.debug(`[chat-state] submitAnswer: suppressing error after stop: ${String(err)}`);
        return;
      }
      this.isStreaming = false;
      const indexBeforeMutation = prevIndex ?? questionIdx;
      this._currentBlocks = this._currentBlocks.map((b) => {
        if (b.type !== 'ask_user' || b.question.tool_id !== toolUseId) return b;
        const answers = b.question.answers.slice();
        if (questionIdx < 0 || questionIdx >= answers.length) return b;
        answers[questionIdx] = null;
        return {
          ...b,
          question: { ...b.question, answers, current_index: indexBeforeMutation },
        };
      });
      this._currentBlocks = [
        ...this._currentBlocks,
        { type: 'error', content: `Failed to send answer: ${err}` },
      ];
      this.notifyChange();
    }
  }

  /**
   * Stops the current Claude turn (no-op when not streaming). Resets UI state
   * synchronously to re-enable input, then fires the backend stop in background.
   */
  async stopConversation(): Promise<void> {
    if (!this.isStreaming) return;

    // 1. Invalidate any in-flight / buffered stream events from the dying turn.
    this._turnId += 1;

    // 2. Synchronous UI reset, before any await, so re-entrant calls early-return.
    this.isStreaming = false;

    // 3. Keep the partial reply; drop ask_user blocks; mark running tools errored.
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

    // 4. Fire the backend interrupt. "no active session" is benign (idle/exited);
    //    any other failure means the turn may still run, so surface an error.
    try {
      await this.tauri.invoke('stop_chat');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('no active session')) {
        this.log.debug(`[chat-state] stopConversation: backend already idle: ${msg}`);
        return;
      }
      this.log.error(`[chat-state] stopConversation: invoke failed: ${msg}`);
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
          questions: chunk.data.questions,
          current_index: chunk.data.current_index,
          answers: chunk.data.questions.map(() => null),
        };
        this._currentBlocks = [...this._currentBlocks, { type: 'ask_user', question: askBlock }];
        break;
      }

      case 'SystemInit':
        if (chunk.data.model) this._model = chunk.data.model;
        // ADR-045: seed the session id at stream start so queue/retry work
        // during the FIRST turn (before any Result carries it).
        if (chunk.data.session_id) {
          this.seedSessionId(chunk.data.session_id);
          void this.flushDeferredQueue(chunk.data.session_id);
        }
        this.flushPendingModelOverride();
        break;

      case 'ControlChip': {
        const { command, argument, uuid } = chunk.data;
        this._messages = [
          ...this._messages,
          {
            role: 'user',
            blocks: [{ type: 'chip', command, argument }],
            timestamp: Date.now(),
            ...(uuid ? { uuid, uuid_status: 'Committed' as const } : {}),
          },
        ];
        break;
      }

      case 'RateLimit':
        if (chunk.data.utilization !== null) {
          this._rateLimit = {
            status: chunk.data.status,
            utilization: chunk.data.utilization,
            resets_at: chunk.data.resets_at,
          };
          const cur = this._sessionStats();
          if (cur) {
            this._sessionStats.set({ ...cur, rate_limit: this._rateLimit });
          }
        }
        break;

      case 'Result': {
        if (chunk.data.result_text) {
          // Append result_text only when no streamed text blocks exist (e.g. slash commands).
          const hasStreamedText = this._currentBlocks.some((b) => b.type === 'text');
          if (!hasStreamedText) {
            this._currentBlocks = [
              ...this._currentBlocks,
              { type: 'text', content: chunk.data.result_text },
            ];
          }
        }
        const resolvedModel = chunk.data.model ?? (this._model || undefined);
        // Suppress the live cost preview for local (no real cost; reconcile confirms null).
        const meta = buildEntryMeta(
          chunk.data,
          resolvedModel,
          isLocalProvider(this._currentProvider)
        );
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
        this._contextWindowSize = this.resolveContextWindow(
          chunk.data.context_window_size,
          resolvedModel
        );
        // Local has no real cost; Claude Code's estimate is meaningless → null
        // (no $0.00x flicker before reconcile confirms the free/null SSOT value).
        const livePreviewCost =
          !isLocalProvider(this._currentProvider) &&
          typeof chunk.data.total_cost === 'number' &&
          Number.isFinite(chunk.data.total_cost)
            ? chunk.data.total_cost
            : null;
        // The parser retains the last main-chain call across turns; a Result
        // without one (no API call yet) keeps the previous/seeded meter value.
        const contextUsage = chunk.data.context_usage ?? this._sessionStats()?.context_usage;
        this._sessionStats.set({
          session_id: chunk.data.session_id,
          total_cost: livePreviewCost,
          usage: chunk.data.usage,
          context_usage: contextUsage,
          model: resolvedModel,
          rate_limit: this._rateLimit ?? undefined,
          context_window_size: this._contextWindowSize,
          total_output_tokens: this._totalOutputTokens,
        });
        // Durable id so a later container restart (model switch) can resume this session.
        if (chunk.data.session_id) {
          this._lastKnownSessionId = chunk.data.session_id;
          void this.flushDeferredQueue(chunk.data.session_id);
        }
        // A pick made mid-turn was queued; the turn just ended, so send it now.
        this.flushPendingModelOverride();
        if (contextUsage) {
          this._lastContextTokens = contextTokensFrom(contextUsage);
        }
        // Reconcile footer + per-message cost from the proxy SSOT (CC is a preview).
        void this.reconcileFooterCost(chunk.data.assistant_uuid);
        break;
      }

      case 'UserMessageCommit': {
        // ADR-046: commit the parsed UUID onto the last user entry missing one.
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

      case 'Error': {
        const errContent =
          mapContextOverflowError(chunk.data.content) ??
          mapNotLoggedInError(chunk.data.content) ??
          chunk.data.content;
        this._currentBlocks = [...this._currentBlocks, { type: 'error', content: errContent }];
        this._messages = [
          ...this._messages,
          { role: 'assistant', blocks: [...this._currentBlocks], timestamp: Date.now() },
        ];
        this._currentBlocks = [];
        this.isStreaming = false;
        break;
      }

      case 'QueueDrained': {
        // ADR-045: backend sent the queued payload to stdin; mirror to local state.
        this._pendingQueue = null;
        this._queueAwaitingSession = false;
        // A control-shaped drained text already arrived as a ControlChip (emitted
        // just before QueueDrained) — the chip IS the message, skip the plain bubble.
        if (!isControlShaped(chunk.data.text)) {
          this._messages = [
            ...this._messages,
            {
              role: 'user',
              blocks: [{ type: 'text', content: chunk.data.text }],
              timestamp: Date.now(),
            },
          ];
        }
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

  /**
   * Resets the per-conversation stream/usage fields shared by new-conversation
   * and project-switch clears. Callers add their own extra fields + notify.
   */
  private resetCoreStreamState(): void {
    this._messages = [];
    this._currentBlocks = [];
    this.isStreaming = false;
    this._sessionStats.set(null);
    this._model = '';
    this._rateLimit = null;
    this._totalOutputTokens = 0;
    this._contextWindowSize = null;
  }

  /** Clears all chat state to start a fresh conversation. */
  resetForNewConversation(): void {
    this.log.debug('[chat-state] resetForNewConversation');
    this.resetCoreStreamState();
    this._pendingQueue = null;
    this._queueAwaitingSession = false;
    this.initialized = false;
    this.startingSession = false;
    this.clearSessionTracking();
    this.notifyChange();
  }

  /**
   * Replaces the current messages with a pre-loaded set (e.g. from a transcript).
   * @param msgs - The messages to load.
   */
  loadMessages(msgs: ChatMessage[]): void {
    this._messages = msgs;
    this.notifyChange();
    // Re-reconcile the last turn from the proxy SSOT — corrects a cost that was
    // still `deferred` when the live retry gave up. Terminal costs are idempotent.
    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant' && m.uuid);
    if (lastAssistant?.uuid) {
      void this.reconcileFooterCost(lastAssistant.uuid);
    }
  }

  /**
   * Seeds the session id (resume or stream-start SystemInit) so retry / queue
   * can run before the first `Result`.
   * @param sessionId - Session uuid from a resume or a SystemInit chunk.
   */
  seedSessionId(sessionId: string): void {
    if (!sessionId) return;
    this._lastKnownSessionId = sessionId;
    const cur = this._sessionStats();
    if (cur?.session_id === sessionId) return;
    // The seed is replaced as soon as the next `Result` chunk arrives with
    // an authoritative `context_window_size`.
    const seeded = this.resolveContextWindow(undefined, cur?.model);
    this._sessionStats.set({
      total_cost: null,
      context_window_size: seeded,
      total_output_tokens: 0,
      ...cur,
      session_id: sessionId,
    });
    this.notifyChange();
  }

  /**
   * Queue a message as the next turn (ADR-045); replace semantics. Before the first session id
   * (init not yet parsed), backend registration defers to {@link flushDeferredQueue} so an early queue is never dropped.
   * @param text - The message to queue.
   */
  async queueMessage(text: string): Promise<string | null> {
    if (!text) return null;
    const prior = this._pendingQueue?.text ?? null;
    this._pendingQueue = { text, queued_at: Date.now() };
    this.notifyChange();
    const sessionId = this._sessionStats()?.session_id;
    if (!sessionId) {
      this._queueAwaitingSession = true;
      return prior;
    }
    try {
      const displaced = await this.tauri.invoke<{ text: string; queued_at: number } | null>(
        'queue_message',
        { sessionId, text }
      );
      return displaced?.text ?? prior;
    } catch (err) {
      this.log.warn(`[chat-state] queueMessage: backend invoke failed: ${String(err)}`);
      return prior;
    }
  }

  /**
   * Registers a deferred queued message once the session id becomes known.
   * @param sessionId - Session id from the first SystemInit or Result seed.
   */
  private async flushDeferredQueue(sessionId: string): Promise<void> {
    if (!this._queueAwaitingSession) return;
    this._queueAwaitingSession = false;
    const queued = this._pendingQueue;
    if (!queued) return;
    try {
      await this.tauri.invoke('queue_message', { sessionId, text: queued.text });
    } catch (err) {
      this.log.warn(`[chat-state] flushDeferredQueue: backend invoke failed: ${String(err)}`);
    }
  }

  /** Cancel the queued message for the active session; no-op when empty. */
  async cancelQueuedMessage(): Promise<void> {
    this._queueAwaitingSession = false;
    const sessionId = this._sessionStats()?.session_id;
    if (!sessionId) {
      // No session yet — clear the local slot anyway.
      this._pendingQueue = null;
      this.notifyChange();
      return;
    }
    try {
      await this.tauri.invoke('cancel_queued_message', { sessionId });
    } catch (err) {
      this.log.warn(`[chat-state] cancelQueuedMessage: backend invoke failed: ${String(err)}`);
    }
    this._pendingQueue = null;
    this.notifyChange();
  }

  /**
   * Copies the message at `index` to the clipboard; elides tool/thinking/ask_user blocks.
   * @param index - Index into `messages` of the entry to copy.
   * @returns `true` on success, `false` on out-of-range / empty / write failure.
   */
  copyMessage(index: number): boolean {
    const msg = this._messages[index];
    if (!msg) return false;
    const text = blocksToPlainText(msg.blocks);
    if (!text) return false;
    const ok = this.clipboard.copy(text);
    if (!ok) {
      this.log.warn('[chat-state] copyMessage: clipboard write failed');
    }
    return ok;
  }

  /** Returns whether the last assistant turn can be retried (ADR-046). */
  canRetryLastAssistant(): boolean {
    return this.findRetryAnchor() !== null;
  }

  /** Finds the retry anchor: user entry before the last committed assistant entry. */
  private findRetryAnchor(): {
    sessionId: string;
    userUuid: string;
    lastAssistantIdx: number;
    userIdx: number;
  } | null {
    if (this.isStreaming) return null;
    const sessionId = this._sessionStats()?.session_id;
    if (!sessionId) return null;
    const anchor = findRetryAnchorIn(this._messages, 'Committed');
    return anchor === null ? null : { sessionId, ...anchor };
  }

  /** Retries the last assistant turn via the backend `retry_last_turn` command (ADR-046). */
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
      this.log.error(`[chat-state] retryLastAssistant: invoke failed: ${String(err)}`);
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
      if (this.projectState.status() === 'switching') {
        this.resetCoreStreamState();
        this._persistedContextTokens = null;
        this._currentProvider = null;
        // A genuine project switch starts fresh — never resume the prior project.
        this.clearSessionTracking();
        // A queued override targets the project it was picked in; it must survive
        // a same-project fresh session but never leak across a project switch.
        this._pendingModelOverride.set(null);
        this.notifyChange();
      } else if (this.projectState.status() === 'ready') {
        // Project just settled — re-pull the persisted context tokens so
        // the chat footer reflects whatever the user picked in Settings.
        void this.refreshLlmConfigCache();
      }
    });
  }

  /** Resumes the conversation only after a restart, not a project-switch. */
  private setupRestartResumeListeners(): void {
    this.projectState.onRestartBegin(async () => {
      if (this.isStreaming) await this.stopConversation();
    });
    this.projectState.onRestartComplete(() => {
      void this.decideResumeAfterRestart();
    });
  }

  /** Resume-vs-ask decision after a restart; reads the NEW model's window first. */
  private async decideResumeAfterRestart(): Promise<void> {
    const id = this._lastKnownSessionId;
    if (!id) return;
    // The ready-triggered cache refresh is async and may still hold the previous
    // model's window — re-read so the fit decision sees the post-restart model.
    await this.refreshLlmConfigCache();
    if (historyFitsTarget(this._lastContextTokens, this._persistedContextTokens)) {
      void this.resumeConversation(id);
      return;
    }
    // History may not fit: ask if a chat view is mounted; else auto-resume
    // (the non-lossy choice — never silently drop history on an unmounted view).
    if (this._resumeDecider) {
      const choice = await this._resumeDecider();
      if (choice === 'resume') void this.resumeConversation(id);
      else void this.startFreshSession();
    } else {
      void this.resumeConversation(id);
    }
  }

  /**
   * Resets tracking first so the new session isn't gated by the stale durable id.
   */
  private async startFreshSession(): Promise<void> {
    this.resetForNewConversation();
    await this.startChatSession();
  }

  /**
   * Service-level (not component-level) so it works whether or not a ChatComponent is mounted.
   * @param sessionId - session UUID to resume.
   */
  async resumeConversation(sessionId: string): Promise<void> {
    if (this._resumeInProgress) return;
    this._resumeInProgress = true;
    // Resuming an existing conversation is a context change: a pick queued for the
    // fresh session being composed must not fire into this old transcript instead.
    this._pendingModelOverride.set(null);

    this.resetForNewConversation();
    this.beginTranscriptLoad();
    // Mark start in progress so a racing send waits instead of tearing down this
    // resumed session; disposer released in the `finally` below.
    const endStartingSession = this.beginStartingSession();
    // Stamp session id optimistically so drawer accent follows click without flicker.
    this._optimisticSessionId = sessionId;
    // Early durable stamp: needed even when the transcript fetch fails, so the
    // remount guard in startChatSession and a later restart-resume see this session.
    this._lastKnownSessionId = sessionId;

    try {
      const project = this.projectState.activeProject();
      if (!project) return;

      // Run transcript fetch and resume_conversation in parallel; both independent.
      const transcriptPromise = this.tauri
        .invoke<ConversationTranscript>('get_conversation', { project, sessionId })
        .catch((err) => {
          this.log.error(`[chat-state] get_conversation failed: ${String(err)}`);
          return null;
        });
      const resumePromise = this.tauri.invoke('resume_conversation', { project, sessionId });

      const [transcript] = await Promise.all([transcriptPromise, resumePromise]);
      if (transcript) {
        this.loadMessages(toChatMessages(transcript));
      } else {
        // Resume succeeded but the transcript fetch failed: keep the session
        // live and say why the scrollback is empty instead of failing silently.
        this.loadMessages([
          {
            role: 'assistant',
            blocks: [
              {
                type: 'error' as const,
                content:
                  'Could not load this conversation’s history. The session was resumed — new messages will work, but earlier ones are not shown.',
              },
            ],
            timestamp: Date.now(),
          },
        ]);
      }
      // Seed session id immediately so retry/queue work without waiting for live Result.
      this.seedSessionId(sessionId);
      // Ctx meter + fit-gate from the transcript's last per-call usage, so the
      // footer is truthful before the first live Result of the resumed session.
      this.seedContextFromTranscript();
    } catch (err) {
      // Drop the optimistic accent so a failed resume isn't shown as active.
      this._optimisticSessionId = null;
      this.log.error(`[chat-state] resumeConversation failed: ${String(err)}`);
      const msg = String(err);
      if (isNotAuthenticatedError(msg)) {
        await this.projectState.retryAuth();
      } else {
        this.loadMessages([
          ...this.messagesFromState(),
          {
            role: 'assistant',
            blocks: [{ type: 'error' as const, content: `Failed to resume session: ${err}` }],
            timestamp: Date.now(),
          },
        ]);
      }
    } finally {
      this.endTranscriptLoad();
      endStartingSession();
      this._resumeInProgress = false;
    }
  }

  /**
   * Backoff schedule (ms) for re-reconciling a `deferred` OpenRouter cost.
   * Spans ~60s total: `/generation` can take ~30s+ to price a large turn.
   */
  private static readonly DEFERRED_RECONCILE_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

  /**
   * Reconciles the footer + per-message cost from the proxy SSOT (invariant 6), retrying on a
   * backoff while OpenRouter cost is `deferred`. Best-effort.
   * @param assistantUuid - The `result` event's `assistant_uuid` (== proxy `response_id`).
   * @param attempt - Backoff index for a deferred re-reconcile (0 on the first call).
   */
  private async reconcileFooterCost(assistantUuid: string | undefined, attempt = 0): Promise<void> {
    if (!assistantUuid) return;
    const project = this.projectState.activeProject();
    if (!project) return;
    // A newer turn (or a stop) bumps `_turnId`; abandon a stale deferred retry.
    const capturedTurn = this._turnId;
    try {
      const u = await this.tauri.invoke<ResponseUsage | null>('get_usage_for_response', {
        project,
        responseId: assistantUuid,
      });
      if (!u) return;
      // Non-terminal cost (deferred / no sidecar yet) keeps the live preview;
      // only a terminal cost_source overwrites footer/per-message (deferred retries below).
      if (isTerminalCostSource(u.cost_source)) {
        // Per-message cost from the SSOT; null (unpriced) hides the segment.
        this.overwriteEntryCost(assistantUuid, u.cost_usd);
        // Footer = this conversation's turns only; skipped when no live session.
        const cur = this._sessionStats();
        if (cur) {
          const responseIds = this.conversationResponseIds(assistantUuid);
          const conversationCost = await this.tauri.invoke<number | null>('get_conversation_cost', {
            project,
            responseIds,
          });
          this._sessionStats.set({ ...cur, total_cost: conversationCost });
        }
        this.notifyChange();
      }
      const backoff = ChatStateService.DEFERRED_RECONCILE_BACKOFF_MS;
      if (u.cost_source === 'deferred' && attempt < backoff.length) {
        setTimeout(() => {
          if (capturedTurn === this._turnId) {
            void this.reconcileFooterCost(assistantUuid, attempt + 1);
          }
        }, backoff[attempt]);
      }
    } catch (err) {
      // Footer stays on the live value; reconcile is best-effort.
      this.log.debug(`[chat-state] reconcileFooterCost best-effort failed: ${String(err)}`);
    }
  }

  /**
   * Response ids of the current conversation's assistant turns, for the footer cost sum.
   * @param latestUuid - just-finished turn's assistant uuid (caller guards non-empty).
   */
  private conversationResponseIds(latestUuid: string): string[] {
    const ids = new Set<string>();
    for (const m of this._messages) {
      if (m.role === 'assistant' && m.uuid) ids.add(m.uuid);
    }
    ids.add(latestUuid);
    return [...ids];
  }

  /**
   * Overwrite an assistant entry's per-message cost from the proxy SSOT.
   * @param uuid - Assistant_uuid identifying the entry.
   * @param cost - proxy cost in USD, or null/unpriced → hide the segment.
   */
  private overwriteEntryCost(uuid: string, cost: number | null): void {
    const idx = this._messages.findIndex((m) => m.uuid === uuid && m.meta);
    if (idx < 0) return;
    const m = this._messages[idx];
    const nextCost = typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined;
    this._messages = [
      ...this._messages.slice(0, idx),
      { ...m, meta: { ...m.meta, cost: nextCost } },
      ...this._messages.slice(idx + 1),
    ];
  }

  /** Seeds `context_usage` from the loaded transcript's last assistant per-call usage. */
  private seedContextFromTranscript(): void {
    const usage = findLastNonZeroAssistantUsage(this._messages);
    if (!usage) return;
    this._lastContextTokens = contextTokensFrom(usage);
    const cur = this._sessionStats();
    if (cur) {
      this._sessionStats.set({ ...cur, context_usage: usage });
      this.notifyChange();
    }
  }

  /**
   * Context-window fallback: live → SSOT → persisted → previous → Anthropic default; local
   * stays `null`.
   * @param liveValue - Authoritative value carried by the stream (highest priority).
   * @param model - Resolved model id used for the SSOT lookup.
   */
  private resolveContextWindow(
    liveValue: number | undefined,
    model: string | undefined
  ): number | null {
    if (liveValue) return liveValue;
    const fromSsot = this.anthropicModels.contextTokensFor(model);
    if (fromSsot) return fromSsot;
    if (this._persistedContextTokens) return this._persistedContextTokens;
    if (this._contextWindowSize) return this._contextWindowSize;
    return isLocalProvider(this._currentProvider) ? null : DEFAULT_CONTEXT_TOKENS;
  }

  /** Re-reads `get_llm_config()` and updates the chat fallback-chain cache. */
  async refreshLlmConfigCache(): Promise<void> {
    try {
      const config = await this.tauri.invoke<LlmConfigResponse>('get_llm_config');
      this._persistedContextTokens = config.context_tokens ?? null;
      this._currentProvider = config.provider;
      // With no live stream value, surface the persisted one.
      if (this._persistedContextTokens && !this._sessionStats()?.usage) {
        this._contextWindowSize = this._persistedContextTokens;
      }
      this.notifyChange();
    } catch (err) {
      // Browser dev mode or backend unavailable.
      this.log.debug(`[chat-state] refreshLlmConfigCache failed: ${String(err)}`);
    }
  }

  /** Sets up the Tauri event listener for streaming chat responses. */
  private async setupStreamListener(): Promise<void> {
    try {
      this.unlisten = await this.tauri.listen<StreamChunk>('chat_stream', (event) => {
        const chunk = event.payload;
        // Legitimate between/after turns: metadata (SystemInit, trailing RateLimit) and
        // QueueDrained — fires right after Result sets isStreaming=false, starting the next turn.
        if (
          chunk.chunk_type === 'SystemInit' ||
          chunk.chunk_type === 'RateLimit' ||
          chunk.chunk_type === 'QueueDrained'
        ) {
          this.handleStreamChunk(chunk);
          return;
        }
        // Drop content-bearing chunks when not streaming.
        if (!this.isStreaming) return;
        this.handleStreamChunk(chunk);
      });
    } catch (err) {
      if (this.tauri.isRunningInTauri()) {
        this.log.error(`[chat-state] Failed to set up stream listener: ${String(err)}`);
        this.projectState.status.set('error');
        this.projectState.error = `Failed to set up stream listener: ${err}`;
      }
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
  // Anthropic returns redacted thinking blocks by default; skip empty deltas.
  if (!content) return blocks;
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
 * Locates the retry anchor (ADR-046): the user entry before the last committed assistant.
 * A control-chip user entry is skipped — it keeps its uuid but is not replayable (spec 4.4).
 * @param entries - Conversation entries in order, oldest first.
 * @param committedTag - The literal value that means "uuid is durable".
 */
function findRetryAnchorIn(
  entries: readonly {
    role: 'user' | 'assistant';
    uuid?: string | null;
    uuid_status?: string;
    // `type` is the live-path `MessageBlock` tag; `kind` is the state-tree
    // `MessageBlockState` tag — both carry a chip block, so both are checked.
    blocks?: readonly { type?: string; kind?: string }[];
  }[],
  committedTag: string
): { userUuid: string; lastAssistantIdx: number; userIdx: number } | null {
  let lastAssistantIdx = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 0) return null;
  const assistantStatus = entries[lastAssistantIdx].uuid_status;
  if (assistantStatus !== undefined && assistantStatus !== committedTag) return null;
  for (let i = lastAssistantIdx - 1; i >= 0; i -= 1) {
    const m = entries[i];
    if (m.role !== 'user') continue;
    if (!m.uuid) return null;
    if (m.uuid_status !== undefined && m.uuid_status !== committedTag) return null;
    // A rendered `/model`/`/effort` chip keeps its transcript uuid but must never
    // be a retry target — replaying it would resend a command, not a question (spec 4.4).
    const firstBlock = m.blocks?.[0];
    if (firstBlock?.type === 'chip' || firstBlock?.kind === 'chip') return null;
    return { userUuid: m.uuid, lastAssistantIdx, userIdx: i };
  }
  return null;
}

/**
 * Builds per-turn metadata for the assistant entry finalized by a `Result` chunk.
 * @param data - Fields copied from the `Result` payload.
 * @param data.turn_usage - Token usage for the turn.
 * @param data.turn_cost - Cost (USD) for the turn.
 * @param data.model - Model id from the payload, if present.
 * @param resolvedModel - Model id already resolved by the reducer.
 * @param suppressCost - Skip the cost preview (local has no real cost).
 */
function buildEntryMeta(
  data: {
    turn_usage?: TurnUsage;
    turn_cost?: number;
    model?: string;
  },
  resolvedModel: string | undefined,
  suppressCost = false
): EntryMeta | undefined {
  const { turn_usage, turn_cost } = data;
  const model = data.model ?? resolvedModel;
  if (!turn_usage && !model && turn_cost === undefined) {
    return undefined;
  }
  const meta: EntryMeta = {};
  if (model) meta.model = model;
  if (turn_usage) meta.usage = turn_usage;

  // Cost preview = backend turn_cost only; reconcileFooterCost replaces it with
  // the proxy SSOT. No frontend pricing — undefined hides the segment.
  if (!suppressCost && turn_cost !== undefined && Number.isFinite(turn_cost)) {
    meta.cost = turn_cost;
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
 * Index of the most recent user entry missing a UUID, or -1 if none (ADR-046).
 * @param msgs - Snapshot of `_messages` at the time the commit chunk arrives.
 */
function findLastUserIndexMissingUuid(msgs: readonly ChatMessage[]): number {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m.role === 'user' && !m.uuid) return i;
  }
  return -1;
}

/**
 * Last assistant per-call usage that isn't all-zero, matching the live-stream path's
 * `TurnUsage::default()` skip (chat.rs) so an aborted/errored call doesn't seed a false ctx=0%.
 * @param msgs The conversation messages, oldest first.
 */
function findLastNonZeroAssistantUsage(msgs: readonly ChatMessage[]): TurnUsage | undefined {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const usage = msgs[i].role === 'assistant' ? msgs[i].meta?.usage : undefined;
    if (usage && !isZeroUsage(usage)) return usage;
  }
  return undefined;
}

/**
 * True when every field of `u` is zero, mirroring Rust's `TurnUsage::default()`.
 * @param u The per-call usage to test.
 */
function isZeroUsage(u: TurnUsage): boolean {
  return (
    u.input_tokens === 0 &&
    u.output_tokens === 0 &&
    u.cache_read_tokens === 0 &&
    u.cache_write_tokens === 0
  );
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
 * Project legacy ChatStateService fields onto a `ConversationStateTree` (ADR-042).
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
    // Safe lossy projection: the state-tree total is display-only and never
    // rendered as $; the authoritative unpriced/null cost lives in total_cost.
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
 * Project committed `state().entries` onto the legacy `ChatMessage[]` shape; the trailing
 * live-streaming entry is dropped (it lives under `currentBlocksFromState`).
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
            questions: b.questions.map(cloneQuestionItem),
            current_index: b.current_index,
            answers: [...b.answers],
          },
        });
        break;
      case 'error':
        out.push({ type: 'error', content: b.content });
        break;
      case 'image':
        out.push({ type: 'image', media_type: b.media_type, alt: b.alt ?? undefined });
        break;
      case 'chip':
        out.push({ type: 'chip', command: b.command, argument: b.argument });
        break;
      default: {
        // Unknown Rust MessageBlock variant with no TS arm (ADR-042 drift).
        const unknownKind = (b as { kind: string }).kind;
        pluginLogWarn(
          `[chat-state] stateBlocksToMessageBlocks: dropping unknown block kind "${unknownKind}"`
        ).catch(() => {});
        out.push({ type: 'error', content: `Unsupported message block: ${unknownKind}` });
        break;
      }
    }
  }
  return out;
}

function cloneQuestionItem(q: AskUserQuestionItem): AskUserQuestionItem {
  return {
    question: q.question,
    header: q.header,
    multi_select: q.multi_select,
    options: q.options.map((o) => ({ label: o.label, value: o.value })),
  };
}

/**
 * Converts SDK message blocks into the serializable shape persisted to the chat state store
 * (drops live-only fields and normalizes tool payloads).
 * @param blocks - Live message blocks emitted by the agent SDK for one turn.
 */
export function messageBlocksToState(blocks: readonly MessageBlock[]): MessageBlockState[] {
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
          questions: b.question.questions.map(cloneQuestionItem),
          current_index: b.question.current_index,
          answers: [...b.question.answers],
        });
        break;
      case 'error':
        out.push({ kind: 'error', content: b.content });
        break;
      case 'image':
        out.push({ kind: 'image', media_type: b.media_type, alt: b.alt ?? null });
        break;
      case 'permission_prompt':
        // In-flight UI affordance; never persisted to the state-tree.
        break;
      case 'chip':
        out.push({ kind: 'chip', command: b.command, argument: b.argument });
        break;
    }
  }
  return out;
}

/**
 * Flatten blocks into plain text; elides tool inputs/outputs, thinking, and ask_user.
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

/**
 * Null handling is asymmetric: unknown history defaults to fits (resume), unknown window
 * defaults to doesn't fit (ask) — local models with no discovery.
 * @param historyTokens - Tokens used by the conversation so far, or null if unknown.
 * @param windowTokens - Target model's context window, or null if undiscovered.
 */
export function historyFitsTarget(
  historyTokens: number | null,
  windowTokens: number | null
): boolean {
  if (historyTokens == null) return true;
  if (windowTokens == null) return false;
  return historyTokens < windowTokens;
}

/** Raw tool_use block shape from Rust history.rs (flat, no nested `tool`). */
interface HistoryToolUseBlock {
  type: 'tool_use';
  tool_name: string;
  input_json: string;
}

/** Raw tool_result block from Rust history.rs (consumed during normalization). */
interface HistoryToolResultBlock {
  type: 'tool_result';
  content: string;
  is_error: boolean;
}

/**
 * Raw control-chip block from Rust `history.rs::MessageBlock::ControlChip` (serde
 * tag `control_chip`); normalized into the live-path `{ type: 'chip' }` view-model
 * so a resumed chip renders identically to a live one (spec 4.4).
 */
interface HistoryControlChipBlock {
  type: 'control_chip';
  command: string;
  argument: string;
}

/**
 * Maps a backend `ConversationTranscript` into the live-chat `ChatMessage[]` shape.
 * @param transcript - Backend conversation transcript to convert.
 */
export function toChatMessages(transcript: ConversationTranscript): ChatMessage[] {
  return transcript.messages.map((msg) => {
    const role: 'user' | 'assistant' = msg.role === 'user' ? 'user' : 'assistant';
    const rawBlocks =
      msg.blocks && msg.blocks.length > 0
        ? (msg.blocks as unknown as (
            | MessageBlock
            | HistoryToolUseBlock
            | HistoryToolResultBlock
            | HistoryControlChipBlock
          )[])
        : ([{ type: 'text' as const, content: msg.content }] as MessageBlock[]);
    const blocks = normalizeHistoryBlocks(rawBlocks);
    const timestamp = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
    // Propagate JSONL uuid and mark Committed so retry accepts it as anchor (ADR-046).
    const base: ChatMessage = { role, blocks, timestamp };
    if (msg.uuid) {
      base.uuid = msg.uuid;
      base.uuid_status = 'Committed';
    }
    // Restore the per-message footer (model · tokens) on resume.
    if (msg.model !== undefined || msg.usage !== undefined) {
      base.meta = {};
      if (msg.model !== undefined) base.meta.model = msg.model;
      if (msg.usage !== undefined) base.meta.usage = msg.usage;
    }
    return base;
  });
}

/**
 * Converts blocks from backend history format to live-chat format, merging tool_result into tool_use.
 * @param blocks - Raw blocks from the backend history payload.
 */
function normalizeHistoryBlocks(
  blocks: (MessageBlock | HistoryToolUseBlock | HistoryToolResultBlock | HistoryControlChipBlock)[]
): MessageBlock[] {
  const result: MessageBlock[] = [];

  for (const block of blocks) {
    if (block.type === 'tool_use' && !('tool' in block)) {
      const hist = block as HistoryToolUseBlock;
      result.push({
        type: 'tool_use',
        tool: {
          type: 'tool_use',
          tool_id: '',
          tool_name: hist.tool_name,
          input_json: hist.input_json,
          status: 'done',
          result: '',
          result_is_error: false,
        },
      });
    } else if (block.type === 'tool_result') {
      const hist = block as HistoryToolResultBlock;
      const prev = result[result.length - 1];
      if (prev?.type === 'tool_use') {
        const base = { ...prev.tool, result: hist.content };
        prev.tool = hist.is_error
          ? { ...base, status: 'error' as const, result_is_error: true as const }
          : { ...base, status: 'done' as const, result_is_error: false as const };
      }
    } else if (block.type === 'control_chip') {
      const hist = block as HistoryControlChipBlock;
      result.push({ type: 'chip', command: hist.command, argument: hist.argument });
    } else {
      result.push(block as MessageBlock);
    }
  }

  return result;
}
