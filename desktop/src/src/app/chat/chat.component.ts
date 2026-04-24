import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TauriService } from '../services/tauri.service';
import { ChatStateService } from '../services/chat-state.service';
import { ProjectStateService } from '../services/project-state.service';
import { UiStateService } from '../services/ui-state.service';
import type { ChatMessage, ConversationSummary, ConversationTranscript } from '../models/chat';
import { ChatMessageComponent } from './message/chat-message.component';
import { SessionStatsComponent } from './session-stats/session-stats.component';
import { TextBlockComponent } from './blocks/text-block.component';
import { MemoryPanelComponent } from './memory-panel/memory-panel.component';
import { ConversationsSidebarComponent } from './conversations-sidebar/conversations-sidebar.component';

/** Chat component that handles message rendering, user input, and streaming responses from Claude. */
@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ChatMessageComponent,
    SessionStatsComponent,
    TextBlockComponent,
    MemoryPanelComponent,
    ConversationsSidebarComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chat.component.html',
})
export class ChatComponent implements OnInit, OnDestroy {
  @ViewChild('messageList') messageList!: ElementRef<HTMLDivElement>;

  inputText = '';

  conversations: ConversationSummary[] = [];
  viewingTranscript: ConversationTranscript | null = null;
  historyLoading = false;
  historyError = '';
  projectMemory = '';
  viewError = '';
  private resumeInProgress = false;

  readonly chat = inject(ChatStateService);
  readonly projectState = inject(ProjectStateService);
  readonly ui = inject(UiStateService);
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private router = inject(Router);
  private unsubChange: (() => void) | null = null;
  private unsubProjectReady: (() => void) | null = null;
  private unsubAuthWatch: (() => void) | null = null;

  /** True if the conversations sidebar is open. Backed by UiStateService. */
  get showHistory(): boolean {
    return this.ui.sidebarOpen();
  }
  /**
   * Sets the conversations-sidebar visibility by toggling the shared UI state signal.
   * @param value - True to open the sidebar, false to close it.
   */
  set showHistory(value: boolean) {
    if (value !== this.ui.sidebarOpen()) this.ui.toggleSidebar();
  }

  /** True if the memory panel is open. Backed by UiStateService. */
  get showMemory(): boolean {
    return this.ui.memoryOpen();
  }
  /**
   * Sets the memory-panel visibility by toggling the shared UI state signal.
   * @param value - True to open the panel, false to close it.
   */
  set showMemory(value: boolean) {
    if (value !== this.ui.memoryOpen()) this.ui.toggleMemory();
  }

  /** Session id currently being viewed in the transcript overlay, or null. */
  get currentViewSessionId(): string | null {
    return this.viewingTranscript?.session_id ?? null;
  }

  /** Subscribes to state changes from the service. */
  constructor() {
    this.unsubChange = this.chat.onChange(() => {
      this.cdr.markForCheck();
      this.scrollToBottom();
    });
  }

  /** Initializes chat session (idempotent — no-ops if already running). */
  async ngOnInit(): Promise<void> {
    await this.chat.init();
    this.cdr.markForCheck();
    this.scrollToBottom();

    this.unsubAuthWatch = this.projectState.onChange(() => {
      if (this.projectState.status === 'auth_required') {
        this.router.navigate(['/settings']);
      }
    });

    this.unsubProjectReady = this.projectState.onProjectReady(async () => {
      this.viewingTranscript = null;
      const wasHistoryOpen = this.showHistory;
      const wasMemoryOpen = this.showMemory;
      this.conversations = [];
      this.projectMemory = '';
      this.cdr.markForCheck();
      if (wasHistoryOpen) {
        await this.loadConversations();
      }
      if (wasMemoryOpen) {
        await this.loadProjectMemory();
      }
    });
  }

  /** True if the current turn is paused on an unanswered AskUserQuestion. */
  private hasUnansweredQuestion(): boolean {
    return this.chat.currentBlocks.some((b) => b.type === 'ask_user' && !b.question.answered);
  }

