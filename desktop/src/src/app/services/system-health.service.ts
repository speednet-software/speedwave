import { Injectable, OnDestroy, inject } from '@angular/core';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';
import { HealthStoreService } from './health-store.service';
import type { HealthReport } from '../models/health';

/** How often the polling loop refreshes the health snapshot. */
export const HEALTH_REFRESH_INTERVAL_MS = 5000;

/** Polls `get_health` and exposes the latest `HealthReport` as a signal. */
@Injectable({ providedIn: 'root' })
export class SystemHealthService implements OnDestroy {
  private readonly tauri = inject(TauriService);
  private readonly projectState = inject(ProjectStateService);
  private readonly log = inject(LoggerService);
  private readonly store = inject(HealthStoreService);

  /** Latest health report (SSOT in HealthStoreService); `null` until the first fetch lands. */
  readonly health = this.store.health;

  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubProjectSettled: (() => void) | null = null;
  private lastSerialised = '';
  private started = false;

  /** Starts the polling loop on first call; returns the initial fetch promise. */
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
    const project = this.projectState.activeProject();
    if (!project) return;
    try {
      const report = await this.tauri.invoke<HealthReport>('get_health', { project });
      if (!report || typeof report !== 'object' || !('vm' in report) || !('ide_bridge' in report)) {
        return;
      }
      // Skip the signal write when the snapshot is byte-identical to the previous one.
      const serialised = JSON.stringify(report);
      if (serialised === this.lastSerialised) return;
      this.lastSerialised = serialised;
      this.health.set(report);
    } catch (err) {
      // Health is non-critical; keep the previous snapshot and log at debug level.
      if (this.tauri.isRunningInTauri()) {
        this.log.debug(`[SystemHealth] get_health failed: ${String(err)}`);
      }
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
