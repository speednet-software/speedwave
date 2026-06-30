import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { TauriService } from '../services/tauri.service';
import { ChatStateService } from '../services/chat-state.service';
import { ProjectStateService } from '../services/project-state.service';
import { UiStateService } from '../services/ui-state.service';
import { LoggerService } from '../services/logger.service';
import type { ConversationSummary, ChatAttachment } from '../models/chat';
import { ChatHeaderComponent } from './header/chat-header.component';
import { ChatMessageListComponent } from './message-list/chat-message-list.component';
import { ComposerComponent } from './composer/composer.component';
import { SessionStatsComponent } from './session-stats/session-stats.component';
import { MemoryPanelComponent } from './memory-panel/memory-panel.component';
import { ConversationsSidebarComponent } from './conversations-sidebar/conversations-sidebar.component';
import { ModalOverlayComponent } from '../shell/modal-overlay/modal-overlay.component';

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
  /**
   * Active project's git branch, or `null` when not a repo. Re-read after each turn.
   */
  readonly gitBranch = signal<string | null>(null);
  /**
   * Index of the most recent assistant message in `messagesFromState()`;
   * `-1` when none.
   */
  readonly lastAssistantIndex = computed(() => {
    const msgs = this.chat.messagesFromState();
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role === 'assistant') return i;
    }
    return -1;
  });

  /** Controls the context-overflow confirm dialog visibility. */
  readonly contextOverflowOpen = signal(false);
  /** Resolves the pending `promptResumeOrFresh` promise when a button is chosen. */
  private contextOverflowResolve: ((choice: 'resume' | 'fresh') => void) | null = null;

  /** Composer reference used to refocus the textarea after parent-driven state resets. */
  @ViewChild('composer') private composer?: { focusInput: () => void };

  readonly chat = inject(ChatStateService);
  readonly projectState = inject(ProjectStateService);
  readonly ui = inject(UiStateService);
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private router = inject(Router);
  private log = inject(LoggerService);
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

  /**
   * Active live-chat session id — backend value when present, otherwise the
   * optimistic stamp set on resume (both owned by ChatStateService).
   */
  get currentViewSessionId(): string | null {
    return this.chat.sessionStats?.session_id ?? this.chat.optimisticSessionId;
  }

  /** Wires effects driven by the state-tree signal and the drawer toggles. */
  constructor() {
    // Refresh branch on streaming->idle to catch mid-turn git checkout.
    let wasStreaming = false;
    effect(() => {
      const streaming = this.chat.isStreamingFromState();
      if (wasStreaming && !streaming) {
        void this.refreshGitBranch();
      }
      wasStreaming = streaming;
      this.cdr.markForCheck();
      // Live-chat scrolling is owned by <app-chat-message-list>; no-op here.
    });

    // Decouple toggle from data load so keyboard shortcut works like button.
    effect(() => {
      if (this.ui.sidebarOpen()) void this.loadConversations();
    });
    effect(() => {
      if (this.ui.memoryOpen()) void this.loadProjectMemory();
    });
  }

  /** Boots the chat session and subscribes to project lifecycle events (auth + ready). */
  async ngOnInit(): Promise<void> {
    // Run init and branch read in parallel; they are independent.
    await Promise.all([this.chat.init(), this.refreshGitBranch()]);
    this.cdr.markForCheck();

    this.unsubAuthWatch = this.projectState.onChange(() => {
      if (this.projectState.status() === 'auth_required') {
        this.router.navigate(['/settings']);
      }
    });

    // Resume-on-restart lives in ChatStateService (survives this component being
    // destroyed on /settings). Register the overflow-prompt opener while mounted;
    // when unmounted the service auto-resumes instead of asking.
    this.chat.setResumeDecider(() => this.promptResumeOrFresh());

    this.unsubProjectReady = this.projectState.onProjectReady(async () => {
      const wasHistoryOpen = this.showHistory;
      const wasMemoryOpen = this.showMemory;
      this.conversations = [];
      this.projectMemory = '';
      this.memoryError = '';
      this.cdr.markForCheck();
      // Bypass TTL: project switch is a strong signal the branch could be different.
      await this.refreshGitBranch(true);
      if (wasHistoryOpen) {
        await this.loadConversations();
      }
      if (wasMemoryOpen) {
        await this.loadProjectMemory();
      }
    });
  }

  /** Min interval between two `get_git_branch` IPC roundtrips. */
  private static readonly GIT_BRANCH_TTL_MS = 1500;
  /** Epoch-ms of the last branch read; `0` forces the next call. */
  private gitBranchLastReadAt = 0;

  /**
   * Pulls the active project's git branch; silent on errors (chip hides) and
   * a no-op within the TTL window.
   * @param force - Skip the TTL check (used after a project switch).
   */
  private async refreshGitBranch(force = false): Promise<void> {
    const project = this.projectState.activeProject;
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

  /** True if the current turn is paused on an unanswered AskUserQuestion slot. */
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
    if (this.hasUnansweredQuestion()) return; // let the block own ESC semantics
    event.preventDefault();
    this.chat.stopConversation();
  }

  /** Stops the current turn unconditionally (Stop button). */
  async onStopClicked(): Promise<void> {
    await this.chat.stopConversation();
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
    await this.chat.sendMessage({ text: event.payload ?? '', attachments }, event.displayText);
  }

  /**
   * ADR-045 — composer signalled a queue request (user sent while streaming).
   * @param text Trimmed payload to queue.
   */
  async onQueueRequested(text: string): Promise<void> {
    if (!text) return;
    await this.chat.queueMessage(text);
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
      const project = this.projectState.activeProject;
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
   * Resumes a session from the history drawer. Closes the sidebar (UI), then
   * delegates to the service which owns the resume (works while unmounted too).
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
    const project = this.projectState.activeProject;
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

  /** Clears all chat + drawer state and re-runs the chat session bootstrap. */
  async newConversation(): Promise<void> {
    this.ui.closeSidebar();
    this.ui.closeMemory();
    this.chat.resetForNewConversation();
    this.cdr.markForCheck();
    await this.chat.init();
    // Re-focus composer so user can type immediately after clicking new conversation.
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
      const project = this.projectState.activeProject;
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

    if (href.startsWith('http://') || href.startsWith('https://')) {
      event.preventDefault();
      this.tauri.invoke('open_url', { url: href });
    }
  }

  /** Tears down project-lifecycle subscriptions registered in ngOnInit. */
  ngOnDestroy(): void {
    if (this.unsubProjectReady) {
      this.unsubProjectReady();
      this.unsubProjectReady = null;
    }
    if (this.unsubAuthWatch) {
      this.unsubAuthWatch();
      this.unsubAuthWatch = null;
    }
    // Unregister the overflow-prompt opener → service auto-resumes while unmounted.
    this.chat.setResumeDecider(null);
    // Dismiss any pending context-overflow dialog.
    this.contextOverflowResolve?.('fresh');
    this.contextOverflowResolve = null;
    this.contextOverflowOpen.set(false);
  }

  /**
   * Shows a confirm dialog when history exceeds the target window; resolves with
   * the user's choice or `'fresh'` on programmatic close (destroy or Esc).
   */
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
