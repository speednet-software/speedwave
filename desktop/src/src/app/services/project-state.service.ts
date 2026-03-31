import { Injectable, inject } from '@angular/core';
import { TauriService } from './tauri.service';
import type { BundleReconcileStatus, ProjectList } from '../models/update';

/** Lifecycle status of the project + container lifecycle. */
export type ProjectStatus =
  | 'loading'
  | 'system_check'
  | 'check_failed'
  | 'checking'
  | 'starting'
  | 'rebuilding'
  | 'auth_required'
  | 'ready'
  | 'switching'
  | 'error';

/** Backend response from the `get_auth_status` Tauri command. */
export interface AuthStatusResponse {
  api_key_configured: boolean;
  oauth_authenticated: boolean;
}

/**
 * SSOT for project lifecycle state. All project switching, adding,
 * container lifecycle, and reconcile status goes through this service.
 * Components subscribe to state changes instead of listening to Tauri
 * events directly.
 */
@Injectable({ providedIn: 'root' })
export class ProjectStateService {
  activeProject: string | null = null;
  targetProject: string | null = null;
  status: ProjectStatus = 'loading';
  error = '';
  needsRestart = false;
  restarting = false;
  restartError = '';

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

      // Check reconcile state before checking containers
      const bundleStatus = await this.tauri.invoke<BundleReconcileStatus>(
        'get_bundle_reconcile_state'
      );
      if (bundleStatus.in_progress) {
        this.status = 'rebuilding';
        this.notifyChange();
      } else {
        await this.ensureContainersRunning();
      }
    } catch {
      // Outside Tauri — stay 'loading', listeners still ready
    }
  }

  /** Checks OS prereqs, then verifies containers are running, starting them if not. */
  async ensureContainersRunning(): Promise<void> {
    if (
      this.status === 'system_check' ||
      this.status === 'checking' ||
      this.status === 'starting' ||
      this.status === 'auth_required'
    ) {
      return; // guard: already in progress
    }
    if (!this.activeProject) {
      this.status = 'error';
      this.error = 'No active project selected.';
      this.notifyChange();
      return;
    }

    // Phase 1: OS prerequisite check
    this.status = 'system_check';
    this.error = '';
    this.notifyChange();
    try {
      await this.tauri.invoke('run_system_check');
    } catch (err) {
      this.status = 'check_failed';
      this.error = String(err);
      this.notifyChange();
      return;
    }

    // Phase 2: check/start containers (includes SecurityCheck in backend)
    this.status = 'checking';
    this.notifyChange();
    try {
      const running = await this.tauri.invoke<boolean>('check_containers_running', {
        project: this.activeProject,
      });
      if (!running) {
        this.status = 'starting';
        this.notifyChange();
        // Backend ensure_images_ready() blocks up to 600s (RECONCILE_WAIT_TIMEOUT in containers_cmd.rs).
        // The 'starting' overlay stays visible for the duration.
        await this.tauri.invoke('start_containers', { project: this.activeProject });
      }
      // Phase 3: verify Claude authentication before declaring ready
      const auth = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', {
        project: this.activeProject,
      });
      if (auth.api_key_configured || auth.oauth_authenticated) {
        this.status = 'ready';
      } else {
        this.status = 'auth_required';
      }
    } catch (err) {
      const msg = String(err);
      // SSOT coupling: must match crates/speedwave-runtime/src/consts.rs SYSTEM_CHECK_FAILED_PREFIX
      if (msg.startsWith('System check failed:')) {
        this.status = 'check_failed';
      } else {
        this.status = 'error';
      }
      this.error = msg;
    }
    this.notifyChange();
    if (this.status === 'ready') {
      this.notifyReady();
      this.notifySettled();
    } else if (this.status === 'error' || this.status === 'check_failed') {
      this.notifyFailed(this.error);
      this.notifySettled();
    } else if (this.status === 'auth_required') {
      this.notifySettled();
    }
  }

  /** Re-checks Claude auth status after user completes authentication. */
  async retryAuth(): Promise<void> {
    if (!this.activeProject) return;
    try {
      const auth = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', {
        project: this.activeProject,
      });
      if (auth.api_key_configured || auth.oauth_authenticated) {
        this.status = 'ready';
        this.notifyChange();
        this.notifyReady();
        this.notifySettled();
      } else {
        this.status = 'auth_required';
        this.notifyChange();
      }
    } catch {
      this.status = 'auth_required';
      this.notifyChange();
    }
  }

  /**
   * Applies a pre-fetched auth status without an extra Tauri round-trip.
   * @param auth - The auth status response from the backend.
   */
  applyAuthStatus(auth: AuthStatusResponse): void {
    if (auth.api_key_configured || auth.oauth_authenticated) {
      if (this.status === 'auth_required') {
        this.status = 'ready';
        this.notifyChange();
        this.notifyReady();
        this.notifySettled();
      }
    } else {
      this.status = 'auth_required';
      this.notifyChange();
    }
  }

  /** Dismisses the error banner, checking containers first. */
  async dismissError(): Promise<void> {
    try {
      const running = await this.tauri.invoke<boolean>('check_containers_running', {
        project: this.activeProject,
      });
      if (running) {
        this.status = 'ready';
        this.error = '';
      } else {
        this.error = 'Containers are not running. Click Retry to start them.';
      }
    } catch {
      this.status = 'ready';
      this.error = '';
    }
    this.notifyChange();
  }

  /** Marks that pending changes require a container restart. */
  requestRestart(): void {
    this.needsRestart = true;
    this.notifyChange();
  }

  /** Restarts integration containers to apply pending changes. */
  async restartContainers(): Promise<void> {
    if (!this.activeProject || this.restarting) return;
    this.restarting = true;
    this.restartError = '';
    this.notifyChange();
    try {
      await this.tauri.invoke('restart_integration_containers', {
        project: this.activeProject,
      });
      this.needsRestart = false;
    } catch (e: unknown) {
      this.restartError = e instanceof Error ? e.message : String(e);
    }
    this.restarting = false;
    this.notifyChange();
  }

  /** Dismisses the restart overlay without restarting. */
  dismissRestart(): void {
    this.needsRestart = false;
    this.restartError = '';
    this.notifyChange();
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
        this.needsRestart = false;
        this.restarting = false;
        this.restartError = '';
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

      await this.tauri.listen<BundleReconcileStatus>('bundle_reconcile_status', (event) => {
        // Ignore reconcile events during active operations — backend
        // ensure_images_ready() already blocks those operations.
        if (
          this.status === 'switching' ||
          this.status === 'starting' ||
          this.status === 'checking' ||
          this.status === 'auth_required'
        ) {
          return;
        }
        if (event.payload.in_progress) {
          this.status = 'rebuilding';
          this.error = '';
          this.notifyChange();
        } else if (event.payload.last_error) {
          this.status = 'error';
          this.error = event.payload.last_error;
          this.notifyChange();
        } else {
          // Reconcile done — if we were rebuilding, check containers
          if (this.status === 'rebuilding') {
            this.ensureContainersRunning();
          }
        }
      });
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
