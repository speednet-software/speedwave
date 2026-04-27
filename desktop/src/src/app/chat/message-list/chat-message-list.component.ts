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

// `track` uses `msg.timestamp` until state-tree (ADR-044) gives `ChatMessage` a stable index.
const SCROLL_BOTTOM_THRESHOLD_PX = 16;

/** Scrollable message list with auto-scroll-to-bottom that pauses while the user reads earlier messages. */
@Component({
  selector: 'app-chat-message-list',
  imports: [ChatMessageComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 flex-1 flex-col' },
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
        } @else if (showAwaitingCaret()) {
          <!-- Streaming has started but no block has arrived yet. Show a
               blinking caret so the user has visual confirmation that
               the assistant is working — same caret used inline during
               text streaming, just rendered as a standalone placeholder. -->
          <div data-testid="chat-message-list-awaiting" class="px-1">
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
  /** Tracks message-count to detect new turns (vs. mere streaming deltas). */
  private lastMessageCount = 0;

  /**
   * Wires the streaming-aware scroll sync — re-runs on every signal input
   *  change so streaming deltas (which mutate `currentBlocks` in place) and
   *  new turns alike trigger a scroll-to-bottom.
   */
  constructor() {
    // Re-run on every signal-input change. `messages`, `currentBlocks` and
    // `isStreaming` all need to drive a scroll sync — relying on
    // `ngOnChanges` alone misses streaming deltas where the array reference
    // stays stable but its contents grow.
    effect(() => {
      const count = this.messages().length;
      // Reading these signals subscribes the effect to streaming chunks too.
      this.currentBlocks();
      this.isStreaming();
      // A genuinely new turn (length grew) re-arms auto-scroll even if the
      // user had previously scrolled up — they almost always want to see
      // the freshly-sent message + the assistant's reply.
      if (count > this.lastMessageCount) {
        this.shouldAutoScroll = true;
      }
      this.lastMessageCount = count;
      this.pendingScrollSync = true;
    });
  }

  /** Whether to render the streaming placeholder as the last entry. */
  showStreaming(): boolean {
    return this.isStreaming() && this.currentBlocks().length > 0;
  }

  /**
   * Whether to render the standalone blinking caret. True only in the gap
   * between sending a message and the first streamed block — once any block
   * arrives the regular streaming bubble takes over.
   */
  showAwaitingCaret(): boolean {
    return this.isStreaming() && this.currentBlocks().length === 0;
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
