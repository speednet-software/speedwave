import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LoggerService } from '../services/logger.service';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { UiStateService } from '../services/ui-state.service';
import type { ProjectEntry, ProjectList } from '../models/update';

/**
 * Color swatches cycled through in the row left-edge tile.
 *
 * The mockup paints up to four projects (violet / teal / amber / accent). The
 * order is deterministic — same project always gets the same color regardless
 * of how the underlying list is sorted.
 */
const SWATCH_TOKENS = ['var(--violet)', 'var(--teal)', 'var(--amber)', 'var(--accent)'] as const;

/**
 * Project switcher dropdown — toggled from the chat header / command palette.
 *
 * Visibility is wired to {@link UiStateService.projectSwitcherOpen} so the
 * shell, the chat header, and the palette can all open/close it without
 * routing through this component. The `showAddForm` field tracks the inline
 * "Add project" form's own collapse state inside the dropdown footer.
 */
@Component({
  selector: 'app-project-switcher',
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ui.projectSwitcherOpen()) {
      <div
        class="fixed right-2 top-12 z-[1001] w-[calc(100vw-1rem)] max-w-xs sm:right-4 sm:top-14 sm:w-72"
        data-testid="project-switcher-dropdown"
        role="dialog"
        aria-label="Switch project"
      >
        <div class="rounded border border-[var(--line-strong)] bg-[var(--bg-1)] shadow-2xl">
          <!-- Header: search input -->
          <div class="border-b border-[var(--line)] p-2">
            <div
              class="flex items-center gap-2 rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1"
            >
              <span class="mono text-[11px] text-[var(--ink-mute)]">&gt;</span>
              <input
                type="text"
                class="mono w-full bg-transparent text-[11px] text-[var(--ink)] focus:outline-none"
                placeholder="search projects..."
                aria-label="Search projects"
                data-testid="project-switcher-search"
                [value]="filter()"
                (input)="onFilterInput($event)"
              />
            </div>
          </div>

          <!-- Body: project rows -->
          <div class="max-h-64 overflow-y-auto p-1">
            @for (entry of visibleProjects(); track entry.project.name; let i = $index) {
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left"
                [class]="entry.isActive ? rowActiveClasses : rowInactiveClasses"
                [attr.data-testid]="'project-switcher-item-' + entry.project.name"
                (click)="switchProject(entry.project.name)"
              >
                <div class="h-4 w-4 rounded-sm" [style.background]="entry.swatch"></div>
                <span
                  class="mono text-[12px]"
                  [class]="entry.isActive ? 'text-[var(--ink)]' : 'text-[var(--ink-dim)]'"
                  >{{ entry.project.name }}</span
                >
                @if (entry.isActive) {
                  <span class="pill accent ml-auto">current</span>
                } @else if (entry.shortcut) {
                  <span class="mono ml-auto text-[10px] text-[var(--ink-mute)]">{{
                    entry.shortcut
                  }}</span>
                }
              </button>
            } @empty {
              <div
                class="mono px-2 py-2 text-[11px] text-[var(--ink-mute)]"
                data-testid="project-switcher-empty"
              >
                no projects match
              </div>
            }
          </div>

          <!-- Footer: add project trigger / inline form -->
          <div class="border-t border-[var(--line)] p-1">
            @if (!showAddForm) {
              <button
                type="button"
                class="mono flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-[var(--accent)] hover:bg-[var(--bg-2)]"
                data-testid="add-project-btn"
                (click)="openAddForm()"
              >
                + add project...
              </button>
            } @else {
              <div class="px-2 py-2" data-testid="add-project-form">
                <input
                  class="mono mb-1.5 box-border block w-full rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1.5 text-[11px] text-[var(--ink)] focus:outline-none"
                  placeholder="project name"
                  data-testid="add-project-name"
                  [(ngModel)]="newProjectName"
                />
                <input
                  class="mono mb-1.5 box-border block w-full rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1.5 text-[11px] text-[var(--ink)] focus:outline-none"
                  placeholder="absolute path"
                  data-testid="add-project-dir"
                  [(ngModel)]="newProjectDir"
                />
                @if (addError) {
                  <div class="mono mb-1.5 text-[11px] text-red-300" data-testid="add-project-error">
                    {{ addError }}
                  </div>
                }
                <div class="flex gap-1.5">
                  <button
                    type="button"
                    class="mono flex-1 rounded bg-[var(--accent)] px-2 py-1 text-[11px] text-[var(--on-accent)] disabled:opacity-50"
                    data-testid="add-project-create"
                    [disabled]="addBusy"
                    (click)="addProject()"
                  >
                    create
                  </button>
                  <button
                    type="button"
                    class="mono flex-1 rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink-dim)] disabled:opacity-50"
                    data-testid="add-project-cancel"
                    [disabled]="addBusy"
                    (click)="cancelAdd()"
                  >
                    cancel
                  </button>
                </div>
              </div>
            }
          </div>
        </div>
      </div>
    }
  `,
})
export class ProjectSwitcherComponent implements OnInit, OnDestroy {
  /** Backend-loaded list of projects, refreshed on settled events. */
  projects: ProjectEntry[] = [];
  /** Slug of the currently active project — drives the "current" pill. */
  activeProject: string | null = null;

  /** Add-project form is collapsed by default; expands on the `+ add project...` row. */
  showAddForm = false;
  newProjectName = '';
  newProjectDir = '';
  addBusy = false;
  addError: string | null = null;

  /** Search input value — filters {@link visibleProjects} by case-insensitive substring. */
  readonly filter = signal('');

  /** Tailwind class string for the active row (highlighted bg, no hover-bg). */
  readonly rowActiveClasses = 'bg-[var(--bg-2)]';
  /** Tailwind class string for inactive rows — relies on `.hover-bg` utility. */
  readonly rowInactiveClasses = 'hover-bg';

  /** UI state service — exposed to the template for the visibility binding. */
  readonly ui = inject(UiStateService);
  /** Current projects + filter, decorated with swatch + shortcut + active flag. */
  readonly visibleProjects = computed(() => this.projectsWithMeta());

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private logger = inject(LoggerService);
  private unsubProjectSettled: (() => void) | null = null;

  /** Loads available projects from the backend on initialization. */
  async ngOnInit(): Promise<void> {
    try {
      const result = await this.tauri.invoke<ProjectList>('list_projects');
      this.projects = result.projects;
      this.activeProject = result.active_project;
      this.cdr.markForCheck();
    } catch {
      // Not running inside Tauri or command not registered yet.
    }

    // Refresh list on settled (not just ready — failed add still registers project).
    this.unsubProjectSettled = this.projectState.onProjectSettled(async () => {
      try {
        const result = await this.tauri.invoke<ProjectList>('list_projects');
        this.projects = result.projects;
        this.activeProject = result.active_project;
        this.cdr.markForCheck();
      } catch (err) {
        console.error('project settled: failed to refresh project list:', err);
      }
    });
  }

  /** Unsubscribes from the project settled listener. */
  ngOnDestroy(): void {
    if (this.unsubProjectSettled) {
      this.unsubProjectSettled();
      this.unsubProjectSettled = null;
    }
  }

  /**
   * Switches the active project to the specified one and closes the dropdown.
   * @param name - The name of the project to switch to.
   */
  async switchProject(name: string): Promise<void> {
    this.ui.closeProjectSwitcher();
    this.resetAddForm();
    try {
      await this.projectState.switchProject(name);
    } catch (err) {
      this.logger.error(`Failed to switch project: ${String(err)}`);
    }
    this.cdr.markForCheck();
  }

  /** Adds a new project and closes the form on success. The settled listener handles list refresh. */
  async addProject(): Promise<void> {
    const name = this.newProjectName.trim();
    const dir = this.newProjectDir.trim();

    if (!name || !dir) {
      this.addError = 'Name and path are required';
      this.cdr.markForCheck();
      return;
    }

    this.addBusy = true;
    this.addError = null;
    this.cdr.markForCheck();

    try {
      await this.projectState.addProject(name, dir);
      this.resetAddForm();
      this.ui.closeProjectSwitcher();
    } catch (err) {
      this.addError = String(err);
      this.logger.error(`Failed to add project: ${String(err)}`);
    }
    this.addBusy = false;
    this.cdr.markForCheck();
  }

  /** Resets the add-project form to its initial state. */
  cancelAdd(): void {
    this.resetAddForm();
    this.cdr.markForCheck();
  }

  /** Reveals the inline add-project form inside the dropdown footer. */
  openAddForm(): void {
    this.showAddForm = true;
    this.addError = null;
    this.cdr.markForCheck();
  }

  /**
   * Updates the search filter signal from the input event.
   * @param event - The native input event from the search field.
   */
  onFilterInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.filter.set(target.value);
  }

  private resetAddForm(): void {
    this.showAddForm = false;
    this.newProjectName = '';
    this.newProjectDir = '';
    this.addBusy = false;
    this.addError = null;
  }

  /**
   * Annotates the current `projects` list with the swatch color, optional
   * keyboard shortcut hint (⌘2, ⌘3…) and the `isActive` flag, then filters
   * by the search input.
   */
  private projectsWithMeta(): ReadonlyArray<{
    project: ProjectEntry;
    swatch: string;
    shortcut: string | null;
    isActive: boolean;
  }> {
    const needle = this.filter().trim().toLowerCase();
    return this.projects
      .map((project, index) => ({
        project,
        swatch: SWATCH_TOKENS[index % SWATCH_TOKENS.length],
        // Mockup hints ⌘2 / ⌘3 next to non-active rows. Only surface for the
        // first ~9 projects since after that the modifier is ambiguous.
        shortcut: !this.isActive(project) && index >= 1 && index <= 9 ? `⌘${index + 1}` : null,
        isActive: this.isActive(project),
      }))
      .filter(({ project }) =>
        needle === '' ? true : project.name.toLowerCase().includes(needle)
      );
  }

  private isActive(project: ProjectEntry): boolean {
    return project.name === this.activeProject;
  }
}
