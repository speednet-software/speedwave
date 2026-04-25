import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  OnDestroy,
  inject,
} from '@angular/core';
import { ChatStateService } from '../../services/chat-state.service';

/** Display window for the post-copy confirmation indicator (milliseconds). */
const COPY_FEEDBACK_MS = 1_500;

/**
 * Per-assistant-message action bar (copy + retry) — ADR-046.
 *
 * Lives directly under each assistant entry in the message list. The buttons
 * re-evaluate their disabled state on every change-detection cycle by reading
 * `chat.isStreaming` and `chat.canRetryLastAssistant()` directly — both are
 * cheap and recomputed only when the OnPush parent triggers CD.
 */
@Component({
  selector: 'app-message-actions',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex gap-1 mt-1 text-xs' },
  template: `
    <button
      type="button"
      data-testid="message-copy"
      class="px-2 py-1 rounded text-sw-muted hover:text-sw-text hover:bg-sw-bg-darkest transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      [attr.aria-label]="copied ? 'Copied to clipboard' : 'Copy message'"
      [disabled]="copyBusy"
      (click)="onCopy()"
    >
      {{ copied ? '✓ copied' : 'Copy' }}
    </button>
    @if (isLast) {
      <button
        type="button"
        data-testid="message-retry"
        class="px-2 py-1 rounded text-sw-muted hover:text-sw-text hover:bg-sw-bg-darkest transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        [attr.aria-label]="'Retry last response'"
        [disabled]="!canRetry()"
        (click)="onRetry()"
      >
        Retry
      </button>
    }
  `,
})
export class MessageActionsComponent implements OnDestroy {
  /** Index of the message entry this action bar acts on. */
  @Input({ required: true }) entryIndex!: number;
  /** Whether this is the last assistant entry — gates the retry button. */
  @Input() isLast = false;

  /** Showing the post-copy confirmation. */
  copied = false;
  /** Disables copy button while clipboard write is in flight. */
  copyBusy = false;

  private readonly chat = inject(ChatStateService);
  private readonly cdr = inject(ChangeDetectorRef);
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Returns whether the retry button is currently enabled. */
  canRetry(): boolean {
    return !this.chat.isStreaming && this.chat.canRetryLastAssistant();
  }

  /** Click handler for the copy button. */
  async onCopy(): Promise<void> {
    if (this.copyBusy) return;
    this.copyBusy = true;
    this.cdr.markForCheck();
    const ok = await this.chat.copyMessage(this.entryIndex);
    this.copyBusy = false;
    if (ok) {
      this.copied = true;
      this.cdr.markForCheck();
      if (this.copyTimer !== null) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        this.copied = false;
        this.copyTimer = null;
        this.cdr.markForCheck();
      }, COPY_FEEDBACK_MS);
    } else {
      this.cdr.markForCheck();
    }
  }

  /** Click handler for the retry button. */
  async onRetry(): Promise<void> {
    if (!this.canRetry()) return;
    await this.chat.retryLastAssistant();
  }

  /** Clears any pending "copied" confirmation timer to avoid setting a signal after destroy. */
  ngOnDestroy(): void {
    if (this.copyTimer !== null) {
      clearTimeout(this.copyTimer);
      this.copyTimer = null;
    }
  }
}
