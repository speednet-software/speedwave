import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { OverlayPositionBuilder } from '@angular/cdk/overlay';
import { A11yModule } from '@angular/cdk/a11y';
import { CdkListbox, CdkOption, type ListboxValueChangeEvent } from '@angular/cdk/listbox';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  TemplateRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { ThemeService } from '../../services/theme.service';
import { UiStateService } from '../../services/ui-state.service';
import type { ProjectEntry, ProjectList } from '../../models/update';

/** Section heading rendered above a contiguous run of items. */
type ItemSection = 'navigate' | 'actions' | 'projects';

/** Glyph color buckets available for the leading character on each row. */
type GlyphColor = 'accent' | 'teal' | 'violet' | 'amber' | 'green' | 'red' | 'dim';

/** One entry in the command palette list. */
interface PaletteItem {
  /** Stable id used by tests + highlight tracking. */
  readonly id: string;
  /** Section the item belongs to (drives the group header). */
  readonly section: ItemSection;
  /** Single-character glyph rendered to the left of the label. */
  readonly glyph: string;
  /** Color family for the leading glyph. */
  readonly glyphColor: GlyphColor;
  /** Display label shown in mono. */
  readonly label: string;
  /** Optional keyboard shortcut hint (right-aligned mono kbd). */
  readonly shortcut?: string;
  /** Action invoked when the item is selected. */
  readonly action: () => void | Promise<void>;
}

/** Decorated palette item with its section header and group flag. */
interface DecoratedItem extends PaletteItem {
  /** Whether this item is the first one in its section (drives header rendering). */
  readonly isFirstInSection: boolean;
  /** Index into the flat filtered list — used by arrow-key highlight. */
  readonly index: number;
}

/**
 * Command palette modal — ⌘K.
 *
 * Visibility is wired to {@link UiStateService.paletteOpen} via an effect
 * that opens/closes a CDK Dialog instance. CDK Dialog gives us focus trap,
 * backdrop, scroll lock, and Escape handling for free. The list itself is a
 * `cdkListbox` with `cdkListboxUseActiveDescendant`, so arrow keys, Home/End,
 * and Enter are handled natively without manual `(document:keydown.*)`
 * bindings — we mirror the slash-menu pattern by forwarding the same keys
 * from the search input (which retains focus) into the active-descendant
 * signal.
 */
