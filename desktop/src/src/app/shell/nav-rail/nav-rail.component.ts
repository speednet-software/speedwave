import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent, type IconName } from '../../shared/icon.component';
import { LogoComponent } from '../../shared/logo.component';

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
  /** Renders a pulsing red dot on the entry; set while its feature is capturing. */
  recording?: boolean;
}

/** Vertical icon rail with 36×36 icon buttons; active entry gets a 2px accent bar. */
@Component({
  selector: 'app-nav-rail',
  imports: [RouterLink, IconComponent, LogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'navigation',
    'aria-label': 'Primary',
    class: 'flex w-14 flex-col items-center border-r border-[var(--line)] bg-[var(--bg-1)]',
  },
  template: `
    <!-- Logo band (44px, header-aligned): inline SVG adapts via currentColor. -->
    <div class="flex h-11 w-14 items-center justify-center border-b border-[var(--line)]">
      <app-logo class="h-7 w-7" />
    </div>

    <nav class="mt-4 flex flex-col gap-1" data-testid="nav-rail">
      @for (entry of entries(); track entry.id) {
        <a
          [routerLink]="entry.route"
          [attr.data-testid]="'nav-' + entry.id"
          [attr.aria-current]="entry.id === activeId() ? 'page' : null"
          [attr.aria-label]="entryLabel(entry)"
          [attr.title]="entryLabel(entry)"
          [class.active]="entry.id === activeId()"
          class="rail-btn"
        >
          <app-icon [name]="entry.iconName" class="h-[18px] w-[18px]" />
          @if (entry.recording) {
            <span
              class="pointer-events-none absolute right-1 top-1 h-2 w-2 animate-record-pulse rounded-full bg-[var(--red)] ring-2 ring-[var(--bg-1)] motion-reduce:animate-none"
              [attr.data-testid]="'nav-recording-dot-' + entry.id"
              aria-hidden="true"
            ></span>
          }
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

  /**
   * Tooltip and accessible name for an entry; carries the recording state, which the dot
   * itself cannot because it is `aria-hidden`.
   * @param entry - the entry being rendered.
   * @returns the entry label, suffixed while that entry is recording.
   */
  entryLabel(entry: NavRailEntry): string {
    return entry.recording ? `${entry.label} (recording)` : entry.label;
  }
}
