import { ChangeDetectionStrategy, Component, computed, effect, input, output } from '@angular/core';
import { TextBlockComponent } from '../blocks/text-block.component';

/**
 * Right overlay drawer that surfaces the active project's CLAUDE.md.
 *
 * Layout matches the terminal-minimal mockup (lines 302–319 + 944–970):
 * - Always present in the DOM as a `.memory-drawer` so the
 *   `transform: translateX(...)` transition runs in/out smoothly.
 * - The parent toggles `body.memory-open` via `UiStateService` — the global
 *   stylesheet animates the drawer in and dims the backdrop via
 *   `body.memory-open::before`.
 * - Header: mono "memory" + neutral pill with section count + close ×.
 * - Body: when the source markdown contains the canonical section markers
 *   (## User Preferences / ## Feedback / ## Project / ## Reference) we render
 *   each as a mono kicker + dimmed text block — matching the mockup. Otherwise
 *   we fall back to the existing markdown pipeline via `<app-text-block>` so
 *   no project memory is ever silently dropped.
 */
@Component({
  selector: 'app-memory-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TextBlockComponent],
  host: {
    role: 'complementary',
    'aria-label': 'Project memory',
    class:
      'memory-drawer w-72 flex-shrink-0 flex-col border-l border-[var(--line)] bg-[var(--bg-1)]',
    '[attr.data-testid]': '"memory-panel"',
    '[attr.aria-hidden]': '!open() ? "true" : null',
    '[attr.inert]': '!open() ? "" : null',
  },
  template: `
    <div class="flex h-11 items-center gap-2 border-b border-[var(--line)] px-3">
      <span class="mono text-[11px] text-[var(--ink-mute)]">memory</span>
      @if (sectionCount() > 0) {
        <span class="pill" data-testid="memory-panel-count">{{ sectionLabel() }}</span>
      }
      <button
        type="button"
        class="ml-auto text-[var(--ink-mute)] hover:text-[var(--ink)]"
        data-testid="memory-panel-close"
        aria-label="Close memory panel"
        (click)="closed.emit()"
      >
        <svg
          class="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          stroke-width="1.75"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <div
      class="flex-1 overflow-y-auto p-3 text-[13px] leading-relaxed text-[var(--ink)]"
      data-testid="memory-panel-body"
    >
      @if (error()) {
        <p
          class="mono rounded border border-red-500/40 bg-red-500/5 px-2 py-1.5 text-[11.5px] text-red-300"
          data-testid="memory-panel-error"
          role="alert"
        >
          {{ error() }}
        </p>
      } @else if (sections().length > 0) {
        <div class="mono space-y-3 text-[11.5px]">
          @for (section of sections(); track section.id) {
            <section [attr.data-testid]="'memory-section-' + section.id">
              <div class="text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
                {{ section.label }}
              </div>
              <div class="mt-1 whitespace-pre-wrap text-[var(--ink-dim)]">{{ section.body }}</div>
            </section>
          }
        </div>
      } @else if (markdown()) {
        <app-text-block [content]="markdown()" />
      } @else {
        <p class="mono text-[11.5px] text-[var(--ink-mute)]" data-testid="memory-panel-empty">
          no memory yet
        </p>
      }
    </div>
  `,
})
export class MemoryPanelComponent {
  /** Whether the drawer is open. Drives the body class + a11y attrs. */
  readonly open = input<boolean>(false);
  /** Raw markdown source (CLAUDE.md). */
  readonly markdown = input<string>('');
  /** Optional error string — when set, replaces the body content. */
  readonly error = input<string>('');
  /** Drawer requested to close (close button or backdrop). */
  readonly closed = output<void>();

  /** Parsed sections (kicker + body) when markdown follows the canonical layout. */
  protected readonly sections = computed(() => parseSections(this.markdown()));
  protected readonly sectionCount = computed(() => this.sections().length);
  protected readonly sectionLabel = computed(() => {
    const n = this.sectionCount();
    return n === 1 ? '1 entry' : `${n} entries`;
  });

  /**
   * Mirrors the `open` input onto a body class so the panel can animate in.
   */
  constructor() {
    effect(() => {
      const open = this.open();
      const cls = 'memory-open';
      if (open) document.body.classList.add(cls);
      else document.body.classList.remove(cls);
    });
  }
}

/** Section marker config: matches `## <Heading>` lines from CLAUDE.md. */
const SECTION_MARKERS: readonly { id: string; label: string; pattern: RegExp }[] = [
  { id: 'user', label: 'user', pattern: /^##\s+user\b/im },
  { id: 'project', label: 'project', pattern: /^##\s+project\b/im },
  { id: 'feedback', label: 'feedback', pattern: /^##\s+feedback\b/im },
  { id: 'reference', label: 'reference', pattern: /^##\s+reference\b/im },
];

/**
 * Splits a CLAUDE.md-style memory document into mockup-shaped sections.
 *
 * Returns an empty array when none of the canonical headers are present so the
 * caller can fall back to the standard markdown renderer.
 * @param markdown - Raw markdown source.
 */
export function parseSections(
  markdown: string
): readonly { id: string; label: string; body: string }[] {
  if (!markdown) return [];
  const matches = SECTION_MARKERS.flatMap((m) => {
    const match = m.pattern.exec(markdown);
    return match ? [{ id: m.id, label: m.label, start: match.index }] : [];
  }).sort((a, b) => a.start - b.start);
  if (matches.length === 0) return [];

  const sections: { id: string; label: string; body: string }[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].start;
    const end = i + 1 < matches.length ? matches[i + 1].start : markdown.length;
    const block = markdown.slice(start, end);
    // Drop the heading line; trim trailing whitespace.
    const body = block.replace(/^##\s+\S.*\r?\n?/, '').trim();
    if (body) {
      sections.push({ id: matches[i].id, label: matches[i].label, body });
    }
  }
  return sections;
}
