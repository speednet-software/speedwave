import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent, type IconName } from '../../shared/icon.component';

/** One entry in the left navigation rail. */
export interface NavRailEntry {
  /** Stable id used by tests + active-state matching. */
  id: string;
  /** Tooltip label. */
  label: string;
  /** Router URL — clicking the button navigates here via `[routerLink]`. */
  route: string;
  /** Icon catalog name rendered via `<app-icon>`. */
  iconName: IconName;
  /** Hint shown next to the label, e.g. `⌘1`. */
  shortcut?: string;
}

/**
 * Vertical icon rail that lives on the left edge of the shell.
 *
 * Replaces the legacy top-bar segmented switcher. Each entry renders as a
 * 36×36 button with an inline SVG icon and a tooltip on hover; the active
 * entry gets a 2px accent bar drawn via `.rail-btn.active::before`.
 *
 * Active state is derived from the current router URL by the parent shell.
 */
@Component({
  selector: 'app-nav-rail',
  imports: [RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'navigation',
    'aria-label': 'Primary',
    class: 'flex w-14 flex-col items-center border-r border-[var(--line)] bg-[var(--bg-1)]',
  },
  template: `
    <!-- Logo band aligned with chat header (44px). -->
    <div class="flex h-11 w-14 items-center justify-center border-b border-[var(--line)]">
      <img
        src="assets/speedwave-mark-white@2x.png"
        alt="Speedwave"
        width="28"
        height="28"
        class="h-7 w-7"
      />
    </div>

    <nav class="mt-4 flex flex-col gap-1" data-testid="nav-rail">
      @for (entry of entries(); track entry.id) {
        <a
          [routerLink]="entry.route"
          [attr.data-testid]="'nav-' + entry.id"
          [attr.aria-current]="entry.id === activeId() ? 'page' : null"
          [attr.aria-label]="entry.label"
          [attr.title]="entry.label"
          [class.active]="entry.id === activeId()"
          class="rail-btn"
        >
          <app-icon [name]="entry.iconName" class="h-[18px] w-[18px]" />
        </a>
      }
    </nav>

    <!-- Bottom: command palette trigger (⌘K). -->
    <div class="mt-auto flex flex-col gap-1 pb-3">
      <button
        type="button"
        class="rail-btn"
        data-testid="nav-rail-palette"
        (click)="paletteOpened.emit()"
        title="Command palette (⌘K)"
        aria-label="Open command palette"
      >
        <app-icon name="menu" class="h-[18px] w-[18px]" />
      </button>
    </div>
  `,
})
export class NavRailComponent {
  /** Entries to render top-down. */
  readonly entries = input.required<readonly NavRailEntry[]>();
  /** Active entry id; derived in the parent (shell) from the router URL. */
  readonly activeId = input.required<string>();
  /** Emitted when the bottom palette button is clicked. */
  readonly paletteOpened = output<void>();
}
