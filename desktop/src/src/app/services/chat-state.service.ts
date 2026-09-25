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
import { warn as pluginLogWarn } from '@tauri-apps/plugin-log';
import { Clipboard } from '@angular/cdk/clipboard';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import { AnthropicModelsService } from './anthropic-models.service';
import { ClaudeControlService } from './claude-control.service';
import { PlanUsageService } from './plan-usage.service';
import { LoggerService } from './logger.service';
import type { ClaudeContextUsage } from '../models/claude-control';
import { isBlankOrSlashOnly, isControlShaped } from '../chat/slash/slash.service';
import {
  DEFAULT_CONTEXT_TOKENS,
  isAnthropicKind,
  isLocalProvider,
  isTerminalCostSource,
  type LlmConfigResponse,
  type LlmProviderKind,
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
  watchdogErrorKind,
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

type StartOutcome = 'started' | 'skipped' | 'auth' | 'failed';

interface StartResult {
  outcome: StartOutcome;
  sessionKept: boolean;
}

interface ConversationView extends LegacyStateSnapshot {
  totalOutputTokens: number;
  contextWindowSize: number | null;
  contextSnapshot: ClaudeContextUsage | null;
  queueAwaitingSession: boolean;
  initialized: boolean;
  lastKnownSessionId: string | null;
  optimisticSessionId: string | null;
  deferredEffort: string | null;
}

function emptyConversationView(): ConversationView {
  return {
    messages: [],
    currentBlocks: [],
    isStreaming: false,
    pendingQueue: null,
    sessionStats: null,
    model: '',
    totalOutputTokens: 0,
    contextWindowSize: null,
    contextSnapshot: null,
    queueAwaitingSession: false,
    initialized: false,
    lastKnownSessionId: null,
    optimisticSessionId: null,
    deferredEffort: null,
  };
}

interface ProjectPick {
  project: string | null;
  mark: number | null;
  request: number;
}

interface EffortPick extends ProjectPick {
  level: string;
}

interface ModelPick extends ProjectPick {
  wireId: string;
  routed: boolean;
}

type PinSave = { saved: true } | { saved: false; error: unknown };

export const NEW_CONVERSATION_FAILED =
  'Could not start a new chat. Open the chat tab to see why, then try again.';

export const NEW_CONVERSATION_BUSY = 'The chat session is still starting. Try again in a moment.';

export const NEW_CONVERSATION_NO_PROJECT = 'Open a project first.';

export const NEW_CONVERSATION_STREAMING =
  'The chat is still replying. Wait for it to finish, then try again.';

export const NEW_CONVERSATION_AUTH = 'Sign in to your LLM provider in Settings, then try again.';

export const NEW_CONVERSATION_PROJECT_CHANGED =
  'The project changed before the new chat started. Try again in this project.';

export const SESSION_KEPT_MARKER = 'the running chat session was kept';

function withoutSessionKeptMarker(message: string): string {
  return message.replace(`${SESSION_KEPT_MARKER}: `, '');
}

export const MODEL_SWITCH_NOT_APPLIED =
  'The containers were not restarted, so the model is not in use yet. Pick it again in a moment.';

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
  isDefault: boolean;
  contextTokens: number | null;
}

