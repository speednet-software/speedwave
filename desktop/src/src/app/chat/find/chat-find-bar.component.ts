import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  input,
  output,
} from '@angular/core';
import { IconComponent } from '../../shared/icon.component';

/** The find bar: query field, regex and match-case toggles, the counter, previous/next and close. */
@Component({
  selector: 'app-chat-find-bar',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div
      data-testid="chat-find-bar"
      role="search"
      aria-label="Find in chat"
      class="mono flex items-center gap-1 rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)] shadow-lg"
      (keydown)="onKeydown($event)"
    >
      <input
        #queryInput
        data-testid="chat-find-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="Find"
        aria-label="Find text"
        [attr.aria-invalid]="invalid() ? 'true' : null"
        class="w-44 bg-transparent px-1 py-0.5 outline-none placeholder:text-[var(--ink-mute)] rounded ring-1"
        [class.ring-transparent]="!invalid()"
        [class.ring-[var(--red)]]="invalid()"
        [value]="query()"
        (input)="queryChange.emit(queryInput.value)"
      />
      <button
        type="button"
        data-testid="chat-find-regex"
        class="rounded px-1.5 py-0.5 hover:bg-[var(--bg-1)]"
        [class.text-[var(--accent)]]="regex()"
        [class.text-[var(--ink-dim)]]="!regex()"
        [attr.aria-pressed]="regex()"
        aria-label="Use regular expression"
        title="Regular expression"
        (click)="regexToggled.emit()"
      >
        .*
      </button>
      <button
        type="button"
        data-testid="chat-find-case"
        class="rounded px-1.5 py-0.5 hover:bg-[var(--bg-1)]"
        [class.text-[var(--accent)]]="matchCase()"
        [class.text-[var(--ink-dim)]]="!matchCase()"
        [attr.aria-pressed]="matchCase()"
        aria-label="Match case"
        title="Match case"
        (click)="caseToggled.emit()"
      >
        Aa
      </button>
      <span
        data-testid="chat-find-count"
        class="min-w-[3.5rem] px-1 text-center tabular-nums text-[var(--ink-dim)]"
        aria-live="polite"
        [class.text-[var(--red)]]="invalid() || (query() && total() === 0)"
        >{{ countLabel() }}</span
      >
      <button
        type="button"
        data-testid="chat-find-prev"
        class="flex items-center rounded p-0.5 hover:bg-[var(--bg-1)] disabled:opacity-40"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        [disabled]="total() === 0"
        (click)="previous.emit()"
      >
        <app-icon name="chevron-down" [strokeWidth]="2" class="h-3.5 w-3.5 rotate-180" />
      </button>
      <button
        type="button"
        data-testid="chat-find-next"
        class="flex items-center rounded p-0.5 hover:bg-[var(--bg-1)] disabled:opacity-40"
        aria-label="Next match"
        title="Next match (Enter)"
        [disabled]="total() === 0"
        (click)="next.emit()"
      >
        <app-icon name="chevron-down" [strokeWidth]="2" class="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        data-testid="chat-find-close"
        class="flex items-center rounded p-0.5 hover:bg-[var(--bg-1)]"
        aria-label="Close find"
        title="Close (Escape)"
        (click)="closed.emit()"
      >
        <app-icon name="x" [strokeWidth]="2" class="h-3.5 w-3.5" />
      </button>
    </div>
  `,
})
export class ChatFindBarComponent {
  readonly query = input('');
  readonly regex = input(false);
  readonly matchCase = input(false);
  /** Whether the regex query failed to compile. */
  readonly invalid = input(false);
  /** Zero-based index of the current match; meaningful only while `total` is above zero. */
  readonly current = input(0);
  readonly total = input(0);

  readonly queryChange = output<string>();
  readonly regexToggled = output<void>();
  readonly caseToggled = output<void>();
  readonly next = output<void>();
  readonly previous = output<void>();
  readonly closed = output<void>();

  @ViewChild('queryInput') private queryInput?: ElementRef<HTMLInputElement>;

  /** Puts the caret in the field and selects the query, so typing replaces it. */
  focusInput(): void {
    const el = this.queryInput?.nativeElement;
    if (!el) return;
    el.focus();
    el.select();
  }

  /** `n/total`, `0/0` for a query without matches, and nothing for an empty query. */
  countLabel(): string {
    if (this.query().length === 0) return '';
    if (this.invalid() || this.total() === 0) return '0/0';
    return `${this.current() + 1}/${this.total()}`;
  }

  /**
   * Enter and Shift+Enter step through the matches; Escape closes. Each is stopped here so the
   * chat's document-level Escape (which stops a streaming turn) and the shell's shortcuts never see it.
   * @param event - The keydown inside the bar.
   */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) this.previous.emit();
      else this.next.emit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closed.emit();
    }
  }
}
