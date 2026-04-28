import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
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
 * Visibility is wired to {@link UiStateService.paletteOpen}; closing the
 * palette is owned by the shell-level ESC handler (which already calls
 * `ui.closePalette()`). This component renders the navigate / actions /
 * projects list, supports incremental filtering, and exposes arrow-key
 * navigation + Enter to invoke the highlighted item.
 */
@Component({
  selector: 'app-command-palette',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.arrowdown)': 'onArrowDown($event)',
    '(document:keydown.arrowup)': 'onArrowUp($event)',
    '(document:keydown.enter)': 'onEnter($event)',
  },
  template: `
    @if (ui.paletteOpen()) {
      <div
        class="fixed inset-0 z-[1000] flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabindex="-1"
        data-testid="command-palette-backdrop"
        (click)="onBackdropClick($event)"
        (keydown.escape)="ui.closePalette()"
      >
        <div
          class="w-[min(600px,90vw)] rounded-lg border border-[var(--line-strong)] bg-[var(--bg-1)] shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
          data-testid="command-palette"
        >
          <div class="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3">
            <span class="mono text-[12px] text-[var(--accent)]">&gt;</span>
            <input
              #queryInput
              type="text"
              class="mono w-full bg-transparent text-[14px] text-[var(--ink)] placeholder-[var(--ink-mute)] focus:outline-none"
              placeholder="type a command or search..."
              aria-label="Search commands"
              data-testid="palette-input"
              [value]="query()"
              (input)="onQueryInput($event)"
            />
            <span class="kbd">esc</span>
          </div>

          <div class="max-h-80 overflow-y-auto py-1" data-testid="palette-list">
            @for (item of decoratedItems(); track item.id) {
              @if (item.isFirstInSection) {
                <div
                  class="mono px-4 py-1 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  [class.mt-2]="item.section !== 'navigate'"
                  [attr.data-testid]="'palette-section-' + item.section"
                >
                  {{ item.section }}
                </div>
              }
              <button
                type="button"
                class="flex w-full items-center gap-3 px-4 py-1.5 text-left"
                [class]="highlightedIndex() === item.index ? 'bg-[var(--bg-2)]' : 'hover-bg'"
                [attr.data-testid]="'palette-item-' + item.id"
                [attr.aria-selected]="highlightedIndex() === item.index"
                (click)="invoke(item)"
                (mouseenter)="setHighlight(item.index)"
              >
                <span [class]="glyphClass(item.glyphColor)">{{ item.glyph }}</span>
                <span class="mono text-[12px] text-[var(--ink)]">{{ item.label }}</span>
                @if (item.shortcut) {
                  <span class="mono ml-auto text-[10px] text-[var(--ink-mute)]">{{
                    item.shortcut
                  }}</span>
                }
              </button>
            } @empty {
              <div
                class="mono px-4 py-3 text-[12px] text-[var(--ink-mute)]"
                data-testid="palette-empty"
              >
                no results
              </div>
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
      </div>
    }
  `,
})
export class CommandPaletteComponent implements OnInit, AfterViewInit, OnDestroy {
  /** UI state service — exposes `paletteOpen()` for the visibility binding. */
  readonly ui = inject(UiStateService);

  /** Current search query. */
  readonly query = signal<string>('');

  /** Index into the filtered list of the currently highlighted item. */
  readonly highlightedIndex = signal<number>(0);

  /** Live list of projects fetched on init and refreshed on settled events. */
  private readonly projects = signal<readonly ProjectEntry[]>([]);
  /** Slug of the currently active project — drives the projects section. */
  private readonly activeProject = signal<string | null>(null);

  private readonly queryInput = viewChild<ElementRef<HTMLInputElement>>('queryInput');

  private readonly router = inject(Router);
  private readonly tauri = inject(TauriService);
  private readonly projectState = inject(ProjectStateService);
  private readonly theme = inject(ThemeService);
  private readonly cdr = inject(ChangeDetectorRef);

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

  /** Wires effects that reset the search/highlight on open and clamp the highlight when the filtered list shrinks. */
  constructor() {
    // Reset the query / highlight whenever the palette opens.
    effect(() => {
      if (this.ui.paletteOpen()) {
        this.query.set('');
        this.highlightedIndex.set(0);
        // Defer focus to after the input is in the DOM.
        queueMicrotask(() => this.focusInput());
      }
    });
    // Clamp the highlight index whenever the filtered list shrinks.
    effect(() => {
      const len = this.filteredItems().length;
      if (len === 0) {
        this.highlightedIndex.set(0);
        return;
      }
      const current = this.highlightedIndex();
      if (current >= len) {
        this.highlightedIndex.set(len - 1);
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

  /** Focuses the search input on first render if the palette is already open. */
  ngAfterViewInit(): void {
    // If the palette opens before view init (initial route), focus on attach.
    if (this.ui.paletteOpen()) this.focusInput();
  }

  /** Releases the project-settled subscription so the singleton service does not leak references. */
  ngOnDestroy(): void {
    if (this.unsubProjectSettled) {
      this.unsubProjectSettled();
      this.unsubProjectSettled = null;
    }
  }

  /**
   * Updates the search query from the input event and resets the highlight
   * to the first matching item.
   * @param event - Native `input` event from the search field.
   */
  onQueryInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.query.set(target.value);
    this.highlightedIndex.set(0);
  }

  /**
   * Closes the palette when the backdrop (not the inner card) is clicked.
   * @param event - Mouse click event from the backdrop element.
   */
  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.ui.closePalette();
    }
  }

  /**
   * ↓ moves the highlight forward, wrapping at the end.
   * @param event - Keyboard event for the down-arrow press.
   */
  onArrowDown(event: Event): void {
    if (!this.ui.paletteOpen()) return;
    event.preventDefault();
    const len = this.filteredItems().length;
    if (len === 0) return;
    this.highlightedIndex.update((i) => (i + 1) % len);
  }

  /**
   * ↑ moves the highlight backward, wrapping at the start.
   * @param event - Keyboard event for the up-arrow press.
   */
  onArrowUp(event: Event): void {
    if (!this.ui.paletteOpen()) return;
    event.preventDefault();
    const len = this.filteredItems().length;
    if (len === 0) return;
    this.highlightedIndex.update((i) => (i - 1 + len) % len);
  }

  /**
   * ↵ invokes the highlighted item.
   * @param event - Keyboard event for the Enter press.
   */
  onEnter(event: Event): void {
    if (!this.ui.paletteOpen()) return;
    const items = this.filteredItems();
    const idx = this.highlightedIndex();
    const item = items[idx];
    if (!item) return;
    event.preventDefault();
    void this.invoke(item);
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
   * Manually sets the highlight index (mouseenter binding).
   * @param index - Zero-based index into the filtered item list.
   */
  setHighlight(index: number): void {
    this.highlightedIndex.set(index);
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

  private focusInput(): void {
    const el = this.queryInput()?.nativeElement;
    if (el) el.focus();
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
