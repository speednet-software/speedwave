import { Injectable, computed, inject, signal, type Signal } from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { warn as pluginLogWarn } from '@tauri-apps/plugin-log';
import { Clipboard } from '@angular/cdk/clipboard';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import { AnthropicModelsService } from './anthropic-models.service';
import { LoggerService } from './logger.service';
import { calculateCost } from '../chat/pricing';
import { DEFAULT_CONTEXT_TOKENS, isLocalProvider, type LlmConfigResponse } from '../models/llm';
import {
  DEFAULT_STATE_TREE,
  type ConversationEntryState,
  type ConversationStateTree,
  type MessageBlockState,
} from '../models/state-tree';
import {
  chatInputFromText,
  chatInputToBlocks,
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
  /**
   * Context window for the active model. `null` until populated from a
   * stream value, SSOT lookup, persisted config, or the Anthropic default
   * fallback. ADR-041 forbids guessing a value for local providers, so
   * `null` propagates to the UI and the footer hides the `used / max` ratio
   * rather than showing 200K.
   */
  private _contextWindowSize: number | null = null;
  /**
   * Active LLM provider id from `get_llm_config().provider`. Drives the
   * "is local?" check in `resolveContextWindow` — Anthropic gets the
   * DEFAULT_CONTEXT_TOKENS bottom fallback; local providers do not.
   */
  private _currentProvider: string | null = null;

  /**
   * Last-known persisted context window from `claude.llm.context_tokens`
   * (`get_llm_config`). Refreshed on init / project change / explicit
   * `refreshLlmConfigCache()` calls (Settings invokes that after save).
   * Populated from the real provider API for local providers
   * (Ollama / LM Studio / llama.cpp) and from the SSOT for Anthropic, so
   * the chat footer can show an accurate `used / max` ratio before any
   * stream-level value lands.
   */
  private _persistedContextTokens: number | null = null;

  /**
   * Monotonically increasing turn id. Bumped by both `sendMessage` (new turn
   * starts) and `stopConversation` (turn cancelled). Used across awaits by
   * `submitAnswer` to detect whether the turn it was answering has since
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
  private anthropicModels = inject(AnthropicModelsService);
  private clipboard = inject(Clipboard);
  private log = inject(LoggerService);
  private unsubProjectChange: (() => void) | null = null;

  /**
   * ADR-042 — full state-tree signal. Rebuilt from the legacy
   * `_messages`/`_currentBlocks` fields by `rebuildStateTree()` after
   * every mutation — the single pipeline feeding the signal projections.
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
    if (tree.is_streaming || !tree.session_id) return false;
    return findRetryAnchorIn(tree.entries, 'committed') !== null;
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

  /**
   * Rebuilds the state-tree signal from the post-mutation legacy fields so
   * the `state()` projections (`messagesFromState`, `currentBlocksFromState`,
   * `isStreamingFromState`, `pendingQueueFromState`) stay in lockstep with
   * the legacy mutation methods (ADR-042/043). Components read the signal
   * projections; OnPush picks up the change automatically.
   */
  private notifyChange(): void {
    this.rebuildStateTree();
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
    this.log.debug(
      `[chat-state] init: listenerReady=${this.listenerReady} initialized=${this.initialized}`
    );
    if (!this.listenerReady) {
      this.listenerReady = true;
      await this.setupStreamListener();
      this.setupProjectStateListeners();
      // Best-effort cache warm so the chat footer has a context window
      // ready before the first Result chunk lands.
      void this.refreshLlmConfigCache();
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
      this.log.debug(`[chat-state] startChatSession: project=${project}`);
      try {
        await this.tauri.invoke('start_chat', { project });
        this.log.debug('[chat-state] startChatSession: success');
      } catch (err) {
        const msg = String(err);
        if (msg.includes('not authenticated')) {
          this.projectState.status = 'auth_required';
          this.notifyChange();
        } else {
          // Non-auth start failure is fatal for the chat session — surface it
          // in the project state so the UI shows an error instead of a silently
          // dead chat (mirrors the stream-listener failure handling below).
          this.log.error(`[chat-state] Failed to start chat session: ${msg}`);
          this.projectState.status = 'error';
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
    this._messages = [
      ...this._messages,
      {
        role: 'user',
        blocks: displayBlocks,
        timestamp: Date.now(),
      },
    ];
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
   * Records one slot's answer for a multi-question AskUserQuestion block
   * Optimistically advances the block's `current_index` to the
   * next unanswered slot, then forwards to the host. On error, reverts the
   * slot and appends an error block.
   * @param toolUseId   tool_use_id of the AskUserQuestion control_request.
   * @param questionIdx slot index being answered (0-based).
   * @param value       chosen value (single string; multi-select labels are
   *                    pre-joined with `", "` by the renderer).
   */
  async submitAnswer(toolUseId: string, questionIdx: number, value: string): Promise<void> {
    const capturedTurn = this._turnId;

    // Snapshot the pre-mutation current_index so the error path can revert
    // to it precisely — resetting to questionIdx would be wrong if the user
    // submitted out of order.
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
      // If stopConversation ran while submit_question_answer was in flight,
      // `_turnId` has moved on. Suppress the error block: the user
      // deliberately cancelled — a "Broken pipe" / "no active session"
      // surfacing would be confusing noise.
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
        this._contextWindowSize = this.resolveContextWindow(
          chunk.data.context_window_size,
          resolvedModel
        );
        this._sessionStats = {
          session_id: chunk.data.session_id,
          total_cost: chunk.data.total_cost ?? 0,
          usage: chunk.data.usage,
          model: resolvedModel,
          rate_limit: this._rateLimit ?? undefined,
          context_window_size: this._contextWindowSize,
          total_output_tokens: this._totalOutputTokens,
        };
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
    this.log.debug('[chat-state] resetForNewConversation');
    this._messages = [];
    this._currentBlocks = [];
    this.isStreaming = false;
    this._sessionStats = null;
    this._model = '';
    this._rateLimit = null;
    this._totalOutputTokens = 0;
    this._contextWindowSize = null;
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
    // The seed is replaced as soon as the next `Result` chunk arrives with
    // an authoritative `context_window_size`.
    const seeded = this.resolveContextWindow(undefined, this._sessionStats?.model);
    this._sessionStats = {
      total_cost: 0,
      context_window_size: seeded,
      total_output_tokens: 0,
      ...this._sessionStats,
      session_id: sessionId,
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
      this.log.warn(`[chat-state] queueMessage: backend invoke failed: ${String(err)}`);
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
      this.log.warn(`[chat-state] cancelQueuedMessage: backend invoke failed: ${String(err)}`);
    }
    this._pendingQueue = null;
    this.notifyChange();
  }

  /**
   * Copies the textual content of the message at `index` to the system
   * clipboard via Angular CDK's `Clipboard` service. Returns `true` on
   * success, `false` on failure (out-of-range index, empty content, write
   * rejection). Block kinds that carry no user-facing prose — `tool_use`,
   * `thinking`, `ask_user` — are elided; `text` and `error` blocks are
   * joined with a blank line.
   *
   * The component layer owns the "copied" indicator timing so this method can
   * stay pure and testable.
   * @param index - Index into `messages` of the entry to copy.
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
    const anchor = findRetryAnchorIn(this._messages, 'Committed');
    return anchor === null ? null : { sessionId, ...anchor };
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
      if (this.projectState.status === 'switching') {
        this._messages = [];
        this._currentBlocks = [];
        this.isStreaming = false;
        this._sessionStats = null;
        this._model = '';
        this._rateLimit = null;
        this._totalOutputTokens = 0;
        this._contextWindowSize = null;
        this._persistedContextTokens = null;
        this._currentProvider = null;
        this.notifyChange();
      } else if (this.projectState.status === 'ready') {
        // Project just settled — re-pull the persisted context tokens so
        // the chat footer reflects whatever the user picked in Settings.
        void this.refreshLlmConfigCache();
      }
    });
  }

  /**
   * Fallback chain for the chat footer's context-window value.
   * Order: live stream value → Anthropic SSOT lookup → persisted
   * `claude.llm.context_tokens` → previous `_contextWindowSize` → for
   * Anthropic only: {@link DEFAULT_CONTEXT_TOKENS}. Local providers
   * propagate `null` instead — ADR-041 "never guess".
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

  /**
   * Re-reads `get_llm_config().context_tokens` from the backend and updates
   * the cache used by the chat fallback chain. Public so Settings can call
   * it after `update_llm_config` settles — without that, the chat footer
   * would keep showing the previous model's window until the next session.
   */
  async refreshLlmConfigCache(): Promise<void> {
    try {
      const config = await this.tauri.invoke<LlmConfigResponse>('get_llm_config');
      this._persistedContextTokens = config.context_tokens ?? null;
      this._currentProvider = config.provider;
      // If we have no live stream value yet, surface the persisted one
      // through `_contextWindowSize` so the next `notifyChange` rebuilds
      // session stats with the right `used / max`.
      if (this._persistedContextTokens && !this._sessionStats?.usage) {
        this._contextWindowSize = this._persistedContextTokens;
      }
      this.notifyChange();
    } catch (err) {
      // Browser dev mode or backend unavailable — log so backend renames /
      // serialisation regressions surface during development without
      // disrupting the UI.
      this.log.debug(`[chat-state] refreshLlmConfigCache failed: ${String(err)}`);
    }
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
        this.log.error(`[chat-state] Failed to set up stream listener: ${String(err)}`);
        this.projectState.status = 'error';
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
  // Anthropic returns redacted thinking blocks by default for Opus 4.7
  // (and others when summaries are not requested) — the model still does
  // the reasoning, but the streamed `thinking` text is empty and only the
  // signature (encrypted thinking, used for multi-turn continuity) is sent.
  // Skip empty deltas so we don't render an empty collapsible. If the API
  // ever sends a non-empty delta later in the same turn, we still attach
  // it to a fresh thinking block.
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
/**
 * Locates the retry anchor — the (assistant, user) pair at the tail of
 * `entries` whose user entry can be replayed via `retry_last_turn`
 * (ADR-046). Returns the matched indices and the user uuid, or `null`.
 *
 * `committedTag` is parametrised because the legacy ChatMessage shape
 * uses 'Committed' while the state-tree shape uses 'committed'. An
 * `undefined` `uuid_status` is treated as committed for backward
 * compatibility with pre-ADR-046 transcript entries.
 * @param entries - Conversation entries in order, oldest first.
 * @param committedTag - The literal value that means "uuid is durable".
 */
function findRetryAnchorIn(
  entries: readonly {
    role: 'user' | 'assistant';
    uuid?: string | null;
    uuid_status?: string;
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
    return { userUuid: m.uuid, lastAssistantIdx, userIdx: i };
  }
  return null;
}

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
 * This projection is the single pipeline feeding the `state()` signal
 * (ADR-042 status note): it rebuilds the tree from the legacy fields
 * after every mutation so the projections never drift.
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
      default: {
        // A new Rust MessageBlock variant landed without a TS arm here
        // (ADR-042 SSOT-alignment drift). Surface a placeholder instead of
        // silently dropping it, and forward to the log pipeline so the gap
        // is visible in a diagnostics ZIP.
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
 * Converts SDK message blocks into the serializable shape persisted to the
 * chat state store (drops live-only fields and normalizes tool payloads).
 * @param blocks Live message blocks emitted by the agent SDK for one turn.
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
