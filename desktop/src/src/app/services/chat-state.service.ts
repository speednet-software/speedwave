import { Injectable, computed, effect, inject, untracked, type Signal } from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { Clipboard } from '@angular/cdk/clipboard';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import { AnthropicModelsService } from './anthropic-models.service';
import { ClaudeControlService } from './claude-control.service';
import { PlanUsageService } from './plan-usage.service';
import { LoggerService } from './logger.service';
import {
  ChatSessionStore,
  type ChatStoreDeps,
  type ModelSelectionInput,
} from './chat-session-store';
import type { TabStreamChunk } from '../models/chat';
import type { ConversationStateTree } from '../models/state-tree';
import {
  type ChatInput,
  type ChatMessage,
  type MessageBlock,
  type SessionStats,
  type StreamChunk,
  type ProjectList,
  type AskUserQuestionBlock,
  type RateLimitInfo,
  type EntryMeta,
  type TurnUsage,
  type QueuedMessage,
} from '../models/chat';

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
  ModelSelectionInput,
};

export {
  MAX_CHAT_TABS,
  MODEL_SWITCH_NOT_APPLIED,
  NEW_CONVERSATION_AUTH,
  NEW_CONVERSATION_BUSY,
  NEW_CONVERSATION_FAILED,
  NEW_CONVERSATION_NO_PROJECT,
  NEW_CONVERSATION_STREAMING,
  blocksToPlainText,
  buildStateTreeFromLegacy,
  historyFitsTarget,
  isNotAuthenticatedError,
  mapContextOverflowError,
  mapNotLoggedInError,
  messageBlocksToState,
  stateBlocksToMessageBlocks,
  stateEntriesToChatMessages,
  toChatMessages,
  type LegacyStateSnapshot,
} from './chat-session-store';

/** Singleton service that holds chat session state across navigation. */
@Injectable({ providedIn: 'root' })
export class ChatStateService {
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private anthropicModels = inject(AnthropicModelsService);
  private control = inject(ClaudeControlService);
  private planUsage = inject(PlanUsageService);
  private clipboard = inject(Clipboard);
  private log = inject(LoggerService);

  private readonly store: ChatSessionStore;

  private unlisten: UnlistenFn | null = null;
  private listenerSetup: Promise<void> | null = null;
  private unsubProjectChange: (() => void) | null = null;
  private _sawSwitching = false;

  /** Reads Claude Code's control data as soon as a session answers `initialize`. */
  constructor() {
    const deps: ChatStoreDeps = {
      tauri: this.tauri,
      projectState: this.projectState,
      anthropicModels: this.anthropicModels,
      control: this.control,
      planUsage: this.planUsage,
      clipboard: this.clipboard,
      log: this.log,
      ensureListeners: () => this.ensureListeners(),
    };
    this.store = new ChatSessionStore(crypto.randomUUID(), deps);

    effect(() => {
      const project = this.projectState.activeProject();
      if (!project || this.control.sessionInfoState(project).state !== 'ready') return;
      untracked(() => void this.store.refreshControlData());
    });
  }

  /** Stable per-tab id sent on every session-scoped Tauri command (PR 2 moves ownership to the tab registry). */
  get tabId(): string {
    return this.store.tabId;
  }

  /** Completed messages (immutable — replaced on each change). */
  get messages(): readonly ChatMessage[] {
    return this.store.messages;
  }

  /** Blocks accumulating during the current streaming assistant turn. */
  get currentBlocks(): readonly MessageBlock[] {
    return this.store.currentBlocks;
  }

  /** Whether an assistant turn is currently streaming. */
  get isStreaming(): boolean {
    return this.store.isStreaming;
  }
  /** Sets the streaming flag (tests and the stream listener gate). */
  set isStreaming(v: boolean) {
    this.store.isStreaming = v;
  }

  /** Public read-only accessor for the queued slot. */
  get pendingQueue(): QueuedMessage | null {
    return this.store.pendingQueue;
  }

  readonly pendingModelOverride: Signal<string | null> = computed(() =>
    this.store.pendingModelOverride()
  );
  /** Effort level saved for the next session because the live one holds its launch effort. */
  readonly deferredEffort: Signal<string | null> = computed(() => this.store.deferredEffort());

  /**
   * Persists the effort pin, then applies it: queued while the chat is busy, wired as `/effort` into
   * a live conversation (deferred to the next session if it holds its launch effort), else respawned.
   * @param level - One of `defaults::EFFORT_LEVELS`.
   */
  applyEffortSelection(level: string): Promise<void> {
    return this.store.applyEffortSelection(level);
  }

  /** Resumes the live conversation so it launches with the deferred effort; its background tasks stop. */
  restartForDeferredEffort(): Promise<void> {
    return this.store.restartForDeferredEffort();
  }

