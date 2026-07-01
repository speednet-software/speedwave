import { Injectable, inject, signal } from '@angular/core';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import type {
  BundleReconcileStatus,
  ProjectEntry,
  ProjectList,
  ProjectSwitchFailedPayload,
} from '../models/update';
import { CLOUDSTORAGE_TCC_PREFIX, cloudstorageProviderDisplayName } from './cloudstorage-prefix';
import { HealthStoreService } from './health-store.service';
import type { HealthReport } from '../models/health';

/** Poll cadence for the post-start health gate. */
export const HEALTH_GATE_POLL_MS = 1500;
/** Give up on the health gate after this long and surface an error. */
export const HEALTH_GATE_TIMEOUT_MS = 120_000;

/**
 * Human-readable reason for a failed health gate.
 * @param report - Last health snapshot, or null if none arrived.
 */
export function unhealthySummary(report: HealthReport | null): string {
  if (!report) return 'System did not become healthy: health status unavailable.';
  const reasons: string[] = [];
  if (!report.vm.running) reasons.push('VM not running');
  if (!report.mcp_os.running) reasons.push('mcp-os worker stopped');
  const unhealthy = report.containers.filter((c) => !c.healthy).map((c) => c.name);
  if (unhealthy.length > 0) reasons.push(`unhealthy containers: ${unhealthy.join(', ')}`);
  return `System did not become healthy: ${reasons.join('; ') || 'unknown reason'}.`;
}

/** Lifecycle status of the project + container lifecycle. */
export type ProjectStatus =
  | 'loading'
  | 'system_check'
  | 'check_failed'
  | 'checking'
  | 'starting'
  | 'rebuilding'
  | 'auth_required'
  | 'no_provider'
  | 'ready'
  | 'switching'
  | 'error';

/** Backend response from the `get_auth_status` Tauri command. */
export interface AuthStatusResponse {
  api_key_configured: boolean;
  oauth_authenticated: boolean;
  /**
   * Whether the active provider needs Anthropic auth at all (R7); `false` for
   * non-anthropic providers, so the gate must not block on the credential flags.
   */
  needs_anthropic_auth: boolean;
  /** False when the project has no active provider (logout) → "choose a provider". */
  provider_configured: boolean;
}

/**
 * no_provider always wins over the credential flags; see AuthStatusResponse for field meanings.
 * @param auth - Raw auth status from the backend.
 */
export function authStatusToProjectStatus(
  auth: AuthStatusResponse
): 'no_provider' | 'ready' | 'auth_required' {
  if (!auth.provider_configured) return 'no_provider';
  if (!auth.needs_anthropic_auth || auth.api_key_configured || auth.oauth_authenticated) {
    return 'ready';
  }
  return 'auth_required';
}

/** SSOT for project lifecycle state (switching, adding, container lifecycle, reconcile). */
@Injectable({ providedIn: 'root' })
export class ProjectStateService {
  activeProject: string | null = null;
  targetProject: string | null = null;
  /** All configured projects from `~/.speedwave/config.json`. */
  projects: ProjectEntry[] = [];
  readonly status = signal<ProjectStatus>('loading');
  error = '';
  needsRestart = false;
  restarting = false;
  restartError = '';

  /** Service just toggled on, forwarded to backend for rollback on build fail. */
  pendingJustEnabled: string | null = null;

  /**
   * Structured error kind set when a CloudStorage TCC failure is detected.
   * `'cloudstorage_tcc_required'` routes the shell to `<app-cloudstorage-modal>`.
   */
  errorKind?: 'cloudstorage_tcc_required';
  /** CloudStorage provider display name (e.g. "OneDrive") when errorKind is set. */
  failureProvider?: string;
  /** Absolute path to the project directory that triggered the TCC failure. */
  failureProjectDir?: string;

  private initialized = false;
  private tauri = inject(TauriService);
  private log = inject(LoggerService);
  private healthStore = inject(HealthStoreService);
  /** Set of integration status re-fetchers, called after a failed restart. */
  private statusRefreshers: Array<() => void> = [];
  private changeListeners: Array<() => void> = [];
  private readyListeners: Array<() => void> = [];
  private restartListeners: Array<() => void> = [];
  private restartBeginListeners: Array<() => Promise<void>> = [];
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
   * Fires on container-restart completion (distinct from plain ready) so the
   * chat layer resumes the live session across a model switch. Returns unsubscribe.
   * @param cb - The callback to invoke after a successful restart.
   */
  onRestartComplete(cb: () => void): () => void {
    this.restartListeners.push(cb);
    return () => {
      this.restartListeners = this.restartListeners.filter((l) => l !== cb);
    };
  }

