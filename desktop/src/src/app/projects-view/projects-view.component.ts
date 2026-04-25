import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import type { ProjectEntry, ProjectList } from '../models/update';

/** Terminal-minimal project list view with switch action via `ProjectStateService`. */
@Component({
  selector: 'app-projects-view',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './projects-view.component.html',
  host: {
    class: 'flex flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--ink)] min-h-screen',
  },
})
export class ProjectsViewComponent implements OnInit, OnDestroy {
  private readonly tauri = inject(TauriService);
  private readonly projectState = inject(ProjectStateService);

  private readonly _projects = signal<readonly ProjectEntry[]>([]);
  private readonly _active = signal<string | null>(null);
  private readonly _switching = signal<string | null>(null);
  private readonly _error = signal<string>('');

  /** Known projects. */
  protected readonly projects = this._projects.asReadonly();
  /** Name of a project currently being switched to, or null if idle. */
  protected readonly switching = this._switching.asReadonly();
  /** Last-error message, empty when no error. */
  protected readonly error = this._error.asReadonly();
  /** True when no projects are configured yet. */
  protected readonly empty = computed(() => this._projects().length === 0);

  private unsubSettled: (() => void) | null = null;

  /** Loads projects on init and subscribes to project-settled updates. */
  async ngOnInit(): Promise<void> {
    await this.reload();
    this.unsubSettled = this.projectState.onProjectSettled(() => {
      this.reload();
    });
  }

  /** Cleans up the project-settled subscription. */
  ngOnDestroy(): void {
    if (this.unsubSettled) {
      this.unsubSettled();
      this.unsubSettled = null;
    }
  }

  /**
   * Switches to the given project via the shared state service.
   * @param name - project name to switch to
   */
  async switchTo(name: string): Promise<void> {
    if (this._switching() || name === this._active()) return;
    this._switching.set(name);
    this._error.set('');
    try {
      await this.projectState.switchProject(name);
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : String(err));
      this._switching.set(null);
    }
  }

  protected isActive(name: string): boolean {
    return this._active() === name;
  }

  protected isSwitchingTo(name: string): boolean {
    return this._switching() === name;
  }

  private async reload(): Promise<void> {
    try {
      const list = await this.tauri.invoke<ProjectList>('list_projects');
      this._projects.set(list.projects);
      this._active.set(list.active_project);
      this._switching.set(null);
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : String(err));
    }
  }
}
