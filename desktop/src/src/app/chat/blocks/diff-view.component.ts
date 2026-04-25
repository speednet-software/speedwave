import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnChanges,
  signal,
  type SimpleChanges,
} from '@angular/core';

/** A single line in the rendered diff, tagged by semantic role. */
export interface DiffLine {
  kind: 'add' | 'remove' | 'ctx';
  text: string;
}

/** A row emitted to the template — either a diff line or the truncation marker. */
type DiffSegment = { type: 'line'; line: DiffLine } | { type: 'omitted'; count: number };

/**
 * Computes a simple LCS-based line diff between two strings.
 *
 * The algorithm: split both inputs by newline, compute the longest common
 * subsequence of lines via dynamic programming, then walk both sides to
 * emit `add` / `remove` / `ctx` rows in order. This matches the mockup's
 * unified-diff presentation while keeping memory bounded to O(m*n) for
 * reasonable file sizes.
 * @param oldStr - Original text content (lines separated by "\n").
 * @param newStr - Replacement text content (lines separated by "\n").
 */
export function computeLineDiff(oldStr: string, newStr: string): DiffLine[] {
  // Strip trailing \r so CRLF-terminated lines don't show as diff changes
  // when compared with LF-only lines.
  const oldLines = oldStr === '' ? [] : oldStr.split('\n').map((l) => l.replace(/\r$/, ''));
  const newLines = newStr === '' ? [] : newStr.split('\n').map((l) => l.replace(/\r$/, ''));
  const m = oldLines.length;
  const n = newLines.length;

  // dp[i][j] = LCS length of oldLines[0..i] and newLines[0..j].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Walk backward through dp, emitting rows into a reversed list.
  const rev: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      rev.push({ kind: 'ctx', text: oldLines[i - 1] });
      i--;
      j--;
    } else if (dp[i][j - 1] >= dp[i - 1][j]) {
      // Prefer additions in the backward walk. When reversed, this places
      // removals immediately before the matching additions (unified-diff
      // convention: deletions appear before insertions at each hunk).
      rev.push({ kind: 'add', text: newLines[j - 1] });
      j--;
    } else {
      rev.push({ kind: 'remove', text: oldLines[i - 1] });
      i--;
    }
  }
  while (i > 0) {
    rev.push({ kind: 'remove', text: oldLines[i - 1] });
    i--;
  }
  while (j > 0) {
    rev.push({ kind: 'add', text: newLines[j - 1] });
    j--;
  }
  return rev.reverse();
}

/**
 * Per-line unified diff renderer used by tool-block for Edit/Write tools.
 *
 * The container (`overflow-hidden rounded ring-1 ring-line bg-bg-1`) clips the
 * per-line background tints to rounded corners. Each line is a `<div>` with
 * `whitespace-pre` applied individually — never on the wrapper — to avoid
 * blank-line artifacts between the row divs (see implementation-prompt.md).
 * Diffs longer than `truncateLines` collapse to a head/tail view with an
 * `expand full diff` button.
 */
