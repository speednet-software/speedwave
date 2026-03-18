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
import { marked } from 'marked';
import { TauriService } from '../services/tauri.service';
import { ChatStateService } from '../services/chat-state.service';
import { ProjectStateService } from '../services/project-state.service';
import type { ChatMessage, ConversationSummary, ConversationTranscript } from '../models/chat';
import { ChatMessageComponent } from './message/chat-message.component';
import { SessionStatsComponent } from './session-stats/session-stats.component';

/** Chat component that handles message rendering, user input, and streaming responses from Claude. */
@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, ChatMessageComponent, SessionStatsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chat.component.html',
})
export class ChatComponent implements OnInit, OnDestroy {
  @ViewChild('messageList') messageList!: ElementRef<HTMLDivElement>;

  inputText = '';

  conversations: ConversationSummary[] = [];
  showHistory = false;
  viewingTranscript: ConversationTranscript | null = null;
  historyLoading = false;
  historyError = '';
  projectMemory = '';
  showMemory = false;
  viewError = '';

  readonly chat = inject(ChatStateService);
  readonly projectState = inject(ProjectStateService);
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private unsubChange: (() => void) | null = null;
  private unsubProjectReady: (() => void) | null = null;

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
   * Converts markdown content to sanitized HTML for display.
   * Used by transcript view (which still uses flat content strings).
   * @param content - The raw markdown string to render.
   */
  renderMarkdown(content: string): string {
    return marked.parse(content, { async: false }) as string;
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
    this.showHistory = !this.showHistory;
    if (this.showHistory) {
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
    if (!this.viewingTranscript) return;
    const messages: ChatMessage[] = this.viewingTranscript.messages.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      blocks: msg.blocks ?? [{ type: 'text' as const, content: msg.content }],
      timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
    }));

    try {
      const project = this.projectState.activeProject;
      if (project) {
        await this.tauri.invoke('resume_conversation', { project, sessionId });
      }
      this.chat.loadMessages(messages);
    } catch (err) {
      this.chat.loadMessages([
        ...messages,
        {
          role: 'assistant',
          blocks: [
            {
              type: 'error' as const,
              content: `Failed to resume session: ${err}. Showing transcript for context only.`,
            },
          ],
          timestamp: Date.now(),
        },
      ]);
    }

    this.viewingTranscript = null;
    this.showHistory = false;
    this.cdr.markForCheck();
  }

  /** Starts a new conversation by clearing all state and re-initialising. */
  async newConversation(): Promise<void> {
    this.inputText = '';
    this.viewingTranscript = null;
    this.showHistory = false;
    this.showMemory = false;
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
    this.showMemory = !this.showMemory;
    if (this.showMemory) {
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
  }
}