  readonly modelSelectionError: Signal<string> = computed(() => this.store.modelSelectionError());

  /**
   * Persists a composer model pick (Anthropic: `settings.json` pin; routed: config write-through),
   * then applies it: wire switch, queued override, or an idle respawn that a routed pick precedes with a compose re-render.
   * @param sel - Selected model triad emitted by the model selector.
   */
  applyModelSelection(sel: ModelSelectionInput): Promise<void> {
    return this.store.applyModelSelection(sel);
  }

  /** Session cost/usage stats from the most recent result. */
  get sessionStats(): SessionStats | null {
    return this.store.sessionStats;
  }
  readonly sessionStatsFromState: Signal<SessionStats | null> = computed(() =>
    this.store.sessionStatsFromState()
  );

  /** Context tokens of the last main-chain API call; survives stream reset. */
  get lastContextTokens(): number | null {
    return this.store.lastContextTokens;
  }

  /** Test-only read access. */
  get turnId(): number {
    return this.store.turnId;
  }

  /** Durable session id (test/Component read). */
  get lastKnownSessionId(): string | null {
    return this.store.lastKnownSessionId;
  }
  /** Optimistic resume stamp (read by the view-session-id getter). */
  get optimisticSessionId(): string | null {
    return this.store.optimisticSessionId;
  }

  /**
   * Unregistering (null) makes overflow default to auto-resume.
   * @param cb - Decider callback, or null to unregister.
   */
  setResumeDecider(cb: (() => Promise<'resume' | 'fresh'>) | null): void {
    this.store.setResumeDecider(cb);
  }

  /** Clears durable + optimistic session tracking (new conversation / delete). */
  clearSessionTracking(): void {
    this.store.clearSessionTracking();
  }

  readonly state: Signal<ConversationStateTree> = computed(() => this.store.state());

  /** Re-reads the plan limits and the context usage on demand (the usage popover opened). */
  refreshUsage(): Promise<void> {
    return this.store.refreshUsage();
  }

  readonly messagesFromState: Signal<readonly ChatMessage[]> = computed(() =>
    this.store.messagesFromState()
  );

  readonly isStreamingFromState: Signal<boolean> = computed(() =>
    this.store.isStreamingFromState()
  );

  readonly hasConversation: Signal<boolean> = computed(() => this.store.hasConversation());

  readonly newConversationBlockedReason: Signal<string> = computed(() =>
    this.store.newConversationBlockedReason()
  );

  readonly loadingTranscriptFromState: Signal<boolean> = computed(() =>
    this.store.loadingTranscriptFromState()
  );

  /** Mark the start of a transcript fetch (shows the loader). */
  beginTranscriptLoad(): void {
    this.store.beginTranscriptLoad();
  }

  /** Mark the end of a transcript fetch (hides the loader). */
  endTranscriptLoad(): void {
    this.store.endTranscriptLoad();
  }

  /**
   * Mark a session start in progress (resume) so a concurrent `sendMessage` waits;
   * bumps the generation to no-op in-flight starts. Disposer records how the start ended.
   */
  beginStartingSession(): (outcome?: 'started' | 'skipped' | 'auth' | 'failed') => void {
    return this.store.beginStartingSession();
  }

  readonly retryEnabled: Signal<boolean> = computed(() => this.store.retryEnabled());

  readonly currentBlocksFromState: Signal<readonly MessageBlock[]> = computed(() =>
    this.store.currentBlocksFromState()
  );

  readonly pendingQueueFromState: Signal<QueuedMessage | null> = computed(() =>
    this.store.pendingQueueFromState()
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
    this.store._setState(state);
  }

  private ensureListeners(): Promise<void> {
    this.listenerSetup ??= (async () => {
      await this.setupStreamListener();
      this.setupProjectStateListeners();
      this.setupRestartResumeListeners();
      void this.store.refreshLlmConfigCache();
    })().catch((err: unknown) => {
      this.listenerSetup = null;
      throw err;
    });
    return this.listenerSetup;
  }

  /** Ensures the stream listener runs exactly once. Waits for project ready before starting chat. */
  async init(): Promise<void> {
    return this.store.init();
  }

  /**
   * Clears the conversation and awaits a fresh backend session, so the caller can send
   * into an empty chat. Refuses before clearing; a failed start clears first, then throws.
   */
  startNewConversation(): Promise<void> {
    return this.store.startNewConversation();
  }

  /**
   * Accepts a plain string (text-only) or `ChatInput` with attachments.
   * @param input - Raw text or composer bundle.
   * @param displayText - Overrides the bubble's surface text (plan-mode prefix flow).
   */
  sendMessage(input: string | ChatInput, displayText?: string): Promise<void> {
    return this.store.sendMessage(input, displayText);
  }

