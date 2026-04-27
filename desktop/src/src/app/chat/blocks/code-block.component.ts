import { ChangeDetectionStrategy, Component, OnDestroy, input, signal } from '@angular/core';

/**
 * Terminal-minimal code block with optional filename header and copy button.
 *
 * Layout matches the mockup (lines 810–821): mono wrapper with rounded ring,
 * a `bg-[var(--bg-1)]` header strip carrying the filename + copy action, and
 * a `<pre>` body with syntax-coloured spans.
 */
@Component({
  selector: 'app-code-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block my-2' },
  template: `<div
    data-testid="code-block"
    class="mono overflow-hidden rounded ring-1 ring-[var(--line)] bg-[var(--bg-1)]"
  >
    @if (filename() || copyable()) {
      <div
        data-testid="code-block-header"
        class="flex items-center bg-[var(--bg-1)] px-3 py-1 text-[11px] text-[var(--ink-mute)]"
      >
        @if (filename()) {
          <span class="mono text-[var(--teal)]">{{ filename() }}</span>
        }
        @if (copyable()) {
          <button
            type="button"
            data-testid="code-block-copy"
            class="mono ml-auto hover:text-[var(--ink)]"
            aria-label="Copy code"
            (click)="copy()"
          >
            @if (justCopied()) {
              <span class="text-[var(--green)]" data-testid="code-block-copied">✓ copied</span>
            } @else {
              copy
            }
          </button>
        }
      </div>
    }
    <pre
      data-testid="code-block-body"
      class="mono overflow-x-auto whitespace-pre bg-[var(--bg)] p-3 text-[12.5px] leading-[1.7]"
    ><code>{{ code() }}</code></pre>
  </div>`,
})
export class CodeBlockComponent implements OnDestroy {
  /** Verbatim code content; rendered inside `<pre><code>`. */
  readonly code = input.required<string>();
  /** File path or name shown in the header row. Empty = no header. */
  readonly filename = input<string>('');
  /** Whether to show the copy button. */
  readonly copyable = input<boolean>(true);

  /** Toggled to true for 1.5s after a successful clipboard write. */
  readonly justCopied = signal(false);

  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  /** Writes `code` to the clipboard and flashes the "copied" confirmation for 1.5s. */
  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.code());
    } catch (err) {
      console.error('code-block: clipboard write failed', err);
      return;
    }
    this.justCopied.set(true);
    if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => {
      this.justCopied.set(false);
      this.copiedTimer = null;
    }, 1500);
  }

  /** Clears any pending copied-confirmation timer to avoid touching a destroyed signal. */
  ngOnDestroy(): void {
    if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
  }
}
