import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  ViewChild,
} from '@angular/core';
import type { ChatMessage, MessageBlock } from '../../models/chat';
import { ChatMessageComponent } from '../message/chat-message.component';

// `track` uses `msg.timestamp` until state-tree (ADR-044) gives `ChatMessage` a stable index.
const SCROLL_BOTTOM_THRESHOLD_PX = 16;

/** Scrollable message list with auto-scroll-to-bottom that pauses while the user reads earlier messages. */
@Component({
  selector: 'app-chat-message-list',
  standalone: true,
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
        @for (msg of messages; track msg.timestamp) {
          <app-chat-message
            [blocks]="msg.blocks"
            [role]="msg.role"
            [timestamp]="msg.timestamp"
            (questionAnswered)="questionAnswered.emit($event)"
          />
        }
        @if (showStreaming) {
          <app-chat-message
            data-testid="chat-message-list-streaming"
            [blocks]="currentBlocks"
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
  @Input({ required: true }) messages!: readonly ChatMessage[];
  @Input() currentBlocks: readonly MessageBlock[] = [];
  @Input() isStreaming = false;

  @Output() questionAnswered = new EventEmitter<{ toolId: string; values: string[] }>();

  @ViewChild('scrollContainer') scrollContainer!: ElementRef<HTMLDivElement>;

  private shouldAutoScroll = true;
  private pendingScrollSync = false;

  /** Whether to render the streaming placeholder as the last entry. */
  get showStreaming(): boolean {
    return this.isStreaming && this.currentBlocks.length > 0;
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
