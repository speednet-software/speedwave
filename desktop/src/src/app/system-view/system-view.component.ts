import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import type { HealthReport } from '../models/health';

/** How often the system view polls the backend for a fresh health report. */
export const SYSTEM_REFRESH_INTERVAL_MS = 5000;

/**
 * Terminal-minimal system health view.
 *
 * Polls `get_health` for the active project every 5 s and renders each
 * container as a row in a terminal-style table with a status dot, name,
 * state, healthy flag, and action buttons. Auto-refresh runs only while
 * the component is mounted — `ngOnDestroy` clears the interval.
 */
@Component({
  selector: 'app-system-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './system-view.component.html',
  host: { class: 'block bg-sw-bg-darkest min-h-screen p-6 text-sw-text' },
})
export class SystemViewComponent implements OnInit, OnDestroy {
  /** Aggregated health report, null until first fetch completes. */
  report: HealthReport | null = null;
  /** Error message from the most recent fetch, empty if healthy. */
  error = '';
  /** True while the initial fetch is in-flight (hides empty hint). */
  loading = true;
  /** Map of container names currently being restarted. */
  restarting = new Set<string>();

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly tauri = inject(TauriService);
  private readonly projectState = inject(ProjectStateService);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Starts the polling cycle and runs an immediate first fetch. */
  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, SYSTEM_REFRESH_INTERVAL_MS);
  }

  /** Cancels the polling cycle. */
  ngOnDestroy(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Fetches a fresh health report and updates view state. */
  async refresh(): Promise<void> {
    const project = this.projectState.activeProject;
    if (!project) {
      this.loading = false;
      this.report = null;
      this.error = 'No active project';
      this.cdr.markForCheck();
      return;
    }
    try {
      this.report = await this.tauri.invoke<HealthReport>('get_health', { project });
      this.error = '';
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  /**
   * Recreates all project containers via the existing Tauri command.
   * The runtime does not expose a per-container restart, so "restart"
   * here means recreate-all. Runs once and re-fetches health.
   * @param name - The container name triggered from the row button.
   */
  async restart(name: string): Promise<void> {
    const project = this.projectState.activeProject;
    if (!project || this.restarting.has(name)) return;
    this.restarting.add(name);
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('recreate_project_containers', { project });
      await this.refresh();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.restarting.delete(name);
      this.cdr.markForCheck();
    }
  }

  /** Whether the health report has at least one container entry. */
  get hasContainers(): boolean {
    return this.report !== null && this.report.containers.length > 0;
  }
}
