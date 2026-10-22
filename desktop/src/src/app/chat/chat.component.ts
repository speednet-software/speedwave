import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Injector,
  OnDestroy,
  OnInit,
  ViewChild,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { TauriService } from '../services/tauri.service';
import { ChatStateService } from '../services/chat-state.service';
import { PlanUsageService } from '../services/plan-usage.service';
import { ProjectStateService } from '../services/project-state.service';
import { UiStateService } from '../services/ui-state.service';
import { LoggerService } from '../services/logger.service';
import { BetaService } from '../services/beta.service';
import type { ConversationSummary, ChatAttachment, StagedTranscript } from '../models/chat';
import { formatContextLabel } from '../models/llm';
import { ChatHeaderComponent } from './header/chat-header.component';
import { ChatMessageListComponent } from './message-list/chat-message-list.component';
import { ComposerComponent } from './composer/composer.component';
import { SessionStatsComponent } from './session-stats/session-stats.component';
import { MemoryPanelComponent } from './memory-panel/memory-panel.component';
import { ConversationsSidebarComponent } from './conversations-sidebar/conversations-sidebar.component';
import { ModalOverlayComponent } from '../shell/modal-overlay/modal-overlay.component';
import { capitalizeLevel } from './composer/model-selector/effort-slider.component';

