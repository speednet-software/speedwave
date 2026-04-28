import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import type { HealthReport } from '../models/health';

/** How often the polling loop refreshes the health snapshot. */
export const HEALTH_REFRESH_INTERVAL_MS = 5000;

/**
 * Polls `get_health` and exposes the latest `HealthReport` as a signal so
 * any component can subscribe without managing the polling timer or
 * project-settled subscription itself.
 *
 * Lifetime is `'root'` — there is exactly one polling loop per app instance.
 * The loop starts on first `ensurePolling()` call and stops on `OnDestroy`.
 *
 * Extracted from `LogsViewComponent` so the SRP load on that component is
 * reduced and the same data is reusable from other views (system tray,
 * setup wizard) without duplicating polling logic.
 */
@Injectable({ providedIn: 'root' })
export class SystemHealthService implements OnDestroy {
  private readonly tauri = inject(TauriService);
  private readonly projectState = inject(ProjectStateService);

  /** Latest health report; `null` until the first fetch lands. */
  readonly health = signal<HealthReport | null>(null);

  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubProjectSettled: (() => void) | null = null;
  private lastSerialised = '';
  private started = false;

  /**
   * Starts the polling loop on first call and returns the initial fetch
   * promise so callers can `await` the first snapshot. Subsequent calls
   * still return a promise that resolves immediately; they don't multiply
   * the fetch rate or restart the timer.
   */
  ensurePolling(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    const initial = this.refresh();
    this.timer = setInterval(() => void this.refresh(), HEALTH_REFRESH_INTERVAL_MS);
    this.unsubProjectSettled = this.projectState.onProjectSettled(() => {
      void this.refresh();
    });
    return initial;
  }

  /** Force a fetch outside the regular cadence (e.g. after a manual action). */
  async refresh(): Promise<void> {
    const project = this.projectState.activeProject;
    if (!project) return;
    try {
      const report = await this.tauri.invoke<HealthReport>('get_health', { project });
      if (!report || typeof report !== 'object' || !('vm' in report) || !('ide_bridge' in report)) {
        return;
      }
      // Skip the signal write when the snapshot is byte-identical to the
      // previous one — OnPush descendants stay quiet between real changes.
      const serialised = JSON.stringify(report);
      if (serialised === this.lastSerialised) return;
      this.lastSerialised = serialised;
      this.health.set(report);
    } catch {
      // Health is non-critical; keep the previous snapshot.
    }
  }

  /** Cancels the polling timer and the project-settled subscription. */
  ngOnDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.unsubProjectSettled) {
      this.unsubProjectSettled();
      this.unsubProjectSettled = null;
    }
    this.started = false;
  }
}
