import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnChanges,
  ViewChild,
  effect,
  input,
  output,
} from '@angular/core';
import type { ChatMessage, MessageBlock } from '../../models/chat';
import { ChatMessageComponent } from '../message/chat-message.component';
import { SpinIconComponent } from '../../shared/spin-icon.component';

const SCROLL_BOTTOM_THRESHOLD_PX = 16;

/** Scrollable message list with auto-scroll-to-bottom that pauses while the user reads earlier messages. */
@Component({
  selector: 'app-chat-message-list',
  imports: [ChatMessageComponent, SpinIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <div
      #scrollContainer
      data-testid="chat-message-list"
      role="log"
      aria-live="polite"
      aria-label="Chat messages"
      class="relative h-full overflow-y-auto p-4 md:p-6"
      (scroll)="onScroll()"
    >
      @if (showTranscriptLoader()) {
        <div
          data-testid="chat-transcript-loading"
          class="absolute inset-0 flex items-center justify-center"
        >
          <app-spin-icon class="block h-8 w-8 text-[var(--accent)]" />
        </div>
      }
      <div class="mx-auto max-w-3xl space-y-8">
        @for (msg of messages(); track msg.timestamp; let i = $index) {
          <app-chat-message
            [blocks]="msg.blocks"
            [role]="msg.role"
            [timestamp]="msg.timestamp"
            [entryIndex]="i"
            [isLast]="i === lastAssistantIndex()"
            [entry]="msg"
            [precedingEdited]="isPrecedingUserEdited(i)"
            (questionAnswered)="questionAnswered.emit($event)"
          />
        }
        @if (showStreaming()) {
          <app-chat-message
            data-testid="chat-message-list-streaming"
            [blocks]="currentBlocks()"
            role="assistant"
            [streaming]="true"
            (questionAnswered)="questionAnswered.emit($event)"
          />
        } @else if (showAwaitingCaret()) {
          <!-- Standalone caret placeholder: streaming started, no block yet. -->
          <div data-testid="chat-message-list-awaiting">
            <span class="caret" aria-label="Assistant is responding"></span>
          </div>
        }
      </div>
    </div>
  `,
})
export class ChatMessageListComponent implements AfterViewChecked, OnChanges {
  readonly messages = input.required<readonly ChatMessage[]>();
  readonly currentBlocks = input<readonly MessageBlock[]>([]);
  readonly isStreaming = input(false);
  /** Shows a centered spinner while a resumed transcript is being fetched. */
  readonly loadingTranscript = input(false);
  /** Index of the most recent assistant entry in `messages` (`-1` when none); gates the per-message Retry button. */
  readonly lastAssistantIndex = input(-1);
  /** Identity of the rendered conversation (tab id); a change resets the per-conversation scroll tracking. */
  readonly conversationKey = input('');

  readonly questionAnswered = output<{ toolId: string; questionIdx: number; value: string }>();

  @ViewChild('scrollContainer') scrollContainer!: ElementRef<HTMLDivElement>;

  private shouldAutoScroll = true;
  private pendingScrollSync = false;
  /** Tracks message-count to detect new turns (vs. mere streaming deltas). */
  private lastMessageCount = 0;
  private lastConversationKey: string | null = null;
  private rederiveFromViewport = false;

  /** Wires the streaming-aware scroll sync, re-run on every signal-input change. */
  constructor() {
    effect(() => {
      const key = this.conversationKey();
      const count = this.messages().length;
      this.currentBlocks();
      this.isStreaming();
      const keyChanged = this.lastConversationKey !== null && key !== this.lastConversationKey;
      this.lastConversationKey = key;
      if (keyChanged) {
        this.lastMessageCount = count;
        this.rederiveFromViewport = true;
        this.pendingScrollSync = false;
        return;
      }
      if (this.rederiveFromViewport) {
        this.rederiveFromViewport = false;
        this.shouldAutoScroll = this.isAtBottom();
      }
      if (count > this.lastMessageCount) {
        this.shouldAutoScroll = true;
      }
      this.lastMessageCount = count;
      this.pendingScrollSync = true;
    });
  }

  private isAtBottom(): boolean {
    const el = this.scrollContainer?.nativeElement;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_THRESHOLD_PX;
  }

  /** Whether to show the transcript loader: fetching with nothing rendered yet. */
  showTranscriptLoader(): boolean {
    return this.loadingTranscript() && this.messages().length === 0;
  }

  /** Whether to render the streaming placeholder as the last entry. */
  showStreaming(): boolean {
    return this.isStreaming() && this.currentBlocks().length > 0;
  }

  /** Whether to render the standalone caret: streaming with no block yet. */
  showAwaitingCaret(): boolean {
    return this.isStreaming() && this.currentBlocks().length === 0;
  }

  /**
   * True when the user entry preceding `messages[i]` was retried (surfaces as `· edited`); false for user entries, index 0, or no `edited_at`.
   * @param i - Index into `messages()` to check.
   */
  isPrecedingUserEdited(i: number): boolean {
    if (i <= 0) return false;
    const list = this.messages();
    const self = list[i];
    if (!self || self.role !== 'assistant') return false;
    const prev = list[i - 1];
    return prev?.role === 'user' && typeof prev.edited_at === 'number';
  }

  /** Marks scroll position for sync on next `ngAfterViewChecked`. */
  ngOnChanges(): void {
    this.pendingScrollSync = true;
  }

  /** Tracks user scrolling to decide whether to pin new output to the bottom. */
  onScroll(): void {
    if (!this.scrollContainer?.nativeElement) return;
    this.shouldAutoScroll = this.isAtBottom();
  }

  /** Pins to the bottom after each render when the user has not scrolled up. */
  ngAfterViewChecked(): void {
    if (!this.pendingScrollSync) return;
    this.pendingScrollSync = false;
    if (!this.shouldAutoScroll) return;
    const el = this.scrollContainer?.nativeElement;
    if (!el) return;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 1) {
      el.scrollTop = el.scrollHeight;
    }
  }
}