const DEFAULT_MODEL_ALIAS = 'default';

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

  private _pendingQueue: QueuedMessage | null = null;
  private _queueAwaitingSession = false;
  /** Public read-only accessor for the queued slot. */
  get pendingQueue(): QueuedMessage | null {
    return this._pendingQueue;
  }

  private readonly _pendingModelPick = signal<ModelPick | null>(null);
  private _pendingEffort: EffortPick | null = null;
  private _effortRequest = 0;
  private _effortSave: Promise<void> = Promise.resolve();
  private _effortApply: Promise<void> = Promise.resolve();
  private _modelRequest = 0;
  private _savedModelRequest = 0;
  private _modelSave: Promise<void> = Promise.resolve();
  private _launchedFor: { wireId: string; generation: number } | null = null;
  readonly pendingModelOverride: Signal<string | null> = computed(
    () => this._pendingModelPick()?.wireId ?? null
  );
  private readonly _deferredEffort = signal<string | null>(null);
  /** Effort level saved for new sessions that the live one did not confirm. */
  readonly deferredEffort: Signal<string | null> = this._deferredEffort.asReadonly();

  private releasePendingPicks(): void {
    if (this.isStreaming) return;
    const model = this._pendingModelPick();
    const effort = this._pendingEffort;
    this.dropPendingPicks();
    void this.takeReleasedPicks(model, effort);
  }

  private dropPendingPicks(): void {
    this._pendingModelPick.set(null);
    this._pendingEffort = null;
  }

  private async takeReleasedPicks(
    model: ModelPick | null,
    effort: EffortPick | null
  ): Promise<void> {
    const generation = this._sessionGeneration;
    if (model) await this.takeModelPick(model, true);
    if (effort && generation === this._sessionGeneration) {
      await this.applyEffortToConversation(effort);
    }
  }

  /**
   * Persists the effort pin, then applies it: queued while the chat is busy, sent to a live
   * conversation as an `apply_flag_settings` control request, else respawned.
   * @param level - One of `defaults::EFFORT_LEVELS`.
   */
  async applyEffortSelection(level: string): Promise<void> {
    const project = this.projectState.activeProject();
    const effort: EffortPick = {
      level,
      request: ++this._effortRequest,
      project,
      mark: this.projectState.settledMark(project),
    };
    this._modelSelectionError.set('');
    const saving = this._effortSave.then(() => this.saveEffortPin(project, level));
    this._effortSave = saving.then(() => undefined);
    const outcome = await saving;
    if (!this.isCurrentEffortPick(effort)) return;
    if (outcome.saved) {
      await this.takeEffortPick(effort, true);
      return;
    }
    this.reportSelectionFailure('effort pin write-through', outcome.error);
    await this.applySavedPin(effort);
  }

  private async takeEffortPick(effort: EffortPick, respawnIdle: boolean): Promise<void> {
    if (this.chatBusy()) {
      this._pendingEffort = effort;
    } else if (this.hasLiveSession()) {
      await this.applyEffortToConversation(effort);
    } else if (respawnIdle) {
      await this.respawnIdleSession();
    }
  }

  private async respawnIdleSession(launchedFor: string | null = null): Promise<void> {
    this.resetForNewConversation();
    const generation = this._sessionGeneration;
    this._launchedFor = launchedFor === null ? null : { wireId: launchedFor, generation };
    this.initialized = true;
    const { outcome } = await this.startChatSession();
    if (outcome !== 'started' && this._launchedFor?.generation === generation) {
      this._launchedFor = null;
    }
  }

  private launchedFor(wireId: string): boolean {
    const launched = this._launchedFor;
    return (
      launched !== null &&
      launched.wireId === wireId &&
      launched.generation === this._sessionGeneration
    );
  }

  private isNewestOf(pick: ProjectPick, newest: number): boolean {
    return pick.request === newest && this.stillSettledFor(pick);
  }

  private isNewestModelPick(pick: ModelPick): boolean {
    return this.isNewestOf(pick, this._modelRequest);
  }

  private isNewestSavedModelPick(pick: ModelPick): boolean {
    return this.isNewestOf(pick, this._savedModelRequest);
  }

  private async saveEffortPin(project: string | null, level: string): Promise<PinSave> {
    try {
      await this.tauri.invoke('set_effort_pin', { projectId: project ?? '', level });
      return { saved: true };
    } catch (error: unknown) {
      return { saved: false, error };
    }
  }

  private async applySavedPin(failed: EffortPick): Promise<void> {
    let pin: string | null;
    try {
      pin = await this.tauri.invoke<string | null>('get_effort_pin', {
        projectId: failed.project ?? '',
      });
    } catch (e: unknown) {
      this.log.warn(`[chat-state] get_effort_pin failed: ${String(e)}`);
      return;
    }
    if (!pin || !this.isCurrentEffortPick(failed)) return;
    await this.takeEffortPick({ ...failed, level: pin }, false);
  }

  private chatBusy(): boolean {
    return this.isStreaming || this.sessionStartInFlightFromState();
  }

  private applyEffortToConversation(effort: EffortPick): Promise<void> {
    const applying = this._effortApply.then(() => this.sendEffortToSession(effort));
    this._effortApply = applying.catch(() => undefined);
    return applying;
  }

  private isCurrentEffortPick(effort: EffortPick): boolean {
    return this.isNewestOf(effort, this._effortRequest);
  }

  private stillSettledFor(pick: ProjectPick): boolean {
    return this.projectState.isStillSettledOn(pick.project, pick.mark);
  }

  private async sendEffortToSession(effort: EffortPick): Promise<void> {
    if (!effort.project || !this.isCurrentEffortPick(effort)) return;
    if (this.chatBusy()) {
      this._pendingEffort = effort;
      return;
    }
    const generation = this._sessionGeneration;
    let applied = true;
    try {
      await this.tauri.invoke('apply_chat_effort', {
        project: effort.project,
        level: effort.level,
      });
    } catch (e: unknown) {
      applied = false;
      this.log.warn(`[chat-state] apply_chat_effort failed: ${String(e)}`);
    }
    if (generation !== this._sessionGeneration || !this.isCurrentEffortPick(effort)) return;
    this._deferredEffort.set(applied ? null : effort.level);
  }

  /** Restarts the session so it launches with the deferred effort; a conversation's background tasks stop. */
  async restartForDeferredEffort(): Promise<void> {
    if (this.chatBusy() || this.newConversationBlockedReason()) return;
    const sessionId = this._lastKnownSessionId;
    if (sessionId !== null) {
      await this.resumeConversation(sessionId);
    } else {
      await this.respawnIdleSession();
    }
  }

  private readonly _modelSelectionError = signal('');
  readonly modelSelectionError: Signal<string> = this._modelSelectionError.asReadonly();

  /**
   * Persists a composer model pick (Anthropic: `settings.json` pin; routed: config write-through),
   * then takes it: wire switch, queued override, or an idle respawn that a routed pick precedes with a compose re-render.
   * @param sel - Selected model triad emitted by the model selector.
   */
  async applyModelSelection(sel: ModelSelectionInput): Promise<void> {
    this._modelSelectionError.set('');
    const project = this.projectState.activeProject();
    const isAnthropic = sel.kind === 'anthropic_oauth' || sel.kind === 'anthropic_api_key';
    const clearsPin = isAnthropic && sel.isDefault;
    const pick: ModelPick = {
      wireId: clearsPin ? DEFAULT_MODEL_ALIAS : sel.wireId,
      routed: !isAnthropic,
      project,
      mark: this.projectState.settledMark(project),
      request: ++this._modelRequest,
    };
    const saving = this._modelSave.then(() => this.saveModelPick(sel, pick, clearsPin));
    this._modelSave = saving.then(() => undefined);
    const outcome = await saving;
    if (outcome.saved) {
      this._savedModelRequest = pick.request;
      await this.takeModelPick(pick, false);
    } else if (this.isNewestModelPick(pick)) {
      this.reportSelectionFailure('model selection persist', outcome.error);
    }
  }

  private async saveModelPick(
    sel: ModelSelectionInput,
    pick: ModelPick,
    clearsPin: boolean
  ): Promise<PinSave> {
    const projectId = pick.project ?? '';
    try {
      if (clearsPin) {
        await this.tauri.invoke('clear_model_pin', { projectId });
      } else if (!pick.routed) {
        await this.tauri.invoke('set_model_pin', { projectId, model: sel.wireId });
      } else {
        await this.anthropicModels.setProviderModel(
          projectId,
          sel.providerId,
          sel.catalogId,
          sel.contextTokens
        );
      }
      return { saved: true };
    } catch (error: unknown) {
      return { saved: false, error };
    }
  }

  private async takeModelPick(pick: ModelPick, released: boolean): Promise<void> {
    if (!this.stillSettledFor(pick)) return;
    if (this.chatBusy()) {
      this._pendingModelPick.set(pick);
      return;
    }
    this._pendingModelPick.set(null);
    const toRunningProcess = released && (!pick.routed || this.hasConversation());
    if (this.hasLiveSession() || toRunningProcess) {
      await this.switchLiveModel(pick);
      return;
    }
    if (pick.routed && this.launchedFor(pick.wireId)) return;
    if (pick.routed && !(await this.rerenderContainersForModel(pick))) return;
    if (!this.stillSettledFor(pick) || this.chatBusy() || this.hasLiveSession()) return;
    await this.respawnIdleSession(pick.routed && this.isNewestModelPick(pick) ? pick.wireId : null);
  }

  private async outlastRestart(): Promise<boolean> {
    const project = this.projectState.activeProject();
    const mark = this.projectState.settledMark(project);
    let restart = this.projectState.restartInFlight;
    while (restart) {
      await restart;
      restart = this.projectState.restartInFlight;
    }
    return this.projectState.isStillSettledOn(project, mark);
  }

  private async switchLiveModel(pick: ModelPick): Promise<void> {
    const generation = this._sessionGeneration;
    const sameConversation = (): boolean =>
      generation === this._sessionGeneration && this.stillSettledFor(pick);
    this._launchedFor = null;
    try {
      await this.tauri.invoke('switch_chat_model', {
        project: pick.project ?? '',
        model: pick.wireId,
      });
    } catch (e: unknown) {
      if (sameConversation() && this.isNewestSavedModelPick(pick)) {
        this.reportSelectionFailure('model switch', e);
      }
      return;
    }
    if (!sameConversation()) return;
    this.appendControlChip('model', pick.wireId);
    this.notifyChange();
  }

  private appendControlChip(command: string, argument: string, uuid?: string | null): void {
    if (command === 'model' && this.usesAnthropic()) this.forgetContextWindow();
    this._messages = [
      ...this._messages,
      {
        role: 'user',
        blocks: [{ type: 'chip', command, argument }],
        timestamp: Date.now(),
        ...(uuid ? { uuid, uuid_status: 'Committed' as const } : {}),
      },
    ];
  }

  private reportSelectionFailure(what: string, cause: unknown): void {
    const msg = cause instanceof Error ? cause.message : String(cause);
    this.log.warn(`${what} failed: ${msg}`);
    this._modelSelectionError.set(msg);
  }

  private async rerenderContainersForModel(pick: ModelPick): Promise<boolean> {
    const outcome = await this.projectState.restartContainers();
    if (outcome === 'restarted') return true;
    if (outcome === 'failed') {
      this.projectState.requestRestartFor(pick.project);
      if (this.isNewestSavedModelPick(pick)) {
        this.reportSelectionFailure(
          'compose re-render for the picked model',
          this.projectState.restartError
        );
      }
      return false;
    }
    if (this.isNewestSavedModelPick(pick)) {
      this._modelSelectionError.set(MODEL_SWITCH_NOT_APPLIED);
    }
    return false;
  }

  private hasLiveSession(): boolean {
    return this._lastKnownSessionId !== null;
  }

  private readonly _sessionStats = signal<SessionStats | null>(null);
  /** Session cost/usage stats from the most recent result. */
  get sessionStats(): SessionStats | null {
    return this._sessionStats();
  }
  readonly sessionStatsFromState: Signal<SessionStats | null> = this._sessionStats.asReadonly();

  /** Context tokens of the last main-chain API call; survives stream reset. */
  get lastContextTokens(): number | null {
    return this._lastContextTokens;
  }

  private _model = '';
  private _totalOutputTokens = 0;
  private _lastContextTokens: number | null = null;
  private _contextWindowSize: number | null = null;
  private _contextSnapshot: ClaudeContextUsage | null = null;
  private _currentProvider: string | null = null;
  private _activeKind: LlmProviderKind | null = null;

  private _persistedContextTokens: number | null = null;

  private _turnId = 0;
  /** Test-only read access. */
  get turnId(): number {
    return this._turnId;
  }

  private unlisten: UnlistenFn | null = null;
  private listenerSetup: Promise<void> | null = null;
  private initialized = false;
  private readonly startingSessionSignal = signal(false);
  private get startingSession(): boolean {
    return this.startingSessionSignal();
  }
  private set startingSession(v: boolean) {
    this.startingSessionSignal.set(v);
  }
  private _sessionGeneration = 0;

  /** Durable session id; survives a container restart that nulls live stats. */
  private _lastKnownSessionId: string | null = null;
  private _optimisticSessionId: string | null = null;
  private readonly resumeInProgressSignal = signal(false);
  private get _resumeInProgress(): boolean {
    return this.resumeInProgressSignal();
  }
  private set _resumeInProgress(v: boolean) {
    this.resumeInProgressSignal.set(v);
  }
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
  private control = inject(ClaudeControlService);
  private planUsage = inject(PlanUsageService);
  private clipboard = inject(Clipboard);
  private log = inject(LoggerService);
  private unsubProjectChange: (() => void) | null = null;

  private readonly _state = signal<ConversationStateTree>({ ...DEFAULT_STATE_TREE });
  readonly state: Signal<ConversationStateTree> = this._state.asReadonly();

  /** Reads Claude Code's control data as soon as a session answers `initialize`. */
  constructor() {
    effect(() => {
      const project = this.projectState.activeProject();
      if (!project || this.control.sessionInfoState(project).state !== 'ready') return;
      untracked(() => void this.refreshControlData());
    });
  }

  /** Re-reads the plan limits and the context usage on demand (the usage popover opened). */
  refreshUsage(): Promise<void> {
    return this.refreshControlData();
  }

  private async refreshControlData(): Promise<void> {
    if (this._activeKind === null) await this.refreshLlmConfigCache();
    const project = this.projectState.activeProject();
    if (!project) return;
    if (this._activeKind === 'anthropic_oauth') void this.planUsage.refresh(project);
    if (this._activeKind && isAnthropicKind(this._activeKind)) {
      void this.refreshContextUsage(project);
    }
  }

  private async refreshContextUsage(project: string): Promise<void> {
    const generation = this._sessionGeneration;
    const usage = await this.control.contextUsage(project);
    if (generation !== this._sessionGeneration) return;
    if (project !== this.projectState.activeProject()) return;
    this._contextSnapshot = usage;
    if (usage) this._contextWindowSize = usage.max_tokens;
    const cur = this._sessionStats();
    if (!cur && !usage) return;
    this._sessionStats.set({
      session_id: this._lastKnownSessionId ?? '',
      total_cost: null,
      total_output_tokens: 0,
      ...cur,
      context: usage ?? undefined,
      context_window_size: this._contextWindowSize,
    });
    this.notifyChange();
  }

  private usesAnthropic(): boolean {
    if (this._activeKind !== null) return isAnthropicKind(this._activeKind);
    return this._currentProvider === 'anthropic';
  }

  private async recordRateLimit(info: RateLimitInfo): Promise<void> {
    if (this._activeKind === null) await this.refreshLlmConfigCache();
    const project = this.projectState.activeProject();
    if (project && this._activeKind === 'anthropic_oauth') {
      this.planUsage.recordSignal(project, info);
    }
  }

  readonly messagesFromState: Signal<readonly ChatMessage[]> = computed(() =>
    stateEntriesToChatMessages(this._state().entries)
  );

  readonly isStreamingFromState: Signal<boolean> = computed(() => this._state().is_streaming);

  readonly hasConversation: Signal<boolean> = computed(() => this._state().entries.length > 0);

  readonly newConversationBlockedReason: Signal<string> = computed(() => {
    if (this.isStreamingFromState()) return NEW_CONVERSATION_STREAMING;
    if (this.resumeInProgressSignal() || this.startingSessionSignal()) return NEW_CONVERSATION_BUSY;
    if (!this.projectState.activeProject()) return NEW_CONVERSATION_NO_PROJECT;
    if (this.projectState.status() !== 'ready') return NEW_CONVERSATION_BUSY;
    return '';
  });

  readonly sessionStartInFlightFromState: Signal<boolean> = computed(
    () => this.startingSessionSignal() || this.resumeInProgressSignal()
  );

  private readonly _loadingTranscript = signal<boolean>(false);
  readonly loadingTranscriptFromState: Signal<boolean> = this._loadingTranscript.asReadonly();

  /** Mark the start of a transcript fetch (shows the loader). */
  beginTranscriptLoad(): void {
    this._loadingTranscript.set(true);
  }

  /** Mark the end of a transcript fetch (hides the loader). */
  endTranscriptLoad(): void {
    this._loadingTranscript.set(false);
  }

  /** Mark a resume's session start in flight until the returned function runs. */
  beginStartingSession(): () => void {
    this.startingSession = true;
    this._sessionGeneration += 1;
    return () => {
      this.startingSession = false;
    };
  }

  readonly retryEnabled: Signal<boolean> = computed(() => {
    const tree = this._state();
    if (tree.is_streaming || !tree.session_id) return false;
    return findRetryAnchorIn(tree.entries, 'committed') !== null;
  });

  readonly currentBlocksFromState: Signal<readonly MessageBlock[]> = computed(() => {
    const entries = this._state().entries;
    const last = entries[entries.length - 1];
    if (!last || last.role !== 'assistant') return [];
    if (last.uuid_status === 'committed' || last.meta !== null) return [];
    return stateBlocksToMessageBlocks(last.blocks);
  });

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

  private notifyChange(): void {
    this.rebuildStateTree();
  }

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

  private ensureListeners(): Promise<void> {
    this.listenerSetup ??= (async () => {
      await this.setupStreamListener();
      this.setupProjectStateListeners();
      this.setupRestartResumeListeners();
      void this.refreshLlmConfigCache();
    })().catch((err: unknown) => {
      this.listenerSetup = null;
      throw err;
    });
    return this.listenerSetup;
  }

  /** Ensures the stream listener runs exactly once. Waits for project ready before starting chat. */
  async init(): Promise<void> {
    this.log.debug(
      `[chat-state] init: listenerSetup=${this.listenerSetup !== null} initialized=${this.initialized}`
    );
    await this.ensureListeners();
    if (!this.initialized) {
      this.initialized = true;
      if (this.projectState.status() === 'ready') {
        void this.startChatSession();
      } else {
        const gen = this._sessionGeneration;
        const unsub = this.projectState.onProjectReady(() => {
          unsub();
          if (gen !== this._sessionGeneration) return;
          void this.startChatSession();
        });
      }
    }
  }

  private async startChatSession(keepPicksForKeptSession = false): Promise<StartResult> {
    const project = this.projectState.activeProject();
    const mark = this.projectState.settledMark(project);
    const current = (gen: number): boolean =>
      gen === this._sessionGeneration && this.projectState.isStillSettledOn(project, mark);
    if (this._resumeInProgress || this._lastKnownSessionId) {
      this.log.debug('[chat-state] startChatSession: skipped (resume owns the session)');
      return { outcome: 'skipped', sessionKept: false };
    }
    if (project && !this.startingSession) {
      this.startingSession = true;
      this._deferredEffort.set(null);
      const gen = this._sessionGeneration;
      this.log.debug(`[chat-state] startChatSession: project=${project}`);
      let outcome: StartOutcome = 'failed';
      let sessionKept = false;
      try {
        await this.tauri.invoke('start_chat', { project });
        this.log.debug('[chat-state] startChatSession: success');
        outcome = current(gen) ? 'started' : 'skipped';
      } catch (err) {
        if (!current(gen)) {
          this.log.debug(`[chat-state] startChatSession: superseded, ignoring: ${String(err)}`);
          outcome = 'skipped';
        } else {
          const msg = String(err);
          sessionKept = msg.includes(SESSION_KEPT_MARKER);
          if (isNotAuthenticatedError(msg)) {
            this.projectState.status.set('auth_required');
            this.notifyChange();
            outcome = 'auth';
          } else {
            this.log.error(`[chat-state] Failed to start chat session: ${msg}`);
            this.projectState.status.set('error');
            this.projectState.error = `Failed to start chat session: ${withoutSessionKeptMarker(msg)}`;
            this.notifyChange();
          }
        }
      } finally {
        if (gen === this._sessionGeneration) {
          this.startingSession = false;
        }
      }
      if (outcome === 'started') this.releasePendingPicks();
      else if (outcome !== 'skipped' && !(keepPicksForKeptSession && sessionKept)) {
        this.dropPendingPicks();
      }
      return { outcome, sessionKept };
    }
    return { outcome: 'skipped', sessionKept: false };
  }

  /**
   * Clears the conversation and awaits a fresh backend session, so the caller can send
   * into an empty chat. Refuses before clearing; a failed start clears first, then throws.
   */
  async startNewConversation(): Promise<void> {
    await this.replaceConversation(true);
  }

  private async replaceConversation(priorProcessMayRun: boolean): Promise<void> {
    await this.ensureListeners();
    const blocked = this.isStreaming
      ? NEW_CONVERSATION_STREAMING
      : this.newConversationBlockedReason();
    if (blocked) throw new Error(blocked);
    const project = this.projectState.activeProject();
    const mark = this.projectState.settledMark(project);
    const prior = this.captureConversationView();
    this.resetForNewConversation();
    this.initialized = true;
    this._sessionGeneration += 1;
    const gen = this._sessionGeneration;
    const keepsPrior = priorProcessMayRun && prior.lastKnownSessionId !== null;
    const { outcome, sessionKept } = await this.startChatSession(keepsPrior);
    if (!this.projectState.isStillSettledOn(project, mark)) {
      throw new Error(NEW_CONVERSATION_PROJECT_CHANGED);
    }
    if (outcome === 'started') return;
    if (gen === this._sessionGeneration) {
      if (keepsPrior && sessionKept) {
        this.restoreConversationView(prior);
      } else {
        this.initialized = false;
        this._lastKnownSessionId = prior.lastKnownSessionId;
        this._deferredEffort.set(prior.deferredEffort);
      }
    }
    if (outcome === 'auth') throw new Error(NEW_CONVERSATION_AUTH);
    throw new Error(outcome === 'skipped' ? NEW_CONVERSATION_BUSY : NEW_CONVERSATION_FAILED);
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
    if (!hasContent || this.chatBusy()) return;
    if (chatInput.attachments.length === 0 && isBlankOrSlashOnly(chatInput.text)) return;
    this.log.debug(`[chat-state] sendMessage: isStreaming=${this.isStreaming}`);

    const displayBlocks: MessageBlock[] = [];
    const surfaceText = displayText ?? chatInput.text;
    if (surfaceText.length > 0) {
      displayBlocks.push({ type: 'text', content: surfaceText });
    }
    for (const att of chatInput.attachments) {
      displayBlocks.push({ type: 'image', media_type: att.mediaType, alt: att.filename });
    }
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
    const generation = this._sessionGeneration;
    const turnId = this._turnId;
    const project = this.projectState.activeProject();
    const mark = this.projectState.settledMark(project);
    const sameConversation = (): boolean =>
      this.isStreaming && generation === this._sessionGeneration && turnId === this._turnId;
    const sameProject = (): boolean => this.projectState.isStillSettledOn(project, mark);
    try {
      await this.ensureListeners();
      await this.tauri.invoke('send_message', invokeArgs);
    } catch (err) {
      const errStr = String(err);
      if (
        errStr.includes('session exited') ||
        errStr.includes('no active session') ||
        errStr.includes('Broken pipe')
      ) {
        try {
          if (!sameConversation()) return;
          const result = await this.tauri.invoke<ProjectList>('list_projects');
          if (!sameConversation()) return;
          const retryBlocked = this.sessionStartInFlightFromState()
            ? 'Session is still starting (containers may be restarting). Please try again in a moment.'
            : result.active_project && project !== null && result.active_project !== project
              ? `The active project is now '${result.active_project}', not '${project}'. Switch projects in the project list, then resend the message.`
              : null;
          if (retryBlocked) {
            this.isStreaming = false;
            this._messages = [
              ...this._messages,
              {
                role: 'assistant',
                blocks: [{ type: 'error', content: retryBlocked }],
                timestamp: Date.now(),
              },
            ];
            this.notifyChange();
            return;
          }
          if (result.active_project) {
            this.startingSession = true;
            this._deferredEffort.set(null);
            try {
              await this.tauri.invoke('start_chat', { project: result.active_project });
            } finally {
              if (generation === this._sessionGeneration) this.startingSession = false;
            }
            if (!sameConversation()) return;
            await this.tauri.invoke('send_message', invokeArgs);
            return;
          }
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
            if (sameProject()) this.projectState.status.set('auth_required');
            if (!sameConversation()) return;
            this.isStreaming = false;
            this.notifyChange();
            return;
          }
          if (!sameConversation()) return;
          this.isStreaming = false;
          this._messages = [
            ...this._messages,
            {
              role: 'assistant',
              blocks: [
                {
                  type: 'error',
                  content: `Failed to restart session: ${withoutSessionKeptMarker(retryMsg)}`,
                },
              ],
              timestamp: Date.now(),
            },
          ];
          this.notifyChange();
          return;
        }
      }
      if (!sameConversation()) return;
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
    if (await this.interruptTurn()) this.releasePendingPicks();
  }

  private async interruptTurn(): Promise<boolean> {
    if (!this.isStreaming) return false;

    this._turnId += 1;

    this.isStreaming = false;

    const keptBlocks = interruptRunningTools(
      this._currentBlocks.filter((b) => b.type !== 'ask_user')
    );
    if (keptBlocks.length > 0) {
      this._messages = [
        ...this._messages,
        { role: 'assistant', blocks: keptBlocks, timestamp: Date.now() },
      ];
    }
    this._currentBlocks = [];
    this.notifyChange();

    try {
      await this.tauri.invoke('stop_chat');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('no active session')) {
        this.log.debug(`[chat-state] stopConversation: backend already idle: ${msg}`);
        return false;
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
      return false;
    }
    return true;
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

      case 'ToolInputComplete': {
        const streamed = findToolBlock(this._currentBlocks, chunk.data.tool_id);
        if (!streamed || jsonParseError(streamed.input_json) === null) break;
        if (!isNoArgumentTool(streamed.input_json, chunk.data.input_json)) {
          this.log.warn(
            `Tool input for "${streamed.tool_name}" (${streamed.tool_id}) was incomplete after ` +
              `streaming (${streamed.input_json.length} chars); replaced with the complete input ` +
              `from the assistant message (${chunk.data.input_json.length} chars)`
          );
        }
        this._currentBlocks = replaceToolInput(
          this._currentBlocks,
          chunk.data.tool_id,
          chunk.data.input_json
        );
        break;
      }

      case 'ToolResult': {
        this._currentBlocks = completeToolBlock(this._currentBlocks, chunk.data);
        const finished = findToolBlock(this._currentBlocks, chunk.data.tool_id);
        const parseError = finished ? jsonParseError(finished.input_json) : null;
        if (finished && parseError !== null) {
          this.log.warn(
            `Failed to parse tool input for "${finished.tool_name}" (${finished.tool_id}, ` +
              `${finished.input_json.length} chars): ${previewForLog(finished.input_json)} ` +
              `(${parseError})`
          );
        }
        break;
      }

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
        if (chunk.data.session_id) {
          this.seedSessionId(chunk.data.session_id);
          void this.flushDeferredQueue(chunk.data.session_id);
        }
        break;

      case 'ControlChip': {
        const { command, argument, uuid } = chunk.data;
        this.appendControlChip(command, argument, uuid);
        break;
      }

      case 'RateLimit':
        void this.recordRateLimit(chunk.data);
        break;

      case 'Result': {
        if (chunk.data.result_text) {
          const hasStreamedText = this._currentBlocks.some((b) => b.type === 'text');
          if (!hasStreamedText) {
            this._currentBlocks = [
              ...this._currentBlocks,
              { type: 'text', content: chunk.data.result_text },
            ];
          }
        }
        const resolvedModel = chunk.data.model ?? (this._model || undefined);
        const meta = buildEntryMeta(
          chunk.data,
          resolvedModel,
          isLocalProvider(this._currentProvider)
        );
        if (this._currentBlocks.length > 0) {
          const assistantUuid = chunk.data.assistant_uuid;
          const assistantEntry: ChatMessage = {
            role: 'assistant',
            blocks: interruptRunningTools(this._currentBlocks),
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
        this._contextWindowSize = this.resolveContextWindow(chunk.data.context_window_size);
        const livePreviewCost =
          !isLocalProvider(this._currentProvider) &&
          typeof chunk.data.total_cost === 'number' &&
          Number.isFinite(chunk.data.total_cost)
            ? chunk.data.total_cost
            : null;
        const contextUsage = chunk.data.context_usage ?? this._sessionStats()?.context_usage;
        this._sessionStats.set({
          session_id: chunk.data.session_id,
          total_cost: livePreviewCost,
          usage: chunk.data.usage,
          context_usage: contextUsage,
          model: resolvedModel,
          context: this._contextSnapshot ?? undefined,
          context_window_size: this._contextWindowSize,
          total_output_tokens: this._totalOutputTokens,
        });
        if (chunk.data.session_id) {
          this._lastKnownSessionId = chunk.data.session_id;
          void this.flushDeferredQueue(chunk.data.session_id);
        }
        this.releasePendingPicks();
        if (contextUsage) {
          this._lastContextTokens = contextTokensFrom(contextUsage);
        }
        void this.reconcileFooterCost(chunk.data.assistant_uuid);
        void this.refreshControlData();
        break;
      }

      case 'UserMessageCommit': {
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
        const watchdogKind = watchdogErrorKind(errContent);
        this._currentBlocks = [
          ...interruptRunningTools(this._currentBlocks),
          {
            type: 'error',
            content: errContent,
            ...(watchdogKind !== undefined ? { kind: watchdogKind } : {}),
          },
        ];
        this._messages = [
          ...this._messages,
          { role: 'assistant', blocks: [...this._currentBlocks], timestamp: Date.now() },
        ];
        this._currentBlocks = [];
        this.isStreaming = false;
        if (chunk.data.turn_ended) this.releasePendingPicks();
        void this.refreshControlData();
        break;
      }

      case 'QueueDrained': {
        this._pendingQueue = null;
        this._queueAwaitingSession = false;
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
        return;
    }
    this.notifyChange();
  }

  private resetCoreStreamState(): void {
    this._messages = [];
    this._currentBlocks = [];
    this.isStreaming = false;
    this._sessionStats.set(null);
    this._model = '';
    this._totalOutputTokens = 0;
    this._contextWindowSize = null;
    this._contextSnapshot = null;
  }

  private forgetContextWindow(): void {
    this._contextWindowSize = null;
    this._contextSnapshot = null;
    const cur = this._sessionStats();
    if (cur) this._sessionStats.set({ ...cur, context: undefined, context_window_size: null });
  }

  private captureConversationView(): ConversationView {
    return {
      messages: this._messages,
      currentBlocks: this._currentBlocks,
      isStreaming: this.isStreaming,
      sessionStats: this._sessionStats(),
      model: this._model,
      totalOutputTokens: this._totalOutputTokens,
      contextWindowSize: this._contextWindowSize,
      contextSnapshot: this._contextSnapshot,
      pendingQueue: this._pendingQueue,
      queueAwaitingSession: this._queueAwaitingSession,
      initialized: this.initialized,
      lastKnownSessionId: this._lastKnownSessionId,
      optimisticSessionId: this._optimisticSessionId,
      deferredEffort: this._deferredEffort(),
    };
  }

  private restoreConversationView(view: ConversationView): void {
    this._messages = [...view.messages];
    this._currentBlocks = [...view.currentBlocks];
    this.isStreaming = view.isStreaming;
    this._sessionStats.set(view.sessionStats);
    this._model = view.model;
    this._totalOutputTokens = view.totalOutputTokens;
    this._contextWindowSize = view.contextWindowSize;
    this._contextSnapshot = view.contextSnapshot;
    this._pendingQueue = view.pendingQueue;
    this._queueAwaitingSession = view.queueAwaitingSession;
    this.initialized = view.initialized;
    this._lastKnownSessionId = view.lastKnownSessionId;
    this._optimisticSessionId = view.optimisticSessionId;
    this._deferredEffort.set(view.deferredEffort);
    this.notifyChange();
  }

  /** Clears all chat state to start a fresh conversation. */
  resetForNewConversation(): void {
    this.log.debug('[chat-state] resetForNewConversation');
    this._sessionGeneration += 1;
    this.startingSession = false;
    this.dropPendingPicks();
    this.restoreConversationView(emptyConversationView());
  }

  /**
   * Replaces the current messages with a pre-loaded set (e.g. from a transcript).
   * @param msgs - The messages to load.
   */
  loadMessages(msgs: ChatMessage[]): void {
    this._messages = msgs;
    this.notifyChange();
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
    const seeded = this.resolveContextWindow(undefined);
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
    this._deferredEffort.set(null);
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

  private setupProjectStateListeners(): void {
    this.unsubProjectChange = this.projectState.onChange(() => {
      const status = this.projectState.status();
      const project = this.projectState.activeProject();
      if (project && (status === 'no_provider' || status === 'auth_required')) {
        this.planUsage.drop(project);
      }
      if (this.projectState.status() === 'switching') {
        this.resetCoreStreamState();
        this._persistedContextTokens = null;
        this._currentProvider = null;
        this._activeKind = null;
        this.clearSessionTracking();
        this.dropPendingPicks();
        this._launchedFor = null;
        this._deferredEffort.set(null);
        this._modelSelectionError.set('');
        this.notifyChange();
      } else if (this.projectState.status() === 'ready') {
        void this.refreshLlmConfigCache();
      }
    });
  }

  private setupRestartResumeListeners(): void {
    this.projectState.onRestartBegin(async () => {
      this._launchedFor = null;
      await this.interruptTurn();
    });
    this.projectState.onRestartFailed(() => {
      this.releasePendingPicks();
    });
    this.projectState.onRestartComplete(() => {
      void this.decideResumeAfterRestart();
    });
  }

  private async decideResumeAfterRestart(): Promise<void> {
    const id = this._lastKnownSessionId;
    if (!id) return;
    await this.refreshLlmConfigCache();
    if (this._lastKnownSessionId !== id) return;
    const historyTokens = this._lastContextTokens;
    const windowTokens = this._persistedContextTokens;
    const fits = historyFitsTarget(historyTokens, windowTokens);
    this.log.info(
      `[chat-state] restart resume decision: history_tokens=${historyTokens ?? 'unknown'} window_tokens=${windowTokens ?? 'unknown'} fits=${fits} decider=${this._resumeDecider !== null}`
    );
    if (fits) {
      void this.resumeConversation(id);
      return;
    }
    if (this._resumeDecider) {
      const choice = await this._resumeDecider();
      if (this._lastKnownSessionId !== id) return;
      if (choice === 'resume') void this.resumeConversation(id);
      else void this.startFreshSession();
    } else {
      void this.resumeConversation(id);
    }
  }

  private async startFreshSession(): Promise<void> {
    const project = this.projectState.activeProject();
    const mark = this.projectState.settledMark(project);
    try {
      await this.replaceConversation(false);
    } catch (err) {
      const content = `Could not start a new conversation: ${err instanceof Error ? err.message : String(err)}`;
      this.log.error(`[chat-state] startFreshSession failed: ${String(err)}`);
      if (!this.projectState.isStillSettledOn(project, mark)) return;
      this._messages = [
        ...this._messages,
        { role: 'assistant', blocks: [{ type: 'error', content }], timestamp: Date.now() },
      ];
      this.notifyChange();
    }
  }

  /**
   * Service-level (not component-level) so it works whether or not a ChatComponent is mounted.
   * @param sessionId - session UUID to resume.
   */
  async resumeConversation(sessionId: string): Promise<void> {
    if (this._resumeInProgress) return;
    this._resumeInProgress = true;
    const outlasted = !this.projectState.restartInFlight || (await this.outlastRestart());
    const project = this.projectState.activeProject();
    const mark = this.projectState.settledMark(project);
    const sameProject = (): boolean => this.projectState.isStillSettledOn(project, mark);
    let settled = outlasted && sameProject();
    if (settled && this.isStreaming) {
      await this.interruptTurn();
      const outlastedAgain = !this.projectState.restartInFlight || (await this.outlastRestart());
      settled = outlastedAgain && sameProject();
    }
    if (!settled) {
      this._resumeInProgress = false;
      return;
    }
    const prior = this.captureConversationView();
    this.resetForNewConversation();
    this.beginTranscriptLoad();
    const endStartingSession = this.beginStartingSession();
    const gen = this._sessionGeneration;
    this._optimisticSessionId = sessionId;
    this._lastKnownSessionId = sessionId;

    let outcome: StartOutcome = 'started';
    let sessionKept = false;
    try {
      if (!project) return;

      await this.tauri.invoke('resume_conversation', { project, sessionId });
      if (gen !== this._sessionGeneration || !sameProject()) return;
      const transcript = await this.tauri
        .invoke<ConversationTranscript>('get_conversation', { project, sessionId })
        .catch((err) => {
          this.log.error(`[chat-state] get_conversation failed: ${String(err)}`);
          return null;
        });
      if (gen !== this._sessionGeneration || !sameProject()) return;
      if (transcript) {
        this.loadMessages(toChatMessages(transcript));
      } else {
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
      this.seedSessionId(sessionId);
      this.seedContextFromTranscript();
    } catch (err) {
      this._optimisticSessionId = null;
      if (gen !== this._sessionGeneration) {
        this.log.debug(`[chat-state] resumeConversation superseded by a reset: ${String(err)}`);
        return;
      }
      this.log.error(`[chat-state] resumeConversation failed: ${String(err)}`);
      if (!sameProject()) return;
      const msg = String(err);
      sessionKept = msg.includes(SESSION_KEPT_MARKER);
      if (sessionKept) this.restoreConversationView(prior);
      if (isNotAuthenticatedError(msg)) {
        outcome = 'auth';
        await this.projectState.retryAuth();
      } else {
        outcome = 'failed';
        this.loadMessages([
          ...this.messagesFromState(),
          {
            role: 'assistant',
            blocks: [
              {
                type: 'error' as const,
                content: `Failed to resume session: ${withoutSessionKeptMarker(msg)}`,
              },
            ],
            timestamp: Date.now(),
          },
        ]);
      }
    } finally {
      this.endTranscriptLoad();
      endStartingSession();
      this._resumeInProgress = false;
      if (gen !== this._sessionGeneration) {
        this._optimisticSessionId = null;
        void this.startChatSession();
      }
    }
    if (gen !== this._sessionGeneration || !sameProject()) return;
    if (outcome === 'started') this.releasePendingPicks();
    else if (!sessionKept) this.dropPendingPicks();
  }

  private static readonly DEFERRED_RECONCILE_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

  private async reconcileFooterCost(assistantUuid: string | undefined, attempt = 0): Promise<void> {
    if (!assistantUuid) return;
    const project = this.projectState.activeProject();
    if (!project) return;
    const capturedTurn = this._turnId;
    try {
      const u = await this.tauri.invoke<ResponseUsage | null>('get_usage_for_response', {
        project,
        responseId: assistantUuid,
      });
      if (!u) return;
      if (isTerminalCostSource(u.cost_source)) {
        this.overwriteEntryCost(assistantUuid, u.cost_usd);
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
      this.log.debug(`[chat-state] reconcileFooterCost best-effort failed: ${String(err)}`);
    }
  }

  private conversationResponseIds(latestUuid: string): string[] {
    const ids = new Set<string>();
    for (const m of this._messages) {
      if (m.role === 'assistant' && m.uuid) ids.add(m.uuid);
    }
    ids.add(latestUuid);
    return [...ids];
  }

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

  private resolveContextWindow(liveValue: number | undefined): number | null {
    if (this.usesAnthropic()) {
      return this._contextSnapshot?.max_tokens ?? liveValue ?? this._contextWindowSize;
    }
    if (liveValue) return liveValue;
    if (this._persistedContextTokens) return this._persistedContextTokens;
    if (this._contextWindowSize) return this._contextWindowSize;
    if (this._currentProvider === null || isLocalProvider(this._currentProvider)) return null;
    return DEFAULT_CONTEXT_TOKENS;
  }

  /** Re-reads `get_llm_config()` and updates the chat fallback-chain cache. */
  async refreshLlmConfigCache(): Promise<void> {
    try {
      const config = await this.tauri.invoke<LlmConfigResponse>('get_llm_config');
      this._persistedContextTokens = config.context_tokens ?? null;
      this._currentProvider = config.provider;
      const kind = config.providers?.find((p) => p.id === config.active?.provider_id)?.kind ?? null;
      const project = this.projectState.activeProject();
      if (project && this._activeKind === 'anthropic_oauth' && kind !== 'anthropic_oauth') {
        this.planUsage.drop(project);
      }
      this._activeKind = kind;
      if (this._persistedContextTokens && !this._sessionStats()?.usage) {
        this._contextWindowSize = this._persistedContextTokens;
      }
      this.notifyChange();
    } catch (err) {
      this.log.debug(`[chat-state] refreshLlmConfigCache failed: ${String(err)}`);
    }
  }

  private async setupStreamListener(): Promise<void> {
    try {
      this.unlisten = await this.tauri.listen<StreamChunk>('chat_stream', (event) => {
        if (this.sessionStartInFlightFromState()) return;
        const chunk = event.payload;
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

function appendOrCreateTextBlock(blocks: MessageBlock[], content: string): MessageBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text') {
    return [...blocks.slice(0, -1), { type: 'text', content: last.content + content }];
  }
  return [...blocks, { type: 'text', content }];
}

function appendOrCreateThinkingBlock(blocks: MessageBlock[], content: string): MessageBlock[] {
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

function updateToolBlock(
  blocks: MessageBlock[],
  toolId: string,
  update: (tool: ToolUseBlock) => ToolUseBlock
): MessageBlock[] {
  return blocks.map((b) =>
    b.type === 'tool_use' && b.tool.tool_id === toolId ? { ...b, tool: update(b.tool) } : b
  );
}

function updateToolInput(blocks: MessageBlock[], toolId: string, delta: string): MessageBlock[] {
  return updateToolBlock(blocks, toolId, (t) => ({ ...t, input_json: t.input_json + delta }));
}

function replaceToolInput(
  blocks: MessageBlock[],
  toolId: string,
  inputJson: string
): MessageBlock[] {
  return updateToolBlock(blocks, toolId, (t) => ({ ...t, input_json: inputJson }));
}

function interruptRunningTools(blocks: MessageBlock[]): MessageBlock[] {
  return blocks.map((b) => {
    if (b.type !== 'tool_use' || b.tool.status !== 'running') return b;
    const tool: ToolUseBlock = {
      type: 'tool_use',
      tool_id: b.tool.tool_id,
      tool_name: b.tool.tool_name,
      input_json: b.tool.input_json,
      status: 'error',
      result: 'Interrupted',
      result_is_error: true,
    };
    return { ...b, tool };
  });
}

function findToolBlock(blocks: readonly MessageBlock[], toolId: string): ToolUseBlock | undefined {
  for (const b of blocks) {
    if (b.type === 'tool_use' && b.tool.tool_id === toolId) return b.tool;
  }
  return undefined;
}

function jsonParseError(input: string): string | null {
  try {
    JSON.parse(input);
    return null;
  } catch (err) {
    return String(err);
  }
}

function isNoArgumentTool(streamed: string, complete: string): boolean {
  return streamed === '' && complete === '{}';
}

const TOOL_INPUT_LOG_PREVIEW_CHARS = 200;

function previewForLog(input: string): string {
  const points = Array.from(input);
  if (points.length <= TOOL_INPUT_LOG_PREVIEW_CHARS) return input;
  return `${points.slice(0, TOOL_INPUT_LOG_PREVIEW_CHARS).join('')}…`;
}

function findRetryAnchorIn(
  entries: readonly {
    role: 'user' | 'assistant';
    uuid?: string | null;
    uuid_status?: string;
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
    const firstBlock = m.blocks?.[0];
    if (firstBlock?.type === 'chip' || firstBlock?.kind === 'chip') return null;
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

  if (!suppressCost && turn_cost !== undefined && Number.isFinite(turn_cost)) {
    meta.cost = turn_cost;
  }
  return meta;
}

function completeToolBlock(
  blocks: MessageBlock[],
  data: { tool_id: string; content: string; is_error: boolean }
): MessageBlock[] {
  return updateToolBlock(blocks, data.tool_id, (t) => {
    const base = {
      type: 'tool_use' as const,
      tool_id: t.tool_id,
      tool_name: t.tool_name,
      input_json: t.input_json,
    };
    return data.is_error
      ? { ...base, status: 'error', result: data.content, result_is_error: true }
      : { ...base, status: 'done', result: data.content, result_is_error: false };
  });
}

function findLastUserIndexMissingUuid(msgs: readonly ChatMessage[]): number {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m.role === 'user' && !m.uuid) return i;
  }
  return -1;
}

function findLastNonZeroAssistantUsage(msgs: readonly ChatMessage[]): TurnUsage | undefined {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const usage = msgs[i].role === 'assistant' ? msgs[i].meta?.usage : undefined;
    if (usage && !isZeroUsage(usage)) return usage;
  }
  return undefined;
}

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
    cost: src.sessionStats?.total_cost ?? 0,
    turn_count: src.messages.filter((m) => m.role === 'assistant').length,
  };
  return {
    session_id: src.sessionStats?.session_id || null,
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
      e.timestamp === 0;

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
      case 'error': {
        const watchdogKind = watchdogErrorKind(b.content);
        out.push({
          type: 'error',
          content: b.content,
          ...(watchdogKind !== undefined ? { kind: watchdogKind } : {}),
        });
        break;
      }
      case 'image':
        out.push({ type: 'image', media_type: b.media_type, alt: b.alt ?? undefined });
        break;
      case 'chip':
        out.push({ type: 'chip', command: b.command, argument: b.argument });
        break;
      default: {
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
 * Only a known window at or below a known history size counts as not fitting; unknown values resume.
 * @param historyTokens - Tokens used by the conversation so far, or null if unknown.
 * @param windowTokens - Target model's context window, or null if undiscovered.
 */
export function historyFitsTarget(
  historyTokens: number | null,
  windowTokens: number | null
): boolean {
  if (historyTokens == null || windowTokens == null) return true;
  return historyTokens < windowTokens;
}

interface HistoryToolUseBlock {
  type: 'tool_use';
  tool_name: string;
  input_json: string;
}

interface HistoryToolResultBlock {
  type: 'tool_result';
  content: string;
  is_error: boolean;
}

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
            MessageBlock | HistoryToolUseBlock | HistoryToolResultBlock | HistoryControlChipBlock
          )[])
        : ([{ type: 'text' as const, content: msg.content }] as MessageBlock[]);
    const blocks = normalizeHistoryBlocks(rawBlocks);
    const timestamp = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
    const base: ChatMessage = { role, blocks, timestamp };
    if (msg.uuid) {
      base.uuid = msg.uuid;
      base.uuid_status = 'Committed';
    }
    if (msg.model !== undefined || msg.usage !== undefined) {
      base.meta = {};
      if (msg.model !== undefined) base.meta.model = msg.model;
      if (msg.usage !== undefined) base.meta.usage = msg.usage;
    }
    return base;
  });
}

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
