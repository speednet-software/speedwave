import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  inject,
  input,
} from '@angular/core';
import { ChatStateService } from '../../services/chat-state.service';

const COPY_FEEDBACK_MS = 1_500;

/**
 * Per-assistant action row — `[copy] [retry] ✓ copied` (mockup lines 920–924).
 * Per-turn metadata (model · edited · tokens · cache · cost) lives in the
 * sibling `<app-message-metadata>` component.
 */
@Component({
  selector: 'app-message-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'mono mt-3 flex items-center gap-3 text-[11px] text-[var(--ink-mute)]',
  },
  template: `
    <button
      type="button"
      data-testid="message-copy"
      class="hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
      [attr.aria-label]="copied ? 'Copied to clipboard' : 'Copy message'"
      [disabled]="copyBusy"
      (click)="onCopy()"
    >
      copy
    </button>
    @if (isLast()) {
      <button
        type="button"
        data-testid="message-retry"
        class="hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Retry last response"
        [disabled]="!chat.retryEnabled()"
        (click)="onRetry()"
      >
        retry
      </button>
    }
    @if (copied) {
      <span data-testid="message-copied" class="text-[var(--green)]">✓ copied</span>
    }
  `,
})
export class MessageActionsComponent implements OnDestroy {
  readonly entryIndex = input.required<number>();
  readonly isLast = input(false);

  /** Showing the post-copy confirmation. */
  copied = false;
  /** Disables copy button while clipboard write is in flight. */
  copyBusy = false;

  protected readonly chat = inject(ChatStateService);
  private readonly cdr = inject(ChangeDetectorRef);
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether the retry button is currently enabled. */
  canRetry(): boolean {
    return this.chat.canRetryLastAssistant();
  }

  /** Click handler for the copy button. */
  async onCopy(): Promise<void> {
    if (this.copyBusy) return;
    this.copyBusy = true;
    this.cdr.markForCheck();
    const ok = await this.chat.copyMessage(this.entryIndex());
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

  /** Clears any pending "copied" timer to avoid setting state after destroy. */
  ngOnDestroy(): void {
    if (this.copyTimer !== null) {
      clearTimeout(this.copyTimer);
      this.copyTimer = null;
    }
  }
}
