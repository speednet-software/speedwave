import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';
import type { AuditorStatus } from '../models/auditor';

const REFRESH_MS = 60_000;

/** The last answer of Auditor per project on a machine under its `llm_egress` policy (ADR-090). */
@Injectable({ providedIn: 'root' })
export class AuditorService {
  private readonly tauri = inject(TauriService);
  private readonly projects = inject(ProjectStateService);
  private readonly log = inject(LoggerService);

  private readonly byProject = signal<Record<string, AuditorStatus>>({});
  private readonly inFlight = new Map<string, Promise<AuditorStatus | null>>();

  /** The machine is managed by Auditor (its policy is present). */
  readonly managed = computed(() => Object.values(this.byProject()).some((s) => s.managed));

  /** Auditor's answer for the active project. */
  readonly active = computed<AuditorStatus | null>(() => {
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
  statusFor(project: string | null | undefined): AuditorStatus | null {
    return this.byProject()[project ?? ''] ?? null;
  }

  /**
   * Asks Auditor (through the desktop backend, which holds the policy) about a project.
   * @param project - The project name ('' = the machine).
   * @param force - Ask even when a fresh answer is held.
   * @returns The answer, or null when the backend failed.
   */
  refresh(project: string, force = false): Promise<AuditorStatus | null> {
    const key = project ?? '';
    const running = this.inFlight.get(key);
    if (running && !force) return running;
    const run = this.tauri
      .invoke<AuditorStatus>('get_auditor_status', { project: key || null, force })
      .then((status) => {
        this.byProject.update((all) => ({ ...all, [key]: status }));
        return status;
      })
      .catch((e: unknown) => {
        this.log.warn(
          `Auditor status request failed: ${e instanceof Error ? e.message : String(e)}`
        );
        return null;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }
}
