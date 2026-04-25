import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { RouterLink } from '@angular/router';

/** One view entry exposed to the switcher. */
export interface ViewSwitcherEntry {
  id: string;
  label: string;
  route: string;
}

/**
 * Terminal-style segmented navigation for top-level views.
 *
 * Each tab is a mono-labelled link; the active tab receives the accent colour
 * and is prefixed with a 2px CSS pseudo-element bar so the accent doesn't leak
 * into the anchor's textContent (spec tests assert against trimmed labels).
 *
 * Exposes `role="tablist"` semantics with per-tab `aria-selected` so
 * screen-readers announce the mutually-exclusive selection. Clicking a tab
 * emits `selected` AND navigates via `[routerLink]` — consumers listen to
 * `selected` for side effects.
 *
 * Uses `@Input`/`@Output` decorators to match the project's Vitest runner,
 * which does not apply Angular's AOT compiler pass.
 */
@Component({
  selector: 'app-view-switcher',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .view-switcher-tab::before {
        content: '';
        display: inline-block;
        width: 2px;
        height: 14px;
        margin-right: 6px;
        background: transparent;
        vertical-align: middle;
      }
      .view-switcher-tab[aria-selected='true']::before {
        background: var(--accent);
      }
    `,
  ],
  template: `
    <div
      class="flex items-center gap-4"
      role="tablist"
      aria-label="Views"
      data-testid="view-switcher"
    >
      @for (view of views; track view.id) {
        <a
          role="tab"
          class="view-switcher-tab font-mono text-[13px] no-underline inline-flex items-center transition-colors duration-200 px-2 py-1 rounded"
          [routerLink]="view.route"
          [attr.aria-selected]="view.id === activeId ? 'true' : 'false'"
          [attr.data-testid]="'nav-' + view.id"
          [class.text-accent]="view.id === activeId"
          [class.font-bold]="view.id === activeId"
          [class.text-ink-mute]="view.id !== activeId"
          [class.hover:text-ink]="view.id !== activeId"
          (click)="selected.emit(view.id)"
          >{{ view.label }}</a
        >
      }
    </div>
  `,
})
export class ViewSwitcherComponent {
  @Input({ required: true }) views!: readonly ViewSwitcherEntry[];
  @Input({ required: true }) activeId!: string;
  @Output() readonly selected = new EventEmitter<string>();
}
