import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';
import type { ManagementStatus } from '../models/management';

const REFRESH_MS = 60_000;

/** The management provider's last answer per project on a machine under a managed policy (ADR-091). */
@Injectable({ providedIn: 'root' })
export class ManagementService {
  private readonly tauri = inject(TauriService);
  private readonly projects = inject(ProjectStateService);
  private readonly log = inject(LoggerService);

  private readonly byProject = signal<Record<string, ManagementStatus>>({});
  private readonly inFlight = new Map<string, Promise<ManagementStatus | null>>();

  /** The machine is managed (its policy is present). */
  readonly managed = computed(() => Object.values(this.byProject()).some((s) => s.managed));

  /** The provider's answer for the active project. */
  readonly active = computed<ManagementStatus | null>(() => {
    const p = this.projects.activeProject() ?? '';
    const all = this.byProject();
    return all[p] ?? all[''] ?? null;
  });

  /** Follows the active project; refreshes it every minute while the machine is managed. */
  constructor() {
    effect(() => {
      void this.refresh(this.projects.activeProject() ?? '');
    });
    setInterval(() => {
      if (this.managed()) void this.refresh(this.projects.activeProject() ?? '', true);
    }, REFRESH_MS);
  }

  /**
   * The last answer for a project.
   * @param project - The project name ('' or null = the machine).
   * @returns The status, or null before the first answer.
   */
  statusFor(project: string | null | undefined): ManagementStatus | null {
    return this.byProject()[project ?? ''] ?? null;
  }

  /**
   * Asks the management provider (through the desktop backend, which holds the policy) about a project.
   * @param project - The project name ('' = the machine).
   * @param force - Ask even when a fresh answer is held.
   * @returns The answer, or null when the backend failed.
   */
  refresh(project: string, force = false): Promise<ManagementStatus | null> {
    const key = project ?? '';
    const running = this.inFlight.get(key);
    if (running && !force) return running;
    const run = this.tauri
      .invoke<ManagementStatus>('get_management_status', { project: key || null, force })
      .then((status) => {
        this.byProject.update((all) => ({ ...all, [key]: status }));
        return status;
      })
      .catch((e: unknown) => {
        this.log.warn(
          `Management status request failed: ${e instanceof Error ? e.message : String(e)}`
        );
        return null;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }
}