  /**
   * Handles ESC key to stop the current turn. Ignored when an unanswered
   * AskUserQuestion block is visible — ESC semantics belong to that block.
   * @param event - The keyboard event from the document.
   */
  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: Event): void {
    if (!this.chat.isStreaming) return;
    if (this.hasUnansweredQuestion()) return; // let the block own ESC semantics
    event.preventDefault();
    this.chat.stopConversation();
  }

  /** Handles the Stop button click. Stops the current turn unconditionally. */
  async onStopClicked(): Promise<void> {
    await this.chat.stopConversation();
  }

  /** Sends the current input text as a user message and invokes the backend. */
  async sendMessage(): Promise<void> {
    const text = this.inputText.trim();
    if (!text || this.chat.isStreaming) return;
    this.inputText = '';
    this.cdr.markForCheck();
    await this.chat.sendMessage(text);
  }

  /**
   * Handles Enter key press to send a message, allowing Shift+Enter for newlines.
   * @param event - The keyboard event from the input field.
   */
  onEnter(event: KeyboardEvent): void {
    if (event.shiftKey) {
      return;
    }
    event.preventDefault();
    this.sendMessage();
  }

  /**
   * Handles a user answering an AskUserQuestion prompt.
   * @param event - Contains the tool ID and selected answer values.
   * @param event.toolId - The tool ID of the answered question.
   * @param event.values - The selected or freeform answer values.
   */
  async onQuestionAnswered(event: { toolId: string; values: string[] }): Promise<void> {
    await this.chat.answerQuestion(event.toolId, event.values);
  }

  /** Toggles the history sidebar and loads conversations when opening. */
  async toggleHistory(): Promise<void> {
    this.ui.toggleSidebar();
    if (this.ui.sidebarOpen()) {
      await this.loadConversations();
    }
    this.cdr.markForCheck();
  }

  /** Loads conversation list from the backend for the active project. */
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
      console.error('loadConversations failed:', err);
      this.historyError = `Failed to load conversations: ${err}`;
      this.conversations = [];
    } finally {
      this.historyLoading = false;
      this.cdr.markForCheck();
    }
  }

  /**
   * Loads and displays a past conversation transcript in read-only mode.
   * @param sessionId - The UUID of the conversation to view.
   */
  async viewConversation(sessionId: string): Promise<void> {
    this.viewError = '';
    try {
      const project = this.projectState.activeProject;
      if (!project) return;
      this.viewingTranscript = await this.tauri.invoke<ConversationTranscript>('get_conversation', {
        project,
        sessionId,
      });
    } catch (err) {
      console.error('viewConversation failed:', err);
      this.viewError = `Failed to load conversation: ${err}`;
      this.viewingTranscript = null;
    }
    this.cdr.markForCheck();
  }

  /**
   * Resumes a past conversation: loads its messages and switches to live chat mode.
   * @param sessionId - The UUID of the conversation to resume.
   */
  async resumeConversation(sessionId: string): Promise<void> {
    if (!this.viewingTranscript || this.resumeInProgress) return;
    this.resumeInProgress = true;
    console.debug('[chat] resumeConversation: sessionId=%s', sessionId);
    const messages: ChatMessage[] = this.viewingTranscript.messages.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      blocks: normalizeHistoryBlocks(
        msg.blocks ?? [{ type: 'text' as const, content: msg.content }]
      ),
      timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
    }));

    // Load transcript messages immediately so the user sees history while
    // the backend resumes the session (which may take seconds).
    this.chat.loadMessages(messages);
    this.viewingTranscript = null;
    this.ui.closeSidebar();
    this.cdr.markForCheck();

    try {
      const project = this.projectState.activeProject;
      if (project) {
        console.debug('[chat] resumeConversation: invoking backend');
        await this.tauri.invoke('resume_conversation', { project, sessionId });
        console.debug('[chat] resumeConversation: backend success');
      }
    } catch (err) {
      console.error('[chat] resumeConversation failed:', err);
      const msg = String(err);
      if (msg.includes('not authenticated')) {
        await this.projectState.retryAuth();
      } else {
        this.chat.loadMessages([
          ...this.chat.messages,
          {
            role: 'assistant',
            blocks: [
              {
                type: 'error' as const,
                content: `Failed to resume session: ${err}`,
              },
            ],
            timestamp: Date.now(),
          },
        ]);
      }
    } finally {
      this.resumeInProgress = false;
    }
  }

  /** Starts a new conversation by clearing all state and re-initialising. */
  async newConversation(): Promise<void> {
    this.inputText = '';
    this.viewingTranscript = null;
    this.ui.closeSidebar();
    this.ui.closeMemory();
    this.chat.resetForNewConversation();
    this.cdr.markForCheck();
    await this.chat.init();
  }

  /** Closes the transcript read-only view. */
  closeTranscript(): void {
    this.viewingTranscript = null;
    this.cdr.markForCheck();
  }

  /** Toggles the project memory panel and loads memory on open. */
  async toggleMemory(): Promise<void> {
    this.ui.toggleMemory();
    if (this.ui.memoryOpen()) {
      await this.loadProjectMemory();
    }
    this.cdr.markForCheck();
  }

  /** Loads the project memory (CLAUDE.md contents) from the backend. */
  async loadProjectMemory(): Promise<void> {
    try {
      const project = this.projectState.activeProject;
      if (!project) {
        this.projectMemory = '';
        return;
      }
      this.projectMemory = await this.tauri.invoke<string>('get_project_memory', { project });
    } catch (err) {
      console.error('loadProjectMemory failed:', err);
      this.projectMemory = '';
    }
    this.cdr.markForCheck();
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      if (this.messageList?.nativeElement) {
        const el = this.messageList.nativeElement;
        el.scrollTop = el.scrollHeight;
      }
    }, 0);
  }

  /**
   * Intercepts clicks on external links and opens them in the system browser.
   * @param event - The mouse click event to inspect for anchor element targets.
   */
  @HostListener('click', ['$event'])
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

  /** Unsubscribes from change notifications and event listeners on component destruction. */
  ngOnDestroy(): void {
    if (this.unsubChange) {
      this.unsubChange();
    }
    if (this.unsubProjectReady) {
      this.unsubProjectReady();
      this.unsubProjectReady = null;
    }
    if (this.unsubAuthWatch) {
      this.unsubAuthWatch();
      this.unsubAuthWatch = null;
    }
  }
}

