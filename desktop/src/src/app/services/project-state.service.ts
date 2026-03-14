import { Injectable, inject } from '@angular/core';
import { TauriService } from './tauri.service';
import type { ProjectList } from '../models/update';

/** Lifecycle status of the project switch operation. */
export type ProjectStatus = 'loading' | 'ready' | 'switching' | 'error';

/**
 * SSOT for project lifecycle state. All project switching and adding
 * goes through this service — components subscribe to state changes
 * instead of listening to Tauri events directly.
 */
@Injectable({ providedIn: 'root' })
export class ProjectStateService {
  activeProject: string | null = null;
  targetProject: string | null = null;
  status: ProjectStatus = 'loading';
  error = '';

  private initialized = false;
  private tauri = inject(TauriService);
  private changeListeners: Array<() => void> = [];
  private readyListeners: Array<() => void> = [];
  private failedListeners: Array<(error: string) => void> = [];
  private settledListeners: Array<() => void> = [];

  /**
   * Registers a callback invoked on every state mutation. Returns unsubscribe.
   * @param cb - The callback to invoke on change.
   */
  onChange(cb: () => void): () => void {
    this.changeListeners.push(cb);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== cb);
    };
  }

  /**
   * Registers a callback invoked when switching -> ready. Returns unsubscribe.
   * @param cb - The callback to invoke on project ready.
   */
  onProjectReady(cb: () => void): () => void {
    this.readyListeners.push(cb);
    return () => {
      this.readyListeners = this.readyListeners.filter((l) => l !== cb);
    };
  }

  /**
   * Registers a callback invoked when switching -> error. Returns unsubscribe.
   * @param cb - The callback to invoke with the error string.
   */
  onProjectFailed(cb: (error: string) => void): () => void {
    this.failedListeners.push(cb);
    return () => {
      this.failedListeners = this.failedListeners.filter((l) => l !== cb);
    };
  }

  /**
   * Registers a callback invoked when switching -> ready|error. Returns unsubscribe.
   * @param cb - The callback to invoke on settled.
   */
  onProjectSettled(cb: () => void): () => void {
    this.settledListeners.push(cb);
    return () => {
      this.settledListeners = this.settledListeners.filter((l) => l !== cb);
    };
  }

  /** Idempotent init — registers Tauri listeners and loads initial project. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.setupListeners();
    try {
      const result = await this.tauri.invoke<ProjectList>('list_projects');
      this.activeProject = result.active_project;
      this.status = 'ready';
      this.notifyChange();
    } catch {
      // Outside Tauri — stay 'loading', listeners still ready
    }
  }

  /**
   * The ONLY way to switch projects from the frontend.
   * @param name - The project name to switch to.
   */
  async switchProject(name: string): Promise<void> {
    await this.tauri.invoke('switch_project', { name });
  }

  /**
   * The ONLY way to add projects from the frontend.
   * @param name - The project name.
   * @param dir - The absolute path to the project directory.
   */
  async addProject(name: string, dir: string): Promise<void> {
    await this.tauri.invoke('add_project', { name, dir });
  }

  private async setupListeners(): Promise<void> {
    try {
      await this.tauri.listen<{ project: string }>('project_switch_started', (event) => {
        this.targetProject = event.payload.project;
        this.status = 'switching';
        this.error = '';
        this.notifyChange();
      });

      await this.tauri.listen<{ project: string }>('project_switch_succeeded', (event) => {
        this.activeProject = event.payload.project;
        this.targetProject = null;
        this.status = 'ready';
        this.error = '';
        this.notifyChange();
        this.notifyReady();
        this.notifySettled();
      });

      await this.tauri.listen<{ project: string | null; error: string }>(
        'project_switch_failed',
        (event) => {
          this.activeProject = event.payload.project;
          this.targetProject = null;
          this.status = 'error';
          this.error = event.payload.error;
          this.notifyChange();
          this.notifyFailed(event.payload.error);
          this.notifySettled();
        }
      );
    } catch {
      // Outside Tauri — listeners not available
    }
  }

  private notifyChange(): void {
    for (const cb of this.changeListeners) cb();
  }

  private notifyReady(): void {
    for (const cb of this.readyListeners) cb();
  }

  private notifyFailed(error: string): void {
    for (const cb of this.failedListeners) cb(error);
  }

  private notifySettled(): void {
    for (const cb of this.settledListeners) cb();
  }
}