@Component({
  selector: 'app-command-palette',
  imports: [A11yModule, CdkListbox, CdkOption],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #content>
      <div
        class="w-[min(600px,90vw)] rounded-lg border border-[var(--line-strong)] bg-[var(--bg-1)] shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
        data-testid="command-palette"
        tabindex="-1"
        (keydown.escape)="onEscape($event)"
      >
        <div class="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3">
          <span class="mono text-[12px] text-[var(--accent)]" aria-hidden="true">&gt;</span>
          <input
            type="text"
            cdkFocusInitial
            autocomplete="off"
            class="mono w-full bg-transparent text-[14px] text-[var(--ink)] placeholder-[var(--ink-mute)] focus:outline-none"
            placeholder="type a command or search..."
            aria-label="Search commands"
            data-testid="palette-input"
            [value]="query()"
            (input)="onQueryInput($event)"
            (keydown)="onSearchKeydown($event)"
          />
          <span class="kbd">esc</span>
        </div>

        <div class="max-h-80 overflow-y-auto py-1" data-testid="palette-list">
          @if (decoratedItems().length === 0) {
            <div
              class="mono px-4 py-3 text-[12px] text-[var(--ink-mute)]"
              data-testid="palette-empty"
            >
              no results
            </div>
          } @else {
            <ul
              cdkListbox
              cdkListboxUseActiveDescendant
              aria-label="Commands"
              class="m-0 list-none p-0"
              (cdkListboxValueChange)="onListboxChange($event)"
            >
              @for (item of decoratedItems(); track item.id) {
                @if (item.isFirstInSection) {
                  <li
                    class="mono px-4 py-1 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                    [class.mt-2]="item.section !== 'navigate'"
                    [attr.data-testid]="'palette-section-' + item.section"
                    aria-hidden="true"
                  >
                    {{ item.section }}
                  </li>
                }
                <li
                  [cdkOption]="item"
                  [id]="optionId(item.index)"
                  [class.is-active]="item.index === activeIndex()"
                  class="flex w-full items-center gap-3 px-4 py-1.5 text-left cursor-pointer hover-bg [&.is-active]:bg-[var(--bg-2)]"
                  [attr.data-testid]="'palette-item-' + item.id"
                  (mouseenter)="activeIndex.set(item.index)"
                >
                  <span [class]="glyphClass(item.glyphColor)">{{ item.glyph }}</span>
                  <span class="mono text-[12px] text-[var(--ink)]">{{ item.label }}</span>
                  @if (item.shortcut) {
                    <span class="mono ml-auto text-[10px] text-[var(--ink-mute)]">{{
                      item.shortcut
                    }}</span>
                  }
                </li>
              }
            </ul>
          }
        </div>

        <div
          class="mono flex items-center gap-4 border-t border-[var(--line)] px-4 py-2 text-[10px] text-[var(--ink-mute)]"
        >
          <span><span class="kbd">↑↓</span> navigate</span>
          <span><span class="kbd">↵</span> select</span>
          <span><span class="kbd">⌘K</span> close</span>
        </div>
      </div>
    </ng-template>
  `,
})
export class CommandPaletteComponent implements OnInit, OnDestroy {
  /** UI state service — exposes `paletteOpen()` for the visibility binding. */
  readonly ui = inject(UiStateService);

  /** Current search query. */
  readonly query = signal<string>('');

  /**
   * Index of the highlighted item in `filteredItems()`. Driven by the search
   * input via {@link onSearchKeydown} — the input keeps focus, so the
   * `cdkListbox` keyboard manager never owns the keystrokes itself; we mirror
   * the active-descendant pattern with this signal instead.
   */
  readonly activeIndex = signal<number>(0);

  /** Live list of projects fetched on init and refreshed on settled events. */
  private readonly projects = signal<readonly ProjectEntry[]>([]);
  /** Slug of the currently active project — drives the projects section. */
  private readonly activeProject = signal<string | null>(null);

  /** Template containing the palette card — handed to CDK Dialog. */
  protected readonly content = viewChild.required<TemplateRef<unknown>>('content');

  private readonly router = inject(Router);
  private readonly tauri = inject(TauriService);
  private readonly projectState = inject(ProjectStateService);
  private readonly theme = inject(ThemeService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly dialog = inject(Dialog);
  private readonly positionBuilder = inject(OverlayPositionBuilder);

  private dialogRef: DialogRef<unknown, unknown> | null = null;
  /**
       True while we are programmatically closing the dialog (signal flipped to
      false). Prevents the `closed` subscription from re-calling
      `closePalette()` and looping.
   */
  private closingProgrammatically = false;

  private unsubProjectSettled: (() => void) | null = null;

  /** Static catalog of navigate + actions items — projects are appended dynamically. */
  private readonly staticItems = computed<readonly PaletteItem[]>(() => {
    const navigate: readonly PaletteItem[] = [
      this.navItem('chat', 'go to chat', '⌘1', 'accent', '/chat'),
      this.navItem('integrations', 'go to integrations', '⌘2', 'teal', '/integrations'),
      this.navItem('plugins', 'go to plugins', '⌘3', 'violet', '/plugins'),
      this.navItem('settings', 'go to settings', '⌘,', 'amber', '/settings'),
      this.navItem('logs', 'go to logs & health', '⌘L', 'green', '/logs'),
    ];
    const actions: readonly PaletteItem[] = [
      {
        id: 'action-new-conversation',
        section: 'actions',
        glyph: '+',
        glyphColor: 'accent',
        label: 'new conversation',
        shortcut: '⌘N',
        action: () => {
          this.router.navigateByUrl('/chat');
          this.ui.closePalette();
        },
      },
      {
        id: 'action-install-plugin',
        section: 'actions',
        glyph: '+',
        glyphColor: 'accent',
        label: 'install plugin...',
        action: () => {
          this.router.navigateByUrl('/plugins');
          this.ui.closePalette();
        },
      },
      {
        id: 'action-restart-containers',
        section: 'actions',
        glyph: '↻',
        glyphColor: 'amber',
        label: 'restart containers',
        action: () => {
          this.projectState.requestRestart();
          this.ui.closePalette();
        },
      },
      {
        id: 'action-check-updates',
        section: 'actions',
        glyph: '↑',
        glyphColor: 'green',
        label: 'check for updates',
        action: () => {
          this.invokeCheckForUpdate();
          this.ui.closePalette();
        },
      },
      {
        id: 'action-toggle-sidebar',
        section: 'actions',
        glyph: '⇤',
        glyphColor: 'dim',
        label: 'toggle sidebar',
        shortcut: '⌘B',
        action: () => {
          this.ui.toggleSidebar();
          this.ui.closePalette();
        },
      },
      {
        id: 'action-change-accent',
        section: 'actions',
        glyph: '◐',
        glyphColor: 'dim',
        label: 'change accent color...',
        shortcut: '⌘T',
        action: () => {
          this.theme.cycle();
        },
      },
    ];
    return [...navigate, ...actions];
  });

  /** Static + dynamic project items, filtered by the query. */
  readonly filteredItems = computed<readonly PaletteItem[]>(() => {
    const projects = this.projects();
    const active = this.activeProject();
    const projectItems: readonly PaletteItem[] = projects
      .filter((p) => p.name !== active)
      .map<PaletteItem>((project) => ({
        id: `project-${project.name}`,
        section: 'projects',
        glyph: '◇',
        glyphColor: 'violet',
        label: `switch to ${project.name}`,
        action: () => {
          void this.projectState.switchProject(project.name);
          this.ui.closePalette();
        },
      }));

    const all: readonly PaletteItem[] = [...this.staticItems(), ...projectItems];
    const needle = this.query().trim().toLowerCase();
    if (needle === '') return all;
    return all.filter((item) => item.label.toLowerCase().includes(needle));
  });

  /** Filtered items decorated with their flat index + section-header flag. */
  readonly decoratedItems = computed<readonly DecoratedItem[]>(() => {
    const items = this.filteredItems();
    let lastSection: ItemSection | null = null;
    return items.map((item, index) => {
      const isFirstInSection = item.section !== lastSection;
      lastSection = item.section;
      return { ...item, isFirstInSection, index };
    });
  });

  /**
   * Wires three effects:
   *  1. open/close the CDK Dialog in response to `paletteOpen()` flipping;
   *  2. reset the query and active index on each fresh open;
   *  3. clamp the active index when the filtered list shrinks.
   */
  constructor() {
    effect(() => {
      if (this.ui.paletteOpen()) {
        this.openDialog();
        this.query.set('');
        this.activeIndex.set(0);
      } else {
        this.closeDialog();
      }
    });
    effect(() => {
      const len = this.filteredItems().length;
      if (len === 0) {
        this.activeIndex.set(0);
        return;
      }
      const current = this.activeIndex();
      if (current >= len) {
        this.activeIndex.set(len - 1);
      }
    });
  }

  /** Loads the project list once and subscribes to settled events for refresh. */
  async ngOnInit(): Promise<void> {
    await this.refreshProjects();
    this.unsubProjectSettled = this.projectState.onProjectSettled(() => {
      void this.refreshProjects();
    });
  }

  /** Releases the project-settled subscription and any open dialog ref. */
  ngOnDestroy(): void {
    if (this.unsubProjectSettled) {
      this.unsubProjectSettled();
      this.unsubProjectSettled = null;
    }
    this.closeDialog();
  }

  /**
   * Updates the search query from the input event and resets the active
   * index to the first matching item.
   * @param event - Native `input` event from the search field.
   */
  onQueryInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.query.set(target.value);
    this.activeIndex.set(0);
  }

  /**
   * Forwards arrow / Home / End / Enter keystrokes from the search input
   * down to the active-descendant signal so the user can navigate the list
   * while keeping focus on the input.
   * @param event - Keydown from the search input.
   */
  onSearchKeydown(event: KeyboardEvent): void {
    const list = this.filteredItems();
    if (list.length === 0) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.activeIndex.update((i) => (i + 1) % list.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.activeIndex.update((i) => (i - 1 + list.length) % list.length);
        break;
      case 'Home':
        event.preventDefault();
        this.activeIndex.set(0);
        break;
      case 'End':
        event.preventDefault();
        this.activeIndex.set(list.length - 1);
        break;
      case 'Enter': {
        event.preventDefault();
        const idx = Math.min(this.activeIndex(), list.length - 1);
        const picked = list[idx];
        if (picked) void this.invoke(picked);
        break;
      }
    }
  }

  /**
   * Escape closes the palette. CDK Dialog already handles Escape by default,
   * but we keep this explicit handler so the signal flips first — preventing
   * a brief render of an "empty" dialog before the effect catches up.
   * @param event - Keyboard event for the Escape press.
   */
  onEscape(event: Event): void {
    event.preventDefault();
    this.ui.closePalette();
  }

  /**
   * CdkListbox value-change handler. Single-select listbox, so `event.value`
   * is a 0- or 1-length array; treat any non-empty value as "user picked
   * this item".
   * @param event - CdkListbox change event.
   */
  onListboxChange(event: ListboxValueChangeEvent<unknown>): void {
    const picked = event.value[0] as PaletteItem | undefined;
    if (picked) void this.invoke(picked);
  }

  /**
   * Invokes a palette item — separate method so click + Enter share a path.
   * @param item - The item whose action callback should run.
   */
  async invoke(item: PaletteItem): Promise<void> {
    await item.action();
    this.cdr.markForCheck();
  }

  /**
   * Returns the Tailwind class string for a glyph color bucket.
   * @param color - The semantic color family for the leading glyph.
   */
  glyphClass(color: GlyphColor): string {
    switch (color) {
      case 'teal':
        return 'text-[var(--teal)]';
      case 'violet':
        return 'text-[var(--violet)]';
      case 'amber':
        return 'text-[var(--amber)]';
      case 'green':
        return 'text-[var(--green)]';
      case 'red':
        return 'text-red-400';
      case 'dim':
        return 'text-[var(--ink-dim)]';
      default:
        return 'text-[var(--accent)]';
    }
  }

  /**
   * DOM id for the option at `index`, used by `aria-activedescendant`.
   * @param index - Zero-based index into `filteredItems()`.
   */
  optionId(index: number): string {
    return `palette-option-${index}`;
  }

  private openDialog(): void {
    if (this.dialogRef !== null) return;
    const positionStrategy = this.positionBuilder.global().centerHorizontally().top('12vh');
    this.dialogRef = this.dialog.open(this.content(), {
      hasBackdrop: true,
      disableClose: false,
      ariaLabel: 'Command palette',
      panelClass: 'cmd-palette-panel',
      backdropClass: ['cdk-overlay-dark-backdrop', 'cmd-palette-backdrop'],
      positionStrategy,
    });
    this.dialogRef.closed.subscribe(() => {
      this.dialogRef = null;
      // CDK Dialog closed via Escape, backdrop click, or programmatic close.
      // If we did not initiate it, sync the signal back so the next ⌘K reopens.
      if (!this.closingProgrammatically && this.ui.paletteOpen()) {
        this.ui.closePalette();
      }
      this.closingProgrammatically = false;
    });
  }

  private closeDialog(): void {
    if (this.dialogRef === null) return;
    this.closingProgrammatically = true;
    this.dialogRef.close();
  }

  private async refreshProjects(): Promise<void> {
    try {
      const result = await this.tauri.invoke<ProjectList>('list_projects');
      this.projects.set(result.projects);
      this.activeProject.set(result.active_project);
    } catch {
      // Outside Tauri — leave the existing list untouched.
    }
  }

  private async invokeCheckForUpdate(): Promise<void> {
    try {
      await this.tauri.invoke('check_for_update');
    } catch {
      // Outside Tauri or backend rejected — silent fail; the dedicated
      // settings/Update panel surfaces the error path.
    }
  }

  private navItem(
    id: string,
    label: string,
    shortcut: string,
    glyphColor: GlyphColor,
    route: string
  ): PaletteItem {
    return {
      id: `nav-${id}`,
      section: 'navigate',
      glyph: '◎',
      glyphColor,
      label,
      shortcut,
      action: () => {
        this.router.navigateByUrl(route);
        this.ui.closePalette();
      },
    };
  }
}