@Component({
  selector: 'app-diff-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div
      data-testid="diff-container"
      class="mono overflow-x-auto overflow-hidden rounded ring-1 ring-line bg-bg-1 py-1.5 text-[11.5px] leading-[1.5]"
    >
      @for (seg of segments; track $index) {
        @switch (segKind(seg)) {
          @case ('add') {
            <div
              data-testid="diff-add"
              class="whitespace-pre bg-green-500/[0.15] text-green-300 px-3"
            >
              + {{ asLine(seg).text }}
            </div>
          }
          @case ('remove') {
            <div
              data-testid="diff-remove"
              class="whitespace-pre bg-red-500/[0.15] text-red-300 px-3"
            >
              - {{ asLine(seg).text }}
            </div>
          }
          @case ('ctx') {
            <div data-testid="diff-ctx" class="whitespace-pre text-ink-dim px-3">
              {{ asLine(seg).text }}
            </div>
          }
          @case ('omitted') {
            <div
              data-testid="diff-omitted"
              class="whitespace-pre bg-bg-2 text-ink-mute px-3 py-1 text-center"
            >
              &middot;&middot;&middot; {{ asOmitted(seg).count }} lines omitted
              &middot;&middot;&middot;
            </div>
          }
        }
      }
    </div>
    @if (isTruncated) {
      <button
        type="button"
        data-testid="diff-expand"
        class="mono mt-1 text-[11px] text-accent hover:underline"
        (click)="expand()"
      >
        expand full diff &rarr;
      </button>
    }
  `,
})
export class DiffViewComponent implements OnChanges {
  @Input() oldString = '';
  @Input() newString = '';
  @Input() truncateLines = 20;

  /** Toggle set by the "expand full diff" button. */
  private readonly expanded = signal<boolean>(false);

  /**
   * Reset the user's expand-toggle when either input string changes — otherwise
   * an instance reused for a different file (live tool block streaming an
   * edit, recycled for a later edit) keeps the previous expand state.
   */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['oldString'] || changes['newString']) {
      this.expanded.set(false);
    }
  }

  /** Memoized diff — recomputes only when either input string reference changes. */
  private memoOld: string | null = null;
  private memoNew: string | null = null;
  private memoLines: DiffLine[] = [];

  /** Returns all diff lines for the current inputs (memoized by input identity). */
  get allLines(): DiffLine[] {
    if (this.memoOld !== this.oldString || this.memoNew !== this.newString) {
      this.memoOld = this.oldString;
      this.memoNew = this.newString;
      this.memoLines = computeLineDiff(this.oldString, this.newString);
    }
    return this.memoLines;
  }

  /** True when the diff exceeds `truncateLines` AND the user has not expanded. */
  get isTruncated(): boolean {
    return !this.expanded() && this.allLines.length > this.truncateLines;
  }

  /** Row list emitted to the template: head lines + optional omitted marker + tail lines. */
  get segments(): DiffSegment[] {
    const lines = this.allLines;
    if (!this.isTruncated) {
      return lines.map((line) => ({ type: 'line', line }));
    }
    // For odd truncateLines, give the extra line to head so the visible total
    // matches the advertised count (e.g. 21 → head 11 + tail 10 = 21).
    const headCount = Math.ceil(this.truncateLines / 2);
    const tailCount = Math.floor(this.truncateLines / 2);
    const head = lines.slice(0, headCount);
    const tail = lines.slice(lines.length - tailCount);
    const omitted = lines.length - headCount - tailCount;
    return [
      ...head.map<DiffSegment>((line) => ({ type: 'line', line })),
      { type: 'omitted', count: omitted },
      ...tail.map<DiffSegment>((line) => ({ type: 'line', line })),
    ];
  }

  /**
   * Returns the template-switch key for a segment: diff-line kind or 'omitted'.
   * @param seg - Segment to inspect.
   */
  segKind(seg: DiffSegment): DiffLine['kind'] | 'omitted' {
    return seg.type === 'line' ? seg.line.kind : 'omitted';
  }

  /**
   * Narrows a `DiffSegment` to its `line` payload (template-only cast helper).
   * @param seg - Segment guaranteed to be of type 'line' by the surrounding switch.
   */
  asLine(seg: DiffSegment): DiffLine {
    return (seg as Extract<DiffSegment, { type: 'line' }>).line;
  }

  /**
   * Narrows a `DiffSegment` to its `count` payload (template-only cast helper).
   * @param seg - Segment guaranteed to be of type 'omitted' by the surrounding switch.
   */
  asOmitted(seg: DiffSegment): Extract<DiffSegment, { type: 'omitted' }> {
    return seg as Extract<DiffSegment, { type: 'omitted' }>;
  }

  /** Reveals the full diff, removing the head/tail truncation. */
  expand(): void {
    this.expanded.set(true);
  }
}