// ── History block normalization ───────────────────────────────────────

/** Raw tool_use block shape from Rust history.rs (flat, no nested `tool`). */
interface HistoryToolUseBlock {
  type: 'tool_use';
  tool_name: string;
  input_json: string;
}

/** Raw tool_result block from Rust history.rs. */
interface HistoryToolResultBlock {
  type: 'tool_result';
  content: string;
  is_error: boolean;
}

/**
 * Converts blocks from Rust history format to the Angular live-chat format.
 * History `tool_use` blocks are flat (`{ type, tool_name, input_json }`),
 * while live-chat blocks nest inside `{ type: 'tool_use', tool: ToolUseBlock }`.
 * History `tool_result` blocks are merged into the preceding `tool_use` block.
 * @param blocks - Raw blocks from Rust history (may be flat tool_use or already normalized).
 *   `tool_result` blocks are consumed and merged into the preceding `tool_use`;
 *   they do not appear standalone in the returned array.
 */
function normalizeHistoryBlocks(
  blocks: (import('../models/chat').MessageBlock | HistoryToolUseBlock | HistoryToolResultBlock)[]
): import('../models/chat').MessageBlock[] {
  const result: import('../models/chat').MessageBlock[] = [];

  for (const block of blocks) {
    if (block.type === 'tool_use' && !('tool' in block)) {
      // History format: flat tool_use → wrap into nested ToolUseBlock
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
      // History format: merge result into the preceding tool_use block.
      // tool_result blocks are consumed here and do not appear standalone.
      const hist = block as HistoryToolResultBlock;
      const prev = result[result.length - 1];
      if (prev?.type === 'tool_use') {
        const base = { ...prev.tool, result: hist.content };
        prev.tool = hist.is_error
          ? { ...base, status: 'error' as const, result_is_error: true as const }
          : { ...base, status: 'done' as const, result_is_error: false as const };
      } else {
        console.warn('[normalizeHistoryBlocks] orphaned tool_result (no preceding tool_use)');
      }
    } else {
      // text, thinking, error, or already-normalized tool_use — pass through
      result.push(block as import('../models/chat').MessageBlock);
    }
  }

  return result;
}
