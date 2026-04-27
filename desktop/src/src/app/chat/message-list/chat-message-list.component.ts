import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnChanges,
  ViewChild,
  input,
  output,
} from '@angular/core';
import type { ChatMessage, MessageBlock } from '../../models/chat';
import { ChatMessageComponent } from '../message/chat-message.component';

// `track` uses `msg.timestamp` until state-tree (ADR-044) gives `ChatMessage` a stable index.
const SCROLL_BOTTOM_THRESHOLD_PX = 16;

/** Scrollable message list with auto-scroll-to-bottom that pauses while the user reads earlier messages. */
@Component({
  selector: 'app-chat-message-list',
  imports: [ChatMessageComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block flex-1 min-h-0' },
  template: `
    <div
      #scrollContainer
      data-testid="chat-message-list"
      role="log"
      aria-live="polite"
      aria-label="Chat messages"
      class="h-full overflow-y-auto p-4 md:p-6"
      (scroll)="onScroll()"
    >
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
        }
      </div>
    </div>
  `,
})
export class ChatMessageListComponent implements AfterViewChecked, OnChanges {
  readonly messages = input.required<readonly ChatMessage[]>();
  readonly currentBlocks = input<readonly MessageBlock[]>([]);
  readonly isStreaming = input(false);
  /**
   * Index of the most recent assistant entry in `messages`; `-1` when none.
   * Used to gate the per-message Retry button (only the latest assistant
   * message is retryable).
   */
  readonly lastAssistantIndex = input(-1);

  readonly questionAnswered = output<{ toolId: string; values: string[] }>();

  @ViewChild('scrollContainer') scrollContainer!: ElementRef<HTMLDivElement>;

  private shouldAutoScroll = true;
  private pendingScrollSync = false;

  /** Whether to render the streaming placeholder as the last entry. */
  showStreaming(): boolean {
    return this.isStreaming() && this.currentBlocks().length > 0;
  }

  /**
   * True when the user entry immediately preceding `messages[i]` was retried.
   * Surfaces as `· edited` in the assistant's metadata row. Returns `false`
   * for user entries, the first entry, or when the preceding entry has no
   * `edited_at` timestamp.
   * @param i - Zero-based index of the assistant entry in `messages`.
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
    const el = this.scrollContainer?.nativeElement;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_THRESHOLD_PX;
    this.shouldAutoScroll = atBottom;
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
