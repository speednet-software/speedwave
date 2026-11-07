import { Injectable, inject } from '@angular/core';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';
import { errorText } from '../shared/error-text';

/** Applies changed access rules. */
@Injectable({ providedIn: 'root' })
export class AccessRestartService {
  private readonly tauri = inject(TauriService);
  private readonly projectState = inject(ProjectStateService);
  private readonly log = inject(LoggerService);

  /**
   * Restarts the hub and the proxy.
   * @param project - Project name.
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
        `restart of the hub or the proxy failed, falling back to full restart: ${errorText(e)}`
      );
      this.projectState.requestRestartFor(project);
    }
  }
}
