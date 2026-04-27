import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  ViewChild,
  effect,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { TauriService } from '../services/tauri.service';
import { ChatStateService } from '../services/chat-state.service';
import { ProjectStateService } from '../services/project-state.service';
import { UiStateService } from '../services/ui-state.service';
import type {
  ChatMessage,
  ConversationSummary,
  ConversationTranscript,
  MessageBlock,
} from '../models/chat';
import { ChatHeaderComponent } from './header/chat-header.component';
import { ChatMessageListComponent } from './message-list/chat-message-list.component';
import { ComposerComponent } from './composer/composer.component';
import { SessionStatsComponent } from './session-stats/session-stats.component';
import { TextBlockComponent } from './blocks/text-block.component';
import { MemoryPanelComponent } from './memory-panel/memory-panel.component';
import { ConversationsSidebarComponent } from './conversations-sidebar/conversations-sidebar.component';

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
    TextBlockComponent,
    MemoryPanelComponent,
    ConversationsSidebarComponent,
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
   * Cached index of the most recent assistant message in `chat.messages`,
   * recomputed on every state-change notification. Avoids the O(n) scan in
   * `isLastAssistant` becoming O(n²) when the template iterates every entry.
   * `-1` when no assistant message exists.
   */
  lastAssistantIndex = -1;
  private resumeInProgress = false;

  /**
   * Composer reference used to refocus the textarea after parent-driven
   *  state resets (new conversation, etc.) — autofocus on mount happens
   *  inside the composer's own `ngAfterViewInit`.
   */
  @ViewChild('composer') private composer?: { focusInput: () => void };

  readonly chat = inject(ChatStateService);
  readonly projectState = inject(ProjectStateService);
  readonly ui = inject(UiStateService);
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private router = inject(Router);
  private unsubChange: (() => void) | null = null;
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
   * Optimistic session id stamped the moment the user clicks a row in the
   * conversations drawer. The backend may take a turn or two to surface the
   * resumed session id in `chat.sessionStats`, so we keep this local override
   * to drive the drawer's accent indicator without flickering.
   */
  private optimisticSessionId: string | null = null;

  /**
   * Active live-chat session id — backend value when present, otherwise the
   *  optimistic stamp set on resume.
   */
  get currentViewSessionId(): string | null {
    return this.chat.sessionStats?.session_id ?? this.optimisticSessionId;
  }

  /** Wires change-detection callbacks and effects that lazy-load data when drawers open. */
  constructor() {
    this.unsubChange = this.chat.onChange(() => {
      this.recomputeLastAssistantIndex();
      this.cdr.markForCheck();
      // Live-chat scrolling is owned by <app-chat-message-list>; no-op here.
    });

    // Decouple data loading from the toggle source so the keyboard shortcut
    // (⌘B in shell.component, which only flips the signal) loads data the
    // same way the History button does.
    effect(() => {
      if (this.ui.sidebarOpen()) void this.loadConversations();
    });
    effect(() => {
      if (this.ui.memoryOpen()) void this.loadProjectMemory();
    });
  }

  /** Recomputes the cached `lastAssistantIndex` from the current messages. */
  private recomputeLastAssistantIndex(): void {
    const msgs = this.chat.messages;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role === 'assistant') {
        this.lastAssistantIndex = i;
        return;
      }
    }
    this.lastAssistantIndex = -1;
  }

  /** Boots the chat session and subscribes to project lifecycle events (auth + ready). */
  async ngOnInit(): Promise<void> {
    await this.chat.init();
    this.cdr.markForCheck();

    this.unsubAuthWatch = this.projectState.onChange(() => {
      if (this.projectState.status === 'auth_required') {
        this.router.navigate(['/settings']);
      }
    });

    this.unsubProjectReady = this.projectState.onProjectReady(async () => {
      const wasHistoryOpen = this.showHistory;
      const wasMemoryOpen = this.showMemory;
      this.conversations = [];
      this.projectMemory = '';
      this.memoryError = '';
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
   * ESC stops the current turn — but only when no AskUserQuestion is awaiting an answer.
   *
   * Wired via `host: { '(document:keydown.escape)': … }` because the project's
   * best-practices forbid `@HostListener` (use the `host` decorator metadata).
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
   * Sends a message as the user's next turn. Called by the composer on submit.
   * Guards against empty input and in-flight streaming.
   * @param event - Composer payload object.
   * @param event.payload - Backend message body (may include plan-mode prefix).
   * @param event.displayText - Surface text rendered in the local user bubble.
   */
  async sendMessage(event: { payload: string; displayText: string }): Promise<void> {
    if (!event?.payload || this.chat.isStreaming) return;
    this.cdr.markForCheck();
    await this.chat.sendMessage(event.payload, event.displayText);
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
   * Forwards an answered AskUserQuestion to the chat-state service.
   * @param event - tool id and the selected values from the question block.
   * @param event.toolId - id of the tool_use that produced the question.
   * @param event.values - selected values; one per chosen option.
   */
  async onQuestionAnswered(event: { toolId: string; values: string[] }): Promise<void> {
    await this.chat.answerQuestion(event.toolId, event.values);
  }

  /**
   * Returns true when the assistant entry at `index` is the most recent
   * assistant message — used to gate the per-message Retry button. Reads a
   * precomputed index updated on each state-change notification, so the
   * per-row template lookup is O(1) instead of O(n).
   * @param index - Index into `chat.messages` of the entry under test.
   */
  isLastAssistant(index: number): boolean {
    return index === this.lastAssistantIndex;
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
      console.error('loadConversations failed:', err);
      this.historyError = `Failed to load conversations: ${err}`;
      this.conversations = [];
    } finally {
      this.historyLoading = false;
      this.cdr.markForCheck();
    }
  }

  /**
   * Resumes a session in live chat mode. The drawer click is the primary
   * action — there is no longer a "view transcript" intermediate step.
   *
   * Flow: clear local state -> fetch the persisted transcript and surface its
   * messages immediately (Claude Code's `--resume` reuses the session but
   * does not replay history on the stream-json channel) -> invoke
   * `resume_conversation` so subsequent user turns continue the same session.
   * @param sessionId - session UUID to resume.
   */
  async resumeConversation(sessionId: string): Promise<void> {
    if (this.resumeInProgress) return;
    this.resumeInProgress = true;

    this.chat.resetForNewConversation();
    // Stamp the active session id immediately so the drawer's accent
    // indicator follows the user's click without waiting for the backend
    // to surface session_id on the next stream chunk.
    this.optimisticSessionId = sessionId;
    this.ui.closeSidebar();
    this.cdr.markForCheck();

    try {
      const project = this.projectState.activeProject;
      if (!project) return;

      // Run transcript fetch and the live-session relaunch in parallel —
      // the two backend calls are independent (resume_conversation does
      // not need the transcript). When both resolve we load the messages
      // even if `resume_conversation` finished first.
      const transcriptPromise = this.tauri
        .invoke<ConversationTranscript>('get_conversation', { project, sessionId })
        .catch((err) => {
          console.error('[chat] get_conversation failed:', err);
          return null;
        });
      const resumePromise = this.tauri.invoke('resume_conversation', { project, sessionId });

      const [transcript] = await Promise.all([transcriptPromise, resumePromise]);
      if (transcript) {
        this.chat.loadMessages(toChatMessages(transcript));
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
      this.cdr.markForCheck();
    }
  }

  /** Clears all chat + drawer state and re-runs the chat session bootstrap. */
  async newConversation(): Promise<void> {
    this.ui.closeSidebar();
    this.ui.closeMemory();
    this.optimisticSessionId = null;
    this.chat.resetForNewConversation();
    this.cdr.markForCheck();
    await this.chat.init();
    // Re-focus the composer so the user can start typing right after
    // hitting "+ new conversation" without an extra click.
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
      console.error('loadProjectMemory failed:', err);
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

  /** Tears down change subscriptions registered in the constructor and ngOnInit. */
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

/** Raw tool_result block from Rust history.rs (consumed during normalization). */
interface HistoryToolResultBlock {
  type: 'tool_result';
  content: string;
  is_error: boolean;
}

/**
 * Maps a backend `ConversationTranscript` into the live-chat `ChatMessage[]`
 * shape used by `ChatStateService.loadMessages`.
 *
 * Each transcript entry carries either pre-built `blocks` or a flat `content`
 * string. We prefer `blocks` so tool calls / thinking sections survive the
 * round-trip; otherwise we fall back to a single text block.
 * @param transcript - Backend conversation transcript to convert.
 */
function toChatMessages(transcript: ConversationTranscript): ChatMessage[] {
  return transcript.messages.map((msg) => {
    const role: 'user' | 'assistant' = msg.role === 'user' ? 'user' : 'assistant';
    const rawBlocks =
      msg.blocks && msg.blocks.length > 0
        ? (msg.blocks as unknown as (MessageBlock | HistoryToolUseBlock | HistoryToolResultBlock)[])
        : ([{ type: 'text' as const, content: msg.content }] as MessageBlock[]);
    const blocks = normalizeHistoryBlocks(rawBlocks);
    const timestamp = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
    return { role, blocks, timestamp };
  });
}

/**
 * Converts blocks from the backend history format to the live-chat format.
 *
 * History `tool_use` blocks are flat (`{ type, tool_name, input_json }`),
 * while live-chat blocks nest the tool data inside
 * `{ type: 'tool_use', tool: ToolUseBlock }`. History `tool_result` blocks
 * are consumed and merged into the preceding `tool_use` block — they never
 * appear standalone in the returned array.
 * @param blocks - Raw blocks from the backend history payload.
 */
function normalizeHistoryBlocks(
  blocks: (MessageBlock | HistoryToolUseBlock | HistoryToolResultBlock)[]
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
    } else {
      result.push(block as MessageBlock);
    }
  }

  return result;
}