/** Chat component that handles message rendering, user input, and streaming responses from Claude. */
@Component({
  selector: 'app-chat',
  imports: [
    CommonModule,
    RouterLink,
    ChatHeaderComponent,
    ChatMessageListComponent,
    ComposerComponent,
    SessionStatsComponent,
    MemoryPanelComponent,
    ConversationsSidebarComponent,
    ModalOverlayComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chat.component.html',
  host: {
    class: 'flex min-h-0 flex-1 flex-col overflow-hidden',
    '(click)': 'onLinkClick($event)',
    '(document:keydown.escape)': 'onEscape($event)',
  },
})
export class ChatComponent implements OnInit, OnDestroy {
  conversations: readonly ConversationSummary[] = [];
  historyLoading = false;
  historyError = '';
  projectMemory = '';
  memoryError = '';
  readonly gitBranch = signal<string | null>(null);
  readonly lastAssistantIndex = computed(() => {
    const msgs = this.chat.messagesFromState();
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role === 'assistant') return i;
    }
    return -1;
  });

  readonly deferredEffortLabel = computed(() => {
    const level = this.chat.deferredEffort();
    return level ? capitalizeLevel(level) : '';
  });

  readonly composerContextLabel = computed(() => {
    const windowSize = this.chat.sessionStatsFromState()?.context_window_size;
    return windowSize ? formatContextLabel(windowSize) : '';
  });

  readonly usageClock = signal(Date.now());
  readonly planLimits = computed(() =>
    this.planUsage.limits(this.projectState.activeProject(), this.usageClock())
  );
  readonly planLimitSignal = computed(() =>
    this.planUsage.lastSignal(this.projectState.activeProject())
  );

  readonly contextOverflowOpen = signal(false);
  private contextOverflowResolve: ((choice: 'resume' | 'fresh') => void) | null = null;

  readonly restartConfirmOpen = signal(false);
  readonly restartConfirmBody = signal('');

  @ViewChild('composer') private composer?: ComposerComponent;
  @ViewChild(ChatMessageListComponent) private messageList?: ChatMessageListComponent;

  readonly chat = inject(ChatStateService);
  readonly projectState = inject(ProjectStateService);
  private readonly planUsage = inject(PlanUsageService);
  readonly ui = inject(UiStateService);
  private readonly beta = inject(BetaService);
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private router = inject(Router);
  private log = inject(LoggerService);
  private readonly injector = inject(Injector);
  private unsubProjectReady: (() => void) | null = null;
  private unsubAuthWatch: (() => void) | null = null;

  /** Read-only aliases over the UI-state signals; the template binds these. */
  get showHistory(): boolean {
    return this.ui.sidebarOpen();
  }
  /** Read-only alias — see {@link showHistory}. */
  get showMemory(): boolean {
    return this.ui.memoryOpen();
  }

  /** Active live-chat session id; state owned by ChatStateService. */
  get currentViewSessionId(): string | null {
    return this.chat.sessionStats?.session_id ?? this.chat.optimisticSessionId;
  }

  /** Wires effects driven by the state-tree signal and the drawer toggles. */
  constructor() {
    let wasStreaming = false;
    effect(() => {
      const streaming = this.chat.isStreamingFromState();
      if (wasStreaming && !streaming) {
        void this.refreshGitBranch();
      }
      wasStreaming = streaming;
      this.cdr.markForCheck();
    });

    effect(() => {
      if (this.ui.sidebarOpen()) void this.loadConversations();
    });
    effect(() => {
      if (this.ui.memoryOpen()) void this.loadProjectMemory();
    });

    effect(() => {
      const activeId = this.chat.activeTabId();
      untracked(() => {
        const outgoingId = this.previousTabId;
        this.previousTabId = activeId;
        if (outgoingId === activeId) return;
        this.saveOutgoingTabState(outgoingId);
        this.restoreIncomingTabState(activeId);
      });
    });

    effect(() => {
      const requested = this.ui.restartRequested();
      untracked(() => {
        const previous = this.previousRestartRequest;
        this.previousRestartRequest = requested;
        if (previous === null || previous === requested) return;
        void this.newConversation();
      });
    });

    this.restoreIncomingTabState(this.previousTabId);
  }

  private previousTabId: string = this.chat.activeTabId();
  /** Tab id whose composer restore is still queued; guards against saving its stale pre-restore content. */
  private pendingRestoreTabId: string | null = null;
  /**
   * Last seen value of `UiStateService.restartRequested`; `null` until the first effect run so a
   * component (re)mount never replays a request bumped before it existed (shell's ⌘R channel).
   */
  private previousRestartRequest: number | null = null;

  /**
   * Snapshots the outgoing tab's draft, plan mode and scroll offset before the view rebinds.
   * @param tabId - Id of the tab being switched or navigated away from.
   */
  private saveOutgoingTabState(tabId: string): void {
    if (tabId === this.pendingRestoreTabId) return;
    const store = this.chat.tabs().get(tabId);
    if (!store || !this.composer) return;
    store.composerDraft.set(this.composer.text.value);
    store.composerPlanMode.set(this.composer.planMode());
    const list = this.messageList;
    const el = list?.scrollContainer?.nativeElement;
    store.scrollPosition = el && !list?.followsNewOutput() ? el.scrollTop : null;
  }

  /**
   * Restores the incoming tab's draft, plan mode and scroll offset after the view has rebound.
   * @param tabId - Id of the tab being switched or navigated to.
   */
  private restoreIncomingTabState(tabId: string): void {
    const store = this.chat.tabs().get(tabId);
    if (!store) return;
    const transcriptPending = store.composerPromptDraft() !== '';
    const applyDraft = (): void => {
      if (this.pendingRestoreTabId === tabId) this.pendingRestoreTabId = null;
      if (!this.composer || this.chat.activeTabId() !== tabId) return;
      if (!transcriptPending) {
        this.composer.setText(store.composerDraft());
      }
      this.composer.setPlanMode(store.composerPlanMode());
    };
    if (this.composer) {
      applyDraft();
    } else {
      this.pendingRestoreTabId = tabId;
      afterNextRender(applyDraft, { injector: this.injector });
    }
    afterNextRender(
      () => {
        if (this.chat.activeTabId() !== tabId) return;
        const el = this.messageList?.scrollContainer?.nativeElement;
        if (!el) return;
        el.scrollTop = store.scrollPosition ?? el.scrollHeight;
      },
      { injector: this.injector }
    );
  }

  /** Boots the chat session and subscribes to project lifecycle events (auth + ready). */
  async ngOnInit(): Promise<void> {
    await Promise.all([this.chat.init(), this.refreshGitBranch()]);
    this.cdr.markForCheck();

    this.unsubAuthWatch = this.projectState.onChange(() => {
      if (this.projectState.status() === 'auth_required') {
        this.router.navigate(['/settings']);
      }
    });

    this.chat.setResumeDecider(() => this.promptResumeOrFresh());

    this.unsubProjectReady = this.projectState.onProjectReady(async () => {
      const wasHistoryOpen = this.showHistory;
      const wasMemoryOpen = this.showMemory;
      this.conversations = [];
      this.projectMemory = '';
      this.memoryError = '';
      this.cdr.markForCheck();
      await this.refreshGitBranch(true);
      if (wasHistoryOpen) {
        await this.loadConversations();
      }
      if (wasMemoryOpen) {
        await this.loadProjectMemory();
      }
    });
  }

  private static readonly GIT_BRANCH_TTL_MS = 1500;
  private gitBranchLastReadAt = 0;

  private async refreshGitBranch(force = false): Promise<void> {
    const project = this.projectState.activeProject();
    if (!project) {
      this.gitBranch.set(null);
      return;
    }
    const now = Date.now();
    if (!force && now - this.gitBranchLastReadAt < ChatComponent.GIT_BRANCH_TTL_MS) {
      return;
    }
    this.gitBranchLastReadAt = now;
    try {
      const branch = await this.tauri.invoke<string | null>('get_git_branch', { project });
      this.gitBranch.set(branch);
    } catch {
      this.gitBranch.set(null);
    }
  }

  private hasUnansweredQuestion(): boolean {
    return this.chat
      .currentBlocksFromState()
      .some((b) => b.type === 'ask_user' && b.question.answers.some((a) => a === null));
  }

  /**
   * ESC stops the turn unless an AskUserQuestion awaits an answer. Wired via the
   * `host` decorator metadata (project forbids `@HostListener`).
   * @param event - keyboard event; consumed (preventDefault) when we handle it.
   */
  onEscape(event: Event): void {
    if (!this.chat.isStreaming) return;
    if (this.hasUnansweredQuestion()) return;
    event.preventDefault();
    this.chat.stopConversation();
  }

  /** Stops the current turn unconditionally (Stop button). */
  async onStopClicked(): Promise<void> {
    await this.chat.stopConversation();
  }

  /** The usage popover opened: re-evaluate reset times and re-read the limits and the context. */
  onUsageOpened(): void {
    this.usageClock.set(Date.now());
    void this.chat.refreshUsage();
  }

  /**
   * Composer submit handler.
   * @param event - Composer payload.
   * @param event.payload - Wire-side text (may carry plan-mode prefix).
   * @param event.displayText - Text shown in the local bubble.
   * @param event.attachments - Preprocessed paste attachments (or empty).
   */
  async sendMessage(event: {
    payload: string;
    displayText: string;
    attachments?: ChatAttachment[];
  }): Promise<void> {
    const attachments = event?.attachments ?? [];
    if (this.chat.isStreaming) return;
    if (!event?.payload && attachments.length === 0) return;
    this.cdr.markForCheck();
    const store = this.chat.activeStore();
    const staged = store.stagedTranscript();
    await this.chat.sendMessage(
      { text: withStagedTranscript(event.payload ?? '', staged), attachments },
      event.displayText
    );
    if (staged) store.unstageTranscript(staged);
  }

  /**
   * ADR-045 — composer signalled a queue request (user sent while streaming).
   * @param text Trimmed payload to queue.
   */
  async onQueueRequested(text: string): Promise<void> {
    if (!text) return;
    const store = this.chat.activeStore();
    const staged = store.stagedTranscript();
    await this.chat.queueMessage(withStagedTranscript(text, staged));
    if (staged) store.unstageTranscript(staged);
    this.cdr.markForCheck();
  }

  /** ADR-045 — composer signalled queue cancellation (X button). */
  async onQueueCancelled(): Promise<void> {
    await this.chat.cancelQueuedMessage();
    this.cdr.markForCheck();
  }

  /**
   * Forwards an answered AskUserQuestion slot to the chat-state service.
   * @param event - tool id, slot index, and the chosen value (single string;
   *   multi-select labels are joined with `", "` upstream).
   * @param event.toolId Identifier of the AskUserQuestion tool call being answered.
   * @param event.questionIdx Zero-based index of the answered slot within the questions array.
   * @param event.value Final answer string forwarded to the agent SDK.
   */
  async onQuestionAnswered(event: {
    toolId: string;
    questionIdx: number;
    value: string;
  }): Promise<void> {
    try {
      await this.chat.submitAnswer(event.toolId, event.questionIdx, event.value);
    } catch (err) {
      this.log.error(`[chat] onQuestionAnswered: unexpected error: ${String(err)}`);
    }
  }

  /**
   * Returns true when the assistant entry is the most recent message; gates Retry.
   * @param index - Index into `messagesFromState()` of the entry under test.
   */
  isLastAssistant(index: number): boolean {
    return index === this.lastAssistantIndex();
  }

  /** Flips the sidebar signal; data load is driven by the constructor effect. */
  toggleHistory(): void {
    this.ui.toggleSidebar();
    this.cdr.markForCheck();
  }

  /** Fetches the active project's past sessions; clears state if no active project. */
  async loadConversations(): Promise<void> {
    this.historyLoading = true;
    this.historyError = '';
    this.cdr.markForCheck();
    try {
      const project = this.projectState.activeProject();
      if (!project) {
        this.conversations = [];
        return;
      }
      this.conversations = await this.tauri.invoke<ConversationSummary[]>('list_conversations', {
        project,
      });
    } catch (err) {
      this.log.error(`[chat] loadConversations failed: ${String(err)}`);
      this.historyError = `Failed to load conversations: ${err}`;
      this.conversations = [];
    } finally {
      this.historyLoading = false;
      this.cdr.markForCheck();
    }
  }

  /**
   * Delegates to the service, which owns resume so it keeps working even if this component unmounts mid-resume.
   * @param sessionId - session UUID to resume.
   */
  async resumeConversation(sessionId: string): Promise<void> {
    this.ui.closeSidebar();
    await this.chat.resumeConversation(sessionId);
    this.cdr.markForCheck();
  }

  /**
   * Deletes a conversation's transcript file; resets live chat if currently active.
   * @param sessionId - session UUID to delete.
   */
  async deleteConversation(sessionId: string): Promise<void> {
    const project = this.projectState.activeProject();
    if (!project) return;
    const wasActive = this.currentViewSessionId === sessionId;
    this.historyError = '';
    try {
      await this.tauri.invoke('delete_conversation', { project, sessionId });
      this.conversations = this.conversations.filter((c) => c.session_id !== sessionId);
      if (sessionId === this.chat.lastKnownSessionId) this.chat.clearSessionTracking();
      if (wasActive) {
        this.chat.resetForNewConversation();
        await this.chat.init();
      }
    } catch (err) {
      this.log.error(`[chat] deleteConversation failed: ${String(err)}`);
      this.historyError = `Failed to delete conversation: ${err}`;
    } finally {
      this.cdr.markForCheck();
    }
  }

  /**
   * Restarts the current conversation (plus button, ⌘N; ⌘R with beta). With beta on, a tab holding
   * content or a streaming turn asks for confirmation first; without beta it resets at once.
   */
  async newConversation(): Promise<void> {
    if (this.beta.enabled() && (this.chat.isStreaming || this.chat.hasConversation())) {
      this.restartConfirmBody.set(
        this.chat.isStreaming
          ? 'The response in progress will be discarded.'
          : 'The current conversation will be discarded.'
      );
      this.restartConfirmOpen.set(true);
      this.cdr.markForCheck();
      return;
    }
    await this.resetConversation();
  }

  /** User confirmed the restart: closes the dialog and performs the reset. */
  async onRestartConfirm(): Promise<void> {
    this.restartConfirmOpen.set(false);
    await this.resetConversation();
  }

  /** User dismissed the restart confirmation (Cancel, backdrop, or Esc): no reset. */
  onRestartCancel(): void {
    this.restartConfirmOpen.set(false);
    this.cdr.markForCheck();
  }

  /** Clears all chat + drawer state and re-runs the chat session bootstrap. */
  private async resetConversation(): Promise<void> {
    this.ui.closeSidebar();
    this.ui.closeMemory();
    this.chat.resetForNewConversation();
    this.cdr.markForCheck();
    await this.chat.init();
    this.composer?.focusInput();
  }

  /** Flips the memory signal; data load is driven by the constructor effect. */
  toggleMemory(): void {
    this.ui.toggleMemory();
    this.cdr.markForCheck();
  }

  /** Fetches the active project's CLAUDE.md; surfaces backend errors via `memoryError` (parity with `historyError`). */
  async loadProjectMemory(): Promise<void> {
    this.memoryError = '';
    try {
      const project = this.projectState.activeProject();
      if (!project) {
        this.projectMemory = '';
        return;
      }
      this.projectMemory = await this.tauri.invoke<string>('get_project_memory', { project });
    } catch (err) {
      this.log.error(`[chat] loadProjectMemory failed: ${String(err)}`);
      this.projectMemory = '';
      this.memoryError = `Failed to load memory: ${err}`;
    }
    this.cdr.markForCheck();
  }

  /**
   * Intercept anchor clicks so http(s) links open in the system browser, not in-app.
   * @param event - the click event; preventDefault is called when we route to open_url.
   */
  onLinkClick(event: MouseEvent): void {
    const target = (event.target as HTMLElement).closest('a');
    if (!target) return;

    const href = target.getAttribute('href');
    if (!href) return;

    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(href);
    if (!schemeMatch) return;

    event.preventDefault();
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https') {
      this.tauri.invoke('open_url', { url: href });
    }
  }

  /** Tears down project-lifecycle subscriptions and saves the active tab's composer state. */
  ngOnDestroy(): void {
    this.saveOutgoingTabState(this.chat.activeTabId());
    if (this.unsubProjectReady) {
      this.unsubProjectReady();
      this.unsubProjectReady = null;
    }
    if (this.unsubAuthWatch) {
      this.unsubAuthWatch();
      this.unsubAuthWatch = null;
    }
    this.chat.setResumeDecider(null);
    this.contextOverflowResolve?.('fresh');
    this.contextOverflowResolve = null;
    this.contextOverflowOpen.set(false);
  }

  /** Resolves `'fresh'` on programmatic close (destroy or Esc), not just user choice. */
  promptResumeOrFresh(): Promise<'resume' | 'fresh'> {
    this.contextOverflowResolve?.('fresh');
    return new Promise<'resume' | 'fresh'>((resolve) => {
      this.contextOverflowResolve = resolve;
      this.contextOverflowOpen.set(true);
      this.cdr.markForCheck();
    });
  }

  /** Called when the user chooses "Resume anyway" in the context-overflow dialog. */
  onContextOverflowResume(): void {
    this.contextOverflowOpen.set(false);
    const resolve = this.contextOverflowResolve;
    this.contextOverflowResolve = null;
    resolve?.('resume');
  }

  /** Called when the user chooses "Start fresh" in the context-overflow dialog. */
  onContextOverflowFresh(): void {
    this.contextOverflowOpen.set(false);
    const resolve = this.contextOverflowResolve;
    this.contextOverflowResolve = null;
    resolve?.('fresh');
  }
}

function withStagedTranscript(text: string, staged: StagedTranscript | null): string {
  return staged ? `${text}\n\n${staged.markdown}` : text;
}
