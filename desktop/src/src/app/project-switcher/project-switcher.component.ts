import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { LoggerService } from '../services/logger.service';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { UiStateService } from '../services/ui-state.service';
import type { ProjectEntry, ProjectList } from '../models/update';
import { CreateProjectModalComponent } from '../shared/create-project-modal/create-project-modal.component';
import { IconComponent } from '../shared/icon.component';
import { TooltipDirective } from '../shared/tooltip.directive';
import { swatchFor } from './project-swatch';

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
  imports: [CreateProjectModalComponent, IconComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ui.projectSwitcherOpen()) {
      <!-- Click-outside backdrop — closes the dropdown when clicking anywhere
           outside it (mockup behaviour). Sits below the dropdown z-index. -->
      <div
        class="fixed inset-0 z-[1000]"
        data-testid="project-switcher-backdrop"
        aria-hidden="true"
        (click)="ui.closeProjectSwitcher()"
      ></div>
      <div
        class="fixed right-2 top-12 z-[1001] w-[calc(100vw-1rem)] max-w-xs sm:right-4 sm:top-14 sm:w-72"
        data-testid="project-switcher-dropdown"
        role="dialog"
        aria-label="Switch project"
      >
        <div class="rounded border border-[var(--line-strong)] bg-[var(--bg-1)] shadow-2xl">
          <!-- Body: project rows -->
          <div class="max-h-64 overflow-y-auto p-1">
            @for (entry of visibleProjects(); track entry.project.name) {
              @let pendingDelete = entry.project.name === pendingDeleteId();
              <div
                class="group flex items-center gap-1 rounded px-2 py-1.5"
                [class]="entry.isActive ? rowActiveClasses : rowInactiveClasses"
              >
                @if (pendingDelete) {
                  <div
                    class="flex min-w-0 flex-1 items-center justify-between gap-2"
                    [attr.data-testid]="'project-switcher-confirm-' + entry.project.name"
                    role="alertdialog"
                    aria-label="Confirm remove project"
                  >
                    <span class="mono truncate text-[11.5px] text-[var(--ink-dim)]">Sure?</span>
                    <div class="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        class="mono rounded border border-red-500/40 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10"
                        [attr.data-testid]="'project-switcher-confirm-yes-' + entry.project.name"
                        (click)="confirmRemove(entry.project.name)"
                      >
                        delete
                      </button>
                      <button
                        type="button"
                        class="mono rounded border border-[var(--line)] px-2 py-0.5 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
                        [attr.data-testid]="'project-switcher-confirm-no-' + entry.project.name"
                        (click)="cancelRemove()"
                      >
                        cancel
                      </button>
                    </div>
                  </div>
                } @else {
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 text-left"
                    [class.cursor-default]="entry.isActive"
                    [attr.data-testid]="'project-switcher-item-' + entry.project.name"
                    [disabled]="entry.isActive"
                    [attr.aria-current]="entry.isActive ? 'true' : null"
                    (click)="switchProject(entry.project.name)"
                  >
                    <div
                      class="mono inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-sm px-0.5 text-[8px] font-bold leading-none text-[#07090f]"
                      [style.background]="entry.swatch"
                      aria-hidden="true"
                    >
                      {{ entry.project.name.slice(0, 2).toLowerCase() }}
                    </div>
                    <span
                      class="mono truncate text-[12px]"
                      [class]="entry.isActive ? 'text-[var(--ink-mute)]' : 'text-[var(--ink-dim)]'"
                      >{{ entry.project.name }}</span
                    >
                    @if (entry.isActive) {
                      <span class="sr-only">current project</span>
                    }
                  </button>
                  @if (!entry.isActive) {
                    <button
                      type="button"
                      class="flex shrink-0 items-center px-1 text-[var(--ink-mute)] opacity-0 hover:text-red-300 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                      [attr.data-testid]="'project-switcher-remove-' + entry.project.name"
                      [attr.aria-label]="'Remove project ' + entry.project.name"
                      appTooltip="Remove from list?"
                      placement="top"
                      (click)="requestRemove(entry.project.name)"
                    >
                      <app-icon name="trash" class="h-3.5 w-3.5" />
                    </button>
                  }
                  <span
                    class="mono flex h-3.5 w-3.5 flex-shrink-0 cursor-default select-none items-center justify-center rounded-full border border-[var(--line-strong)] text-[9px] text-[var(--ink-mute)]"
                    [appTooltip]="entry.project.dir"
                    placement="top"
                    [attr.aria-label]="'Project directory: ' + entry.project.dir"
                    [attr.data-testid]="'project-switcher-item-info-' + entry.project.name"
                    tabindex="0"
                    >i</span
                  >
                }
              </div>
              @if (removeError() && entry.project.name === removeErrorName()) {
                <div
                  class="mono px-2 pb-1.5 text-[10px] text-red-300"
                  [attr.data-testid]="'project-switcher-remove-error-' + entry.project.name"
                  role="alert"
                >
                  {{ removeError() }}
                </div>
              }
            } @empty {
              <div
                class="mono px-2 py-2 text-[11px] text-[var(--ink-mute)]"
                data-testid="project-switcher-empty"
              >
                no projects
              </div>
            }
          </div>

          <!-- Footer: opens the shared create-project modal -->
          <div class="border-t border-[var(--line)] p-1">
            <button
              type="button"
              class="mono flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-[var(--accent)] hover:bg-[var(--bg-2)]"
              data-testid="add-project-btn"
              (click)="openAddForm()"
            >
              + add project...
            </button>
          </div>
        </div>
      </div>
    }

    <app-create-project-modal
      [open]="showAddForm()"
      [dismissible]="true"
      command="add_project"
      (created)="onProjectAdded()"
      (closed)="closeAddForm()"
    />
  `,
})
export class ProjectSwitcherComponent implements OnInit, OnDestroy {
  /**
   * Backend-loaded list of projects, refreshed on settled events. Must be a
   * signal — `visibleProjects` is a computed and would not recompute on a
   * plain field reassignment, leaving the dropdown stale after `add_project`.
   */
  readonly projects = signal<ProjectEntry[]>([]);
  /** Slug of the currently active project — drives the "current" pill. */
  readonly activeProject = signal<string | null>(null);

  /** Whether the shared create-project modal is currently visible. */
  readonly showAddForm = signal<boolean>(false);

  /** Name of the row pending remove confirmation; `null` when none. */
  readonly pendingDeleteId = signal<string | null>(null);

  /** Backend error message to surface inline under a row; `null` when none. */
  readonly removeError = signal<string | null>(null);
  /** Project name the surfaced error refers to. */
  readonly removeErrorName = signal<string | null>(null);

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

  /** Registers reactive cleanup of transient pending/error state. */
  constructor() {
    // Reset transient pending/error state when the dropdown closes or when
    // the row disappears from the list — otherwise reopening would render
    // a stale "Sure?" confirm prompt or an error for a missing project.
    effect(() => {
      if (!this.ui.projectSwitcherOpen()) {
        this.pendingDeleteId.set(null);
        this.removeError.set(null);
        this.removeErrorName.set(null);
      }
    });
    effect(() => {
      const names = new Set(this.projects().map((p) => p.name));
      const pending = this.pendingDeleteId();
      if (pending !== null && !names.has(pending)) {
        this.pendingDeleteId.set(null);
      }
      const errName = this.removeErrorName();
      if (errName !== null && !names.has(errName)) {
        this.removeError.set(null);
        this.removeErrorName.set(null);
      }
    });
  }

  /** Loads available projects from the backend on initialization. */
  async ngOnInit(): Promise<void> {
    try {
      const result = await this.tauri.invoke<ProjectList>('list_projects');
      this.projects.set(result.projects);
      this.activeProject.set(result.active_project);
    } catch {
      // Not running inside Tauri or command not registered yet.
    }

    // Refresh list on settled (not just ready — failed add still registers project).
    this.unsubProjectSettled = this.projectState.onProjectSettled(async () => {
      try {
        const result = await this.tauri.invoke<ProjectList>('list_projects');
        this.projects.set(result.projects);
        this.activeProject.set(result.active_project);
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
    this.showAddForm.set(false);
    try {
      await this.projectState.switchProject(name);
    } catch (err) {
      this.logger.error(`Failed to switch project: ${String(err)}`);
    }
    this.cdr.markForCheck();
  }

  /** Resumes UI flow once the create-project modal has registered a new project. */
  onProjectAdded(): void {
    this.showAddForm.set(false);
    this.ui.closeProjectSwitcher();
    this.cdr.markForCheck();
  }

  /** Closes the create-project modal without registering a new project. */
  closeAddForm(): void {
    this.showAddForm.set(false);
    this.cdr.markForCheck();
  }

  /** Opens the shared create-project modal from the dropdown footer. */
  openAddForm(): void {
    this.ui.closeProjectSwitcher();
    this.showAddForm.set(true);
    this.cdr.markForCheck();
  }

  /**
   * Swaps the row into the confirm prompt.
   * @param name - The project to mark as pending removal.
   */
  requestRemove(name: string): void {
    this.pendingDeleteId.set(name);
    this.removeError.set(null);
    this.removeErrorName.set(null);
    this.cdr.markForCheck();
  }

  /** Dismisses the confirm prompt without removing. */
  cancelRemove(): void {
    this.pendingDeleteId.set(null);
    this.cdr.markForCheck();
  }

  /**
   * Confirms removal and calls the backend.
   * @param name - The project to remove.
   */
  async confirmRemove(name: string): Promise<void> {
    this.pendingDeleteId.set(null);
    try {
      await this.projectState.removeProject(name);
      this.removeError.set(null);
      this.removeErrorName.set(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.removeError.set(this.cleanRemoveErrorMessage(msg));
      this.removeErrorName.set(name);
      this.logger.error(`Failed to remove project: ${msg}`);
    }
    this.cdr.markForCheck();
  }

  /**
   * Strips the runtime sentinel prefix so the user sees the human-readable message.
   * @param msg - Raw backend error message that may carry the sentinel prefix.
   */
  private cleanRemoveErrorMessage(msg: string): string {
    const prefix = 'active_project_removal: ';
    const idx = msg.indexOf(prefix);
    return idx >= 0 ? msg.slice(idx + prefix.length) : msg;
  }

  /** Decorates the project list with swatch color and active flag. */
  private projectsWithMeta(): ReadonlyArray<{
    project: ProjectEntry;
    swatch: string;
    isActive: boolean;
  }> {
    const active = this.activeProject();
    return this.projects().map((project, index) => ({
      project,
      swatch: swatchFor(index),
      isActive: project.name === active,
    }));
  }
}