  /** Fires the restart-complete listeners (test seam + restart path). */
  notifyRestartComplete(): void {
    for (const cb of this.restartListeners) cb();
  }

  /**
   * Subscribe to fire (and be awaited) BEFORE a container restart begins.
   * @param cb - Listener invoked before restart; unsubscribe via the returned function.
   */
  onRestartBegin(cb: () => Promise<void>): () => void {
    this.restartBeginListeners.push(cb);
    return () => {
      this.restartBeginListeners = this.restartBeginListeners.filter((l) => l !== cb);
    };
  }

  /** Awaits all begin-callbacks; a failing pre-restart hook must not block the restart. */
  private async notifyRestartBegin(): Promise<void> {
    for (const cb of this.restartBeginListeners) {
      try {
        await cb();
      } catch {
        /* intentional: see method doc */
      }
    }
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
      this.projects = result.projects;

      // Check reconcile state before checking containers
      const bundleStatus = await this.tauri.invoke<BundleReconcileStatus>(
        'get_bundle_reconcile_state'
      );
      if (bundleStatus.in_progress) {
        this.status.set('rebuilding');
        this.notifyChange();
      } else {
        await this.ensureContainersRunning();
      }
    } catch (err) {
      if (!this.tauri.isRunningInTauri()) {
        // Outside Tauri — stay 'loading', listeners still ready.
        return;
      }
      // Inside Tauri the initial project/reconcile lookup genuinely failed;
      // surface it instead of leaving the UI stuck on the loading overlay.
      const msg = err instanceof Error ? err.message : String(err);
      this.status.set('error');
      this.error = msg;
      this.log.error(`[ProjectStateService] init failed: ${msg}`);
      this.notifyChange();
    }
  }

  /** Re-fetch configured projects so cached metadata stays in sync after adds/renames/switches. */
  private async refreshProjectList(): Promise<void> {
    try {
      const refreshed = await this.tauri.invoke<ProjectList>('list_projects');
      this.projects = refreshed.projects;
      this.notifyChange();
    } catch {
      // Non-fatal — keep the stale list.
    }
  }

  /** Resolves post-switch status via `get_auth_status` (no_provider vs ready vs auth_required). */
  private async resolveSwitchSucceededStatus(): Promise<void> {
    if (!this.activeProject) return;
    try {
      const auth = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', {
        project: this.activeProject,
      });
      this.status.set(authStatusToProjectStatus(auth));
    } catch (err) {
      this.status.set('error');
      this.error = String(err);
    }
    this.notifyChange();
    if (this.status() === 'ready') {
      this.notifyReady();
    }
    this.notifySettled();
  }

  /** Checks OS prereqs, then verifies containers are running, starting them if not. */
  async ensureContainersRunning(): Promise<void> {
    if (
      this.status() === 'system_check' ||
      this.status() === 'checking' ||
      this.status() === 'starting' ||
      this.status() === 'auth_required'
    ) {
      return; // guard: already in progress
    }
    if (!this.activeProject) {
      this.status.set('error');
      this.error = 'No active project selected.';
      this.notifyChange();
      return;
    }

    // Phase 1: OS prerequisite check
    this.status.set('system_check');
    this.error = '';
    this.notifyChange();
    try {
      await this.tauri.invoke('run_system_check');
    } catch (err) {
      this.status.set('check_failed');
      this.error = String(err);
      this.notifyChange();
      return;
    }

    // Phase 2: check/start containers (includes SecurityCheck in backend)
    this.status.set('checking');
    this.notifyChange();
    try {
      const running = await this.tauri.invoke<boolean>('check_containers_running', {
        project: this.activeProject,
      });
      if (!running) {
        this.status.set('starting');
        this.notifyChange();
        // Backend ensure_images_ready() blocks up to 600s (RECONCILE_WAIT_TIMEOUT in containers_cmd.rs).
        // The 'starting' overlay stays visible for the duration.
        await this.tauri.invoke('start_containers', { project: this.activeProject });
      }
      // Phase 3: verify Claude authentication before declaring ready
      const auth = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', {
        project: this.activeProject,
      });
      const next = authStatusToProjectStatus(auth);
      if (next === 'ready') {
        // Phase 4: hold the overlay until the system is actually healthy.
        await this.waitForSystemHealthy();
      }
      this.status.set(next);
    } catch (err) {
      const msg = String(err);
      // SSOT coupling: must match crates/speedwave-runtime/src/consts.rs SYSTEM_CHECK_FAILED_PREFIX
      if (msg.startsWith('System check failed:')) {
        this.status.set('check_failed');
        this.errorKind = undefined;
      } else if (msg.startsWith(CLOUDSTORAGE_TCC_PREFIX)) {
        // CloudStorage TCC denial — parse "{stable_id}|{dir}" from the prefix.
        this.status.set('error');
        this.errorKind = 'cloudstorage_tcc_required';
        const body = msg.slice(CLOUDSTORAGE_TCC_PREFIX.length);
        const pipeIdx = body.indexOf('|');
        if (pipeIdx >= 0) {
          this.failureProvider = cloudstorageProviderDisplayName(body.slice(0, pipeIdx));
          this.failureProjectDir = body.slice(pipeIdx + 1);
        }
      } else {
        this.status.set('error');
        this.errorKind = undefined;
      }
      this.error = msg;
    }
    this.notifyChange();
    if (this.status() === 'ready') {
      this.notifyReady();
      this.notifySettled();
    } else if (this.status() === 'error' || this.status() === 'check_failed') {
      this.notifyFailed(this.error);
      this.notifySettled();
    } else if (this.status() === 'auth_required') {
      this.notifySettled();
    }
  }

  /** Overridable in tests; production values come from the module constants. */
  healthGatePollMs = HEALTH_GATE_POLL_MS;
  healthGateTimeoutMs = HEALTH_GATE_TIMEOUT_MS;

  /** Polls `get_health` until `overall_healthy`; throws on timeout. */
  private async waitForSystemHealthy(): Promise<void> {
    const deadline = Date.now() + this.healthGateTimeoutMs;
    let last: HealthReport | null = null;
    for (;;) {
      try {
        const report = await this.tauri.invoke<HealthReport | undefined>('get_health', {
          project: this.activeProject,
        });
        // No report = health unverifiable (non-Tauri/test harness) — pass through.
        if (!report) return;
        // Seed the shared snapshot so views render real data the moment the overlay lifts.
        this.healthStore.health.set(report);
        if (report.overall_healthy) return;
        last = report;
      } catch {
        // Transient probe failure — keep polling until the deadline.
      }
      if (Date.now() >= deadline) {
        throw new Error(unhealthySummary(last));
      }
      await new Promise((resolve) => setTimeout(resolve, this.healthGatePollMs));
    }
  }

  /** Re-checks Claude auth status after user completes authentication. */
  async retryAuth(): Promise<void> {
    if (!this.activeProject) return;
    try {
      const auth = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', {
        project: this.activeProject,
      });
      const next = authStatusToProjectStatus(auth);
      if (next === 'ready') {
        await this.waitForSystemHealthy();
        this.status.set('ready');
        this.notifyChange();
        this.notifyReady();
        this.notifySettled();
      } else {
        this.status.set(next);
        this.notifyChange();
      }
    } catch (err) {
      // Auth check failed (transient IPC) — not "unauthenticated", so surface a
      // retryable error instead of falling through to auth_required.
      const msg = err instanceof Error ? err.message : String(err);
      this.status.set('error');
      this.error = msg;
      this.log.error(`[ProjectStateService] retryAuth check failed: ${msg}`);
      this.notifyChange();
      this.notifyFailed(msg);
      this.notifySettled();
    }
  }

  /**
   * Applies a pre-fetched auth status without an extra Tauri round-trip.
   * @param auth - The auth status response from the backend.
   */
  applyAuthStatus(auth: AuthStatusResponse): void {
    const next = authStatusToProjectStatus(auth);
    if (next === 'ready') {
      // Only promote from a terminal pre-ready state; don't re-notify a live session.
      if (this.status() === 'auth_required' || this.status() === 'no_provider') {
        this.status.set('ready');
        this.notifyChange();
        this.notifyReady();
        this.notifySettled();
      }
      return;
    }
    // next is a pre-ready state (no_provider | auth_required). Never downgrade a
    // live session: opening Settings must not blank a running chat on a transient
    // or false negative (e.g. a dangling-active config reading provider_configured=false).
    if (this.status() === 'ready') return;
    this.status.set(next);
    this.notifyChange();
  }

  /** Force-sets status to no_provider, skipping the never-downgrade guard. */
  forceUnconfigured(): void {
    this.status.set('no_provider');
    this.notifyChange();
  }

  /**
   * Retries container startup after a CloudStorage TCC (or other transient) error.
   * Resets error state and re-runs `ensureContainersRunning`.
   */
  async retry(): Promise<void> {
    this.errorKind = undefined;
    this.failureProvider = undefined;
    this.failureProjectDir = undefined;
    this.error = '';
    this.status.set('loading');
    this.notifyChange();
    await this.ensureContainersRunning();
  }

  /** Dismisses the error banner, checking containers first. */
  async dismissError(): Promise<void> {
    try {
      const running = await this.tauri.invoke<boolean>('check_containers_running', {
        project: this.activeProject,
      });
      if (running) {
        this.status.set('ready');
        this.error = '';
      } else {
        this.error = 'Containers are not running. Click Retry to start them.';
      }
    } catch {
      this.status.set('ready');
      this.error = '';
    }
    this.notifyChange();
  }

  /** Marks that pending changes require a container restart. */
  requestRestart(): void {
    this.needsRestart = true;
    this.notifyChange();
  }

  /**
   * Registers a status re-fetcher; the integrations component uses this so
   * that on a failed enable (build/restart) the row visibly reverts.
   * @param cb - Callback invoked after a failed restart so the caller can
   *   re-fetch integration statuses and reflect the backend's rollback.
   */
  registerIntegrationStatusRefresher(cb: () => void): () => void {
    this.statusRefreshers.push(cb);
    return () => {
      this.statusRefreshers = this.statusRefreshers.filter((l) => l !== cb);
    };
  }

  /** Restarts integration containers; backend rebuilds missing worker images. */
  async restartContainers(): Promise<void> {
    if (!this.activeProject || this.restarting) return;
    const project = this.activeProject;
    const justEnabled = this.pendingJustEnabled;
    this.restarting = true;
    this.restartError = '';
    this.notifyChange();

    let restartedOk = false;
    try {
      await this.notifyRestartBegin();
      await this.tauri.invoke('restart_integration_containers', { project, justEnabled });
      this.needsRestart = false;
      restartedOk = true;
      // Slash discovery is cached host-side for 10 min; compose recreate
      // does not invalidate it.
      try {
        await this.tauri.invoke('invalidate_slash_cache', { projectId: project });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`[ProjectStateService] invalidate_slash_cache failed: ${msg}`);
      }
    } catch (e: unknown) {
      this.restartError = e instanceof Error ? e.message : String(e);
      // Backend rolled `justEnabled` back to disabled — refresh the rows.
      for (const cb of this.statusRefreshers) cb();
    }

    this.restarting = false;
    this.pendingJustEnabled = null;
    this.notifyChange();
    if (restartedOk) {
      // Re-check auth: a provider switch may have cleared the need for it, so a
      // stale auth_required must not survive the restart.
      if (this.status() === 'auth_required') await this.retryAuth();
      this.notifyReady();
      this.notifySettled();
      // Distinct from a plain ready: the chat layer resumes the live session so
      // a model switch (which recreates the claude container) keeps context.
      this.notifyRestartComplete();
    }
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

  /**
   * The ONLY way to remove projects from the frontend.
   * @param name - The project to remove.
   */
  async removeProject(name: string): Promise<void> {
    await this.tauri.invoke('remove_project', { name });
    await this.refreshProjectList();
    this.notifySettled();
  }

  private async setupListeners(): Promise<void> {
    try {
      await this.tauri.listen<{ project: string }>('project_switch_started', (event) => {
        this.targetProject = event.payload.project;
        this.status.set('switching');
        this.error = '';
        this.errorKind = undefined;
        this.failureProvider = undefined;
        this.failureProjectDir = undefined;
        this.needsRestart = false;
        this.restarting = false;
        this.restartError = '';
        this.notifyChange();
      });

      await this.tauri.listen<{ project: string }>('project_switch_succeeded', (event) => {
        this.activeProject = event.payload.project;
        this.targetProject = null;
        this.error = '';
        // A no-provider project has no containers to start — status must
        // reflect that, not be hardcoded to 'ready'.
        void this.resolveSwitchSucceededStatus();
        // Fire-and-forget list refresh so consumers eventually see added/renamed
        // entries; a stale list for one tick is acceptable.
        void this.refreshProjectList();
      });

      await this.tauri.listen<ProjectSwitchFailedPayload>('project_switch_failed', (event) => {
        this.activeProject = event.payload.project;
        this.targetProject = null;
        this.status.set('error');
        this.error = event.payload.error;
        this.errorKind = event.payload.error_kind;
        this.failureProvider = event.payload.provider;
        this.failureProjectDir = event.payload.project_dir;
        this.notifyChange();
        this.notifyFailed(event.payload.error);
        this.notifySettled();
      });

      await this.tauri.listen<BundleReconcileStatus>('bundle_reconcile_status', (event) => {
        // Ignore reconcile events during active operations — backend
        // ensure_images_ready() already blocks those operations.
        if (
          this.status() === 'switching' ||
          this.status() === 'starting' ||
          this.status() === 'checking' ||
          this.status() === 'auth_required'
        ) {
          return;
        }
        if (event.payload.in_progress) {
          this.status.set('rebuilding');
          this.error = '';
          this.notifyChange();
        } else if (event.payload.last_error) {
          this.status.set('error');
          this.error = event.payload.last_error;
          this.notifyChange();
        } else {
          // Reconcile done — if we were rebuilding, check containers
          if (this.status() === 'rebuilding') {
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