  /**
   * Records one slot's answer for a multi-question AskUserQuestion block.
   * @param toolUseId - Tool_use_id of the AskUserQuestion control_request.
   * @param questionIdx - Slot index being answered (0-based).
   * @param value - Chosen value (multi-select labels pre-joined with `", "`).
   */
  submitAnswer(toolUseId: string, questionIdx: number, value: string): Promise<void> {
    return this.store.submitAnswer(toolUseId, questionIdx, value);
  }

  /**
   * Stops the current Claude turn (no-op when not streaming). Resets UI state
   * synchronously to re-enable input, then fires the backend stop in background.
   */
  stopConversation(): Promise<void> {
    return this.store.stopConversation();
  }

  /**
   * Processes a streaming chunk from the Claude subprocess.
   * Uses immutable updates: currentBlocks is replaced on every mutation.
   * @param chunk - The stream chunk to handle.
   */
  handleStreamChunk(chunk: StreamChunk): void {
    this.store.handleStreamChunk(chunk);
  }

  /** Clears all chat state to start a fresh conversation. */
  resetForNewConversation(): void {
    this.store.resetForNewConversation();
  }

  /**
   * Replaces the current messages with a pre-loaded set (e.g. from a transcript).
   * @param msgs - The messages to load.
   */
  loadMessages(msgs: ChatMessage[]): void {
    this.store.loadMessages(msgs);
  }

  /**
   * Seeds the session id (resume or stream-start SystemInit) so retry / queue
   * can run before the first `Result`.
   * @param sessionId - Session uuid from a resume or a SystemInit chunk.
   */
  seedSessionId(sessionId: string): void {
    this.store.seedSessionId(sessionId);
  }

  /**
   * Queue a message as the next turn (ADR-045); replace semantics.
   * @param text - The message to queue.
   */
  queueMessage(text: string): Promise<string | null> {
    return this.store.queueMessage(text);
  }

  /** Cancel the queued message for the active session; no-op when empty. */
  cancelQueuedMessage(): Promise<void> {
    return this.store.cancelQueuedMessage();
  }

  /**
   * Copies the message at `index` to the clipboard; elides tool/thinking/ask_user blocks.
   * @param index - Index into `messages` of the entry to copy.
   * @returns `true` on success, `false` on out-of-range / empty / write failure.
   */
  copyMessage(index: number): boolean {
    return this.store.copyMessage(index);
  }

  /** Returns whether the last assistant turn can be retried (ADR-046). */
  canRetryLastAssistant(): boolean {
    return this.store.canRetryLastAssistant();
  }

  /** Retries the last assistant turn via the backend `retry_last_turn` command (ADR-046). */
  retryLastAssistant(): Promise<void> {
    return this.store.retryLastAssistant();
  }

  /**
   * Service-level (not component-level) so it works whether or not a ChatComponent is mounted.
   * @param sessionId - session UUID to resume.
   */
  resumeConversation(sessionId: string): Promise<void> {
    return this.store.resumeConversation(sessionId);
  }

  /** Re-reads `get_llm_config()` and updates the chat fallback-chain cache. */
  refreshLlmConfigCache(): Promise<void> {
    return this.store.refreshLlmConfigCache();
  }

  private setupProjectStateListeners(): void {
    this.unsubProjectChange = this.projectState.onChange(() => {
      const status = this.projectState.status();
      const project = this.projectState.activeProject();
      if (project && (status === 'no_provider' || status === 'auth_required')) {
        this.planUsage.drop(project);
      }
      if (status === 'switching') {
        this._sawSwitching = true;
        this.store.resetForProjectSwitch();
      } else if (status === 'ready') {
        void this.refreshLlmConfigCache();
        if (this._sawSwitching) {
          this._sawSwitching = false;
          void this.store.startChatSession();
        }
      }
    });
  }

  private setupRestartResumeListeners(): void {
    this.projectState.onRestartBegin(async () => {
      if (this.isStreaming) await this.stopConversation();
    });
    this.projectState.onRestartComplete(() => {
      void this.store.decideResumeAfterRestart();
    });
  }

  private async setupStreamListener(): Promise<void> {
    try {
      this.unlisten = await this.tauri.listen<TabStreamChunk>('chat_stream', (event) => {
        const chunk = event.payload;
        if (chunk.tab_id !== this.store.tabId) return;
        if (
          chunk.chunk_type === 'SystemInit' ||
          chunk.chunk_type === 'RateLimit' ||
          chunk.chunk_type === 'QueueDrained'
        ) {
          this.handleStreamChunk(chunk);
          return;
        }
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
