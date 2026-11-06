import { Injectable, inject } from '@angular/core';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';

/** Applies a change of the access rules by recreating the hub and the proxy, or restarting the project when it cannot. */
@Injectable({ providedIn: 'root' })
export class AccessRestartService {
  private readonly tauri = inject(TauriService);
  private readonly projectState = inject(ProjectStateService);
  private readonly log = inject(LoggerService);

  /**
   * Recreates the hub and the proxy of a project, or asks for a project restart when they cannot be restarted alone.
   * @param project - project whose hub and proxy read the changed rules
   */
  async apply(project: string): Promise<void> {
    if (!this.projectState.isSettledOn(project) || this.projectState.status() !== 'ready') {
      this.projectState.requestRestartFor(project);
      return;
    }
    try {
      await this.tauri.invoke('restart_hub', { project });
      await this.tauri.invoke('restart_llm_proxy', { project });
    } catch (e: unknown) {
      this.log.warn(
        `restart of the hub or the proxy failed, falling back to full restart: ${e instanceof Error ? e.message : String(e)}`
      );
      this.projectState.requestRestartFor(project);
    }
  }
}
