import { A11yModule } from '@angular/cdk/a11y';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  TemplateRef,
  ViewContainerRef,
  computed,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { filter } from 'rxjs/operators';
import { IconComponent } from '../../shared/icon.component';

/**
 * Left overlay drawer that surfaces the active project's CLAUDE.md.
 *
 * Anchored to the left edge of the viewport via Angular CDK Overlay so the
 * memory button in the chat header opens its panel in the same place as the
 * conversations history drawer. The component itself renders no inline DOM —
 * its template is a single `<ng-template>` portalled by the overlay when the
 * `open` input flips to `true`.
 *
 * - Header: mono "memory" + neutral pill with section count + close ×.
 * - Body: when the source markdown contains the canonical section markers
 *   (## User / ## Project / ## Feedback / ## Reference) we render each as a
 *   mono kicker + dimmed text block — matching the mockup. Otherwise we render
 *   the raw source as preformatted plain text inside a <pre>. We deliberately
 *   do not run the markdown pipeline here: MEMORY.md often contains relative
 *   markdown links to per-memory files, and rendering them as <a> would let a
 *   click navigate the embedded webview off the SPA route (white screen).
 */
@Component({
  selector: 'app-memory-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [A11yModule, IconComponent],
  template: `
    <ng-template #content>
      <div
        class="flex h-full w-72 flex-col border-r border-[var(--line)] bg-[var(--bg-1)]"
        role="complementary"
        aria-label="Project memory"
        data-testid="memory-panel"
        cdkTrapFocus
      >
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
            <app-icon name="x" class="h-4 w-4" />
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
                  <div class="mt-1 whitespace-pre-wrap text-[var(--ink-dim)]">
                    {{ section.body }}
                  </div>
                </section>
              }
            </div>
          } @else if (markdown()) {
            <pre
              class="mono whitespace-pre-wrap break-words text-[11.5px] text-[var(--ink-dim)]"
              data-testid="memory-panel-fallback"
              >{{ fallbackText() }}</pre
            >
          } @else {
            <p class="mono text-[11.5px] text-[var(--ink-mute)]" data-testid="memory-panel-empty">
              no memory yet
            </p>
          }
        </div>
      </div>
    </ng-template>
  `,
})
export class MemoryPanelComponent {
  /** Whether the drawer is open. Drives the CDK overlay attach/detach. */
  readonly open = input<boolean>(false);
  /** Raw markdown source (CLAUDE.md). */
  readonly markdown = input<string>('');
  /** Optional error string — when set, replaces the body content. */
  readonly error = input<string>('');
  /** Drawer requested to close (close button, backdrop click, or Escape). */
  readonly closed = output<void>();

  /** Parsed sections (kicker + body) when markdown follows the canonical layout. */
  protected readonly sections = computed(() => parseSections(this.markdown()));
  /** Same link-stripping rule as parseSections, applied to the unstructured fallback. */
  protected readonly fallbackText = computed(() => stripPointerLinks(this.markdown()).trim());
  protected readonly sectionCount = computed(() => this.sections().length);
  protected readonly sectionLabel = computed(() => {
    const n = this.sectionCount();
    return n === 1 ? '1 entry' : `${n} entries`;
  });

  /** Template containing the drawer content — handed to the CDK overlay portal. */
  protected readonly content = viewChild.required<TemplateRef<unknown>>('content');

  private readonly overlay = inject(Overlay);
  private readonly viewContainerRef = inject(ViewContainerRef);
  private overlayRef: OverlayRef | null = null;

  /**
   * Sync the `open` input with the CDK overlay lifecycle. Opening builds a
   * left-anchored full-height panel with a dark backdrop and dispatches close
   * on backdrop click or Escape. Closing detaches the portal (no DOM remains).
   */
  constructor() {
    effect(() => {
      if (this.open()) this.openOverlay();
      else this.closeOverlay();
    });
    // Defensive: dispose the overlay if the host is torn down while open
    // (e.g., a route swap with the drawer left open).
    inject(DestroyRef).onDestroy(() => this.closeOverlay());
  }

  private openOverlay(): void {
    if (this.overlayRef !== null) return;
    const overlayRef = this.overlay.create({
      // Anchor past the 56px nav-rail so the drawer doesn't cover it.
      positionStrategy: this.overlay.position().global().left('56px').top('0'),
      height: '100%',
      hasBackdrop: true,
      backdropClass: 'cdk-overlay-dark-backdrop',
      panelClass: ['drawer-panel', 'memory-drawer-panel'],
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });
    overlayRef.attach(new TemplatePortal(this.content(), this.viewContainerRef));
    overlayRef.backdropClick().subscribe(() => this.closed.emit());
    overlayRef
      .keydownEvents()
      .pipe(filter((e) => e.key === 'Escape'))
      .subscribe((e) => {
        e.preventDefault();
        this.closed.emit();
      });
    this.overlayRef = overlayRef;
  }

  private closeOverlay(): void {
    if (this.overlayRef === null) return;
    this.overlayRef.dispose();
    this.overlayRef = null;
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
    // Drop the heading line; trim trailing whitespace; strip pointer-style
    // markdown links so entries like `- [name](file.md) — desc` collapse to
    // `- desc` (the file is a link to the per-memory file, not user content).
    const body = stripPointerLinks(block.replace(/^##\s+\S.*\r?\n?/, '')).trim();
    if (body) {
      sections.push({ id: matches[i].id, label: matches[i].label, body });
    }
  }
  return sections;
}

/**
 * Removes pointer-style markdown links from MEMORY.md lines.
 *
 * MEMORY.md entries follow the shape `- [title](file.md) — description`, where
 * the bracketed link is just a pointer to the per-memory file on disk (not
 * something the user types). The drawer is a read-only summary, so we collapse
 * each entry to its description: `- description`. Any leftover bare links are
 * replaced with their visible text. Lines without links pass through untouched.
 * @param text - Raw markdown source.
 */
export function stripPointerLinks(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const pointer = line.match(/^(\s*[-*]\s+)\[[^\]]+\]\([^)]+\)\s*[—–-]?\s*(.*)$/);
      if (pointer) {
        const [, bullet, rest] = pointer;
        return rest ? `${bullet}${rest}` : bullet.trimEnd();
      }
      return line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    })
    .join('\n');
}
