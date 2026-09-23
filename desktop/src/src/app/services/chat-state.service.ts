import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { Clipboard } from '@angular/cdk/clipboard';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import { AnthropicModelsService } from './anthropic-models.service';
import { ClaudeControlService } from './claude-control.service';
import { PlanUsageService } from './plan-usage.service';
import { LoggerService } from './logger.service';
import { BetaService } from './beta.service';
import {
  ChatSessionStore,
  MAX_CHAT_TABS,
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
  private beta = inject(BetaService);

  private readonly deps: ChatStoreDeps;

  private unlisten: UnlistenFn | null = null;
  private listenerSetup: Promise<void> | null = null;
  private unsubProjectChange: (() => void) | null = null;
  private _sawSwitching = false;
  private _resumeDecider: (() => Promise<'resume' | 'fresh'>) | null = null;
  private _backendTabsReset = false;

  private readonly _tabs = signal<ReadonlyMap<string, ChatSessionStore>>(new Map());
  private readonly _activeTabId = signal<string>('');

  /** Every open chat tab keyed by its tab id. */
  readonly tabs: Signal<ReadonlyMap<string, ChatSessionStore>> = this._tabs.asReadonly();
  /** Tab id currently shown in the UI. */
  readonly activeTabId: Signal<string> = this._activeTabId.asReadonly();
  /** Store backing the active tab; every facade delegation flows through this. */
  readonly activeStore: Signal<ChatSessionStore> = computed(() => {
    const store = this._tabs().get(this._activeTabId());
    if (!store) throw new Error(`[chat-state] no store for active tab ${this._activeTabId()}`);
    return store;
  });
  /** Whether another tab can be opened under `MAX_CHAT_TABS` (beta gating is the UI's job). */
  readonly canOpenTab: Signal<boolean> = computed(() => this._tabs().size < MAX_CHAT_TABS);

  /** Reads Claude Code's control data as soon as a session answers `initialize`. */
  constructor() {
    this.deps = {
      tauri: this.tauri,
      projectState: this.projectState,
      anthropicModels: this.anthropicModels,
      control: this.control,
      planUsage: this.planUsage,
      clipboard: this.clipboard,
      log: this.log,
      ensureListeners: () => this.ensureListeners(),
    };
    const initial = this.makeStore();
    this._tabs.set(new Map([[initial.tabId, initial]]));
    this._activeTabId.set(initial.tabId);

    effect(() => {
      const project = this.projectState.activeProject();
      if (!project || this.control.sessionInfoState(project).state !== 'ready') return;
      untracked(() => void this.activeStore().refreshControlData());
    });
  }

  private makeStore(): ChatSessionStore {
    return new ChatSessionStore(crypto.randomUUID(), this.deps);
  }

  private addStore(store: ChatSessionStore): void {
    const map = new Map(this._tabs());
    map.set(store.tabId, store);
    this._tabs.set(map);
  }

  private findTabOwning(sessionId: string): ChatSessionStore | undefined {
    for (const store of this._tabs().values()) {
      if (store.lastKnownSessionId === sessionId || store.optimisticSessionId === sessionId) {
        return store;
      }
    }
    return undefined;
  }

  /**
   * Creates a new tab, eagerly starts its backend session, and activates it.
   * @returns The new tab's id.
   */
  async openTab(): Promise<string> {
    if (!this.canOpenTab()) {
      throw new Error(`Cannot open more than ${MAX_CHAT_TABS} chat tabs`);
    }
    const store = this.makeStore();
    store.setResumeDecider(this._resumeDecider);
    this.addStore(store);
    await store.init();
    this._activeTabId.set(store.tabId);
    return store.tabId;
  }

  private async openTabResuming(sessionId: string): Promise<void> {
    const store = this.makeStore();
    store.setResumeDecider(this._resumeDecider);
    this.addStore(store);
    await this.ensureListeners();
    await store.resumeConversation(sessionId);
    this._activeTabId.set(store.tabId);
  }

  /**
   * Interrupts a streaming tab, closes its backend session, and activates a neighbor;
   * closing the last tab replaces it with a fresh one instead of leaving zero tabs.
   * @param tabId - Id of the tab to close.
   */
  async closeTab(tabId: string): Promise<void> {
    const store = this._tabs().get(tabId);
    if (!store) return;
    if (store.isStreaming) {
      await store.stopConversation();
    }
    try {
      await this.tauri.invoke('close_chat_tab', { tabId });
    } catch (err) {
      this.log.warn(`[chat-state] closeTab: close_chat_tab invoke failed: ${String(err)}`);
    }
    store.dispose();

    const remaining = new Map(this._tabs());
    remaining.delete(tabId);

    if (remaining.size === 0) {
      const fresh = this.makeStore();
      fresh.setResumeDecider(this._resumeDecider);
      const transitional = new Map(this._tabs());
      transitional.set(fresh.tabId, fresh);
      this._tabs.set(transitional);
      this._activeTabId.set(fresh.tabId);
      remaining.set(fresh.tabId, fresh);
      this._tabs.set(remaining);
      await fresh.init();
      return;
    }

    if (this._activeTabId() === tabId) {
      const neighbor = remaining.keys().next().value as string;
      this._activeTabId.set(neighbor);
    }
    this._tabs.set(remaining);
  }

  /**
   * Switches the active tab; a no-op for an unknown tab id.
   * @param tabId - Id of the tab to activate.
   */
  activateTab(tabId: string): void {
    if (!this._tabs().has(tabId)) return;
    this._activeTabId.set(tabId);
  }

  /**
   * Resumes a conversation. A tab already owning the session is activated; if that tab's
   * backend session already ended (e.g. a container restart while it was backgrounded), the
   * activation is followed by a real reconnect instead of a silent no-op. While the tab bar
   * is visible (more than one tab open, or the beta tab UI is on), an idle+clean active tab
   * resumes in place, an occupied one opens a new resuming tab under the cap; otherwise
   * (single tab with the bar hidden, or at the cap) the active tab resumes in place — today's
   * replace semantics.
   * @param sessionId - Session UUID to resume.
   */
  async openConversation(sessionId: string): Promise<void> {
    const owner = this.findTabOwning(sessionId);
    if (owner) {
      this.activateTab(owner.tabId);
      if (owner.sessionEnded()) {
        await owner.resumeConversation(sessionId);
      }
      return;
    }
    const active = this.activeStore();
    if (this._tabs().size > 1 || this.beta.enabled()) {
      if (!active.hasConversation() && !active.isStreaming) {
        await active.resumeConversation(sessionId);
        return;
      }
      if (this.canOpenTab()) {
        await this.openTabResuming(sessionId);
        return;
      }
    }
    await active.resumeConversation(sessionId);
  }

  /** Stable per-tab id sent on every session-scoped Tauri command; the active tab's id. */
  get tabId(): string {
    return this.activeStore().tabId;
  }

  /** Completed messages (immutable — replaced on each change). */
  get messages(): readonly ChatMessage[] {
    return this.activeStore().messages;
  }

  /** Blocks accumulating during the current streaming assistant turn. */
  get currentBlocks(): readonly MessageBlock[] {
    return this.activeStore().currentBlocks;
  }

  /** Whether an assistant turn is currently streaming. */
  get isStreaming(): boolean {
    return this.activeStore().isStreaming;
  }
  /** Sets the streaming flag (tests and the stream listener gate). */
  set isStreaming(v: boolean) {
    this.activeStore().isStreaming = v;
  }

  /** Public read-only accessor for the queued slot. */
  get pendingQueue(): QueuedMessage | null {
    return this.activeStore().pendingQueue;
  }

  readonly pendingModelOverride: Signal<string | null> = computed(() =>
    this.activeStore().pendingModelOverride()
  );
  /** Effort level saved for the next session because the live one holds its launch effort. */
  readonly deferredEffort: Signal<string | null> = computed(() =>
    this.activeStore().deferredEffort()
  );

  /**
   * Persists the effort pin, then applies it: queued while the chat is busy, wired as `/effort` into
   * a live conversation (deferred to the next session if it holds its launch effort), else respawned.
   * @param level - One of `defaults::EFFORT_LEVELS`.
   */
  applyEffortSelection(level: string): Promise<void> {
    return this.activeStore().applyEffortSelection(level);
  }

  /** Resumes the live conversation so it launches with the deferred effort; its background tasks stop. */
  restartForDeferredEffort(): Promise<void> {
    return this.activeStore().restartForDeferredEffort();
  }

  readonly modelSelectionError: Signal<string> = computed(() =>
    this.activeStore().modelSelectionError()
  );

  /**
   * Persists a composer model pick (Anthropic: `settings.json` pin; routed: config write-through),
   * then applies it: wire switch, queued override, or an idle respawn that a routed pick precedes with a compose re-render.
   * @param sel - Selected model triad emitted by the model selector.
   */
  applyModelSelection(sel: ModelSelectionInput): Promise<void> {
    return this.activeStore().applyModelSelection(sel);
  }

  /** Session cost/usage stats from the most recent result. */
  get sessionStats(): SessionStats | null {
    return this.activeStore().sessionStats;
  }
  readonly sessionStatsFromState: Signal<SessionStats | null> = computed(() =>
    this.activeStore().sessionStatsFromState()
  );

  /** Context tokens of the last main-chain API call; survives stream reset. */
  get lastContextTokens(): number | null {
    return this.activeStore().lastContextTokens;
  }

  /** Test-only read access. */
  get turnId(): number {
    return this.activeStore().turnId;
  }

  /** Durable session id (test/Component read). */
  get lastKnownSessionId(): string | null {
    return this.activeStore().lastKnownSessionId;
  }
  /** Optimistic resume stamp (read by the view-session-id getter). */
  get optimisticSessionId(): string | null {
    return this.activeStore().optimisticSessionId;
  }

  /**
   * Unregistering (null) makes overflow default to auto-resume. Remembered at the facade
   * level (`_resumeDecider`) so a project switch, which discards the active store and
   * replaces it with a fresh one, carries the registration over instead of silently
   * dropping it.
   * @param cb - Decider callback, or null to unregister.
   */
  setResumeDecider(cb: (() => Promise<'resume' | 'fresh'>) | null): void {
    this._resumeDecider = cb;
    this.activeStore().setResumeDecider(cb);
  }

  /** Clears durable + optimistic session tracking (new conversation / delete). */
  clearSessionTracking(): void {
    this.activeStore().clearSessionTracking();
  }

  readonly state: Signal<ConversationStateTree> = computed(() => this.activeStore().state());

  /** Re-reads the plan limits and the context usage on demand (the usage popover opened). */
  refreshUsage(): Promise<void> {
    return this.activeStore().refreshUsage();
  }

  readonly messagesFromState: Signal<readonly ChatMessage[]> = computed(() =>
    this.activeStore().messagesFromState()
  );

  readonly isStreamingFromState: Signal<boolean> = computed(() =>
    this.activeStore().isStreamingFromState()
  );

  readonly hasConversation: Signal<boolean> = computed(() => this.activeStore().hasConversation());

  readonly newConversationBlockedReason: Signal<string> = computed(() =>
    this.activeStore().newConversationBlockedReason()
  );

  readonly loadingTranscriptFromState: Signal<boolean> = computed(() =>
    this.activeStore().loadingTranscriptFromState()
  );

  /** Mark the start of a transcript fetch (shows the loader). */
  beginTranscriptLoad(): void {
    this.activeStore().beginTranscriptLoad();
  }

  /** Mark the end of a transcript fetch (hides the loader). */
  endTranscriptLoad(): void {
    this.activeStore().endTranscriptLoad();
  }

  /**
   * Mark a session start in progress (resume) so a concurrent `sendMessage` waits;
   * bumps the generation to no-op in-flight starts. Disposer records how the start ended.
   */
  beginStartingSession(): (outcome?: 'started' | 'skipped' | 'auth' | 'failed') => void {
    return this.activeStore().beginStartingSession();
  }

  readonly retryEnabled: Signal<boolean> = computed(() => this.activeStore().retryEnabled());

  readonly currentBlocksFromState: Signal<readonly MessageBlock[]> = computed(() =>
    this.activeStore().currentBlocksFromState()
  );

  readonly pendingQueueFromState: Signal<QueuedMessage | null> = computed(() =>
    this.activeStore().pendingQueueFromState()
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
    this.activeStore()._setState(state);
  }

  private ensureListeners(): Promise<void> {
    this.listenerSetup ??= (async () => {
      await this.setupStreamListener();
      this.setupProjectStateListeners();
      this.setupRestartResumeListeners();
      void this.activeStore().refreshLlmConfigCache();
    })().catch((err: unknown) => {
      this.listenerSetup = null;
      throw err;
    });
    return this.listenerSetup;
  }

  /** Ensures the stream listener runs exactly once. Waits for project ready before starting chat. */
  async init(): Promise<void> {
    if (!this._backendTabsReset) {
      this._backendTabsReset = true;
      try {
        await this.tauri.invoke('reset_chat_tabs');
      } catch (err) {
        this.log.warn(`[chat-state] init: reset_chat_tabs invoke failed: ${String(err)}`);
      }
    }
    return this.activeStore().init();
  }

  /**
   * Clears the conversation and awaits a fresh backend session, so the caller can send
   * into an empty chat. Refuses before clearing; a failed start clears first, then throws.
   */
  startNewConversation(): Promise<void> {
    return this.activeStore().startNewConversation();
  }

  /**
   * Accepts a plain string (text-only) or `ChatInput` with attachments.
   * @param input - Raw text or composer bundle.
   * @param displayText - Overrides the bubble's surface text (plan-mode prefix flow).
   */
  sendMessage(input: string | ChatInput, displayText?: string): Promise<void> {
    return this.activeStore().sendMessage(input, displayText);
  }

  /**
   * Records one slot's answer for a multi-question AskUserQuestion block.
   * @param toolUseId - Tool_use_id of the AskUserQuestion control_request.
   * @param questionIdx - Slot index being answered (0-based).
   * @param value - Chosen value (multi-select labels pre-joined with `", "`).
   */
  submitAnswer(toolUseId: string, questionIdx: number, value: string): Promise<void> {
    return this.activeStore().submitAnswer(toolUseId, questionIdx, value);
  }

  /**
   * Stops the current Claude turn (no-op when not streaming). Resets UI state
   * synchronously to re-enable input, then fires the backend stop in background.
   */
  stopConversation(): Promise<void> {
    return this.activeStore().stopConversation();
  }

  /**
   * Processes a streaming chunk from the Claude subprocess, into the active tab's store.
   * Uses immutable updates: currentBlocks is replaced on every mutation.
   * @param chunk - The stream chunk to handle.
   */
  handleStreamChunk(chunk: StreamChunk): void {
    this.activeStore().handleStreamChunk(chunk);
  }

  /** Clears all chat state to start a fresh conversation. */
  resetForNewConversation(): void {
    this.activeStore().resetForNewConversation();
  }

  /**
   * Replaces the current messages with a pre-loaded set (e.g. from a transcript).
   * @param msgs - The messages to load.
   */
  loadMessages(msgs: ChatMessage[]): void {
    this.activeStore().loadMessages(msgs);
  }

  /**
   * Seeds the session id (resume or stream-start SystemInit) so retry / queue
   * can run before the first `Result`.
   * @param sessionId - Session uuid from a resume or a SystemInit chunk.
   */
  seedSessionId(sessionId: string): void {
    this.activeStore().seedSessionId(sessionId);
  }

  /**
   * Queue a message as the next turn (ADR-045); replace semantics.
   * @param text - The message to queue.
   */
  queueMessage(text: string): Promise<string | null> {
    return this.activeStore().queueMessage(text);
  }

  /** Cancel the queued message for the active session; no-op when empty. */
  cancelQueuedMessage(): Promise<void> {
    return this.activeStore().cancelQueuedMessage();
  }

  /**
   * Copies the message at `index` to the clipboard; elides tool/thinking/ask_user blocks.
   * @param index - Index into `messages` of the entry to copy.
   * @returns `true` on success, `false` on out-of-range / empty / write failure.
   */
  copyMessage(index: number): boolean {
    return this.activeStore().copyMessage(index);
  }

  /** Returns whether the last assistant turn can be retried (ADR-046). */
  canRetryLastAssistant(): boolean {
    return this.activeStore().canRetryLastAssistant();
  }

  /** Retries the last assistant turn via the backend `retry_last_turn` command (ADR-046). */
  retryLastAssistant(): Promise<void> {
    return this.activeStore().retryLastAssistant();
  }

  /**
   * Service-level (not component-level) so it works whether or not a ChatComponent is mounted.
   * Alias for {@link openConversation}.
   * @param sessionId - session UUID to resume.
   */
  resumeConversation(sessionId: string): Promise<void> {
    return this.openConversation(sessionId);
  }

  /** Re-reads `get_llm_config()` and updates the chat fallback-chain cache. */
  refreshLlmConfigCache(): Promise<void> {
    return this.activeStore().refreshLlmConfigCache();
  }

  /**
   * Re-reads `get_llm_config()` and updates every open tab's fallback-chain cache — a provider
   * config save is project-level, so a background tab must not keep a stale cache until its own
   * next `refreshControlData()` cycle.
   */
  async refreshLlmConfigCacheAll(): Promise<void> {
    await Promise.all(Array.from(this._tabs().values(), (store) => store.refreshLlmConfigCache()));
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
        this.resetTabsForProjectSwitch();
      } else if (status === 'ready') {
        void this.refreshLlmConfigCache();
        if (this._sawSwitching) {
          this._sawSwitching = false;
          void this.activeStore().startChatSession();
        }
      }
    });
  }

  private resetTabsForProjectSwitch(): void {
    for (const store of this._tabs().values()) {
      store.dispose();
    }
    const fresh = this.makeStore();
    fresh.setResumeDecider(this._resumeDecider);
    this._tabs.set(new Map([[fresh.tabId, fresh]]));
    this._activeTabId.set(fresh.tabId);
  }

  private setupRestartResumeListeners(): void {
    this.projectState.onRestartBegin(async () => {
      if (this.activeStore().isStreaming) await this.stopConversation();
    });
    this.projectState.onRestartComplete(() => {
      const activeTabId = this._activeTabId();
      for (const [tabId, store] of this._tabs()) {
        if (tabId === activeTabId) continue;
        if (store.lastKnownSessionId !== null || store.optimisticSessionId !== null) {
          store.markSessionEnded();
        }
      }
      void this.activeStore().decideResumeAfterRestart();
    });
  }

  private async setupStreamListener(): Promise<void> {
    try {
      this.unlisten = await this.tauri.listen<TabStreamChunk>('chat_stream', (event) => {
        const chunk = event.payload;
        const store = this._tabs().get(chunk.tab_id);
        if (!store) return;
        if (
          chunk.chunk_type === 'SystemInit' ||
          chunk.chunk_type === 'RateLimit' ||
          chunk.chunk_type === 'QueueDrained'
        ) {
          store.handleStreamChunk(chunk);
          return;
        }
        if (!store.isStreaming) return;
        store.handleStreamChunk(chunk);
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
