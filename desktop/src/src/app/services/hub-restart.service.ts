import { Injectable, inject } from '@angular/core';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';

/** Applies a change of the hub's access rules by restarting the hub, or the project when it cannot. */
@Injectable({ providedIn: 'root' })
export class HubRestartService {
  private readonly tauri = inject(TauriService);
  private readonly projectState = inject(ProjectStateService);
  private readonly log = inject(LoggerService);

  /**
   * Recreates the hub of a project, or asks for a project restart when the hub cannot be restarted alone.
   * @param project - project whose hub reads the changed rules
   */
  async apply(project: string): Promise<void> {
    if (!this.projectState.isSettledOn(project) || this.projectState.status() !== 'ready') {
      this.projectState.requestRestartFor(project);
      return;
    }
    try {
      await this.tauri.invoke('restart_hub', { project });
    } catch (e: unknown) {
      this.log.warn(
        `restart_hub failed, falling back to full restart: ${e instanceof Error ? e.message : String(e)}`
      );
      this.projectState.requestRestartFor(project);
    }
  }
}
