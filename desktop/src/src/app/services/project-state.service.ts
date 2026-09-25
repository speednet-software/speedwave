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

/** Backend-derived auth readiness (Rust `AuthReadiness`, snake_case wire values). */
export type AuthReadiness = 'no_provider' | 'ready' | 'auth_required';

/** Claude Code's sign-in verdict (Rust `OauthSignIn`, snake_case wire values). */
export type OauthSignIn = 'verified' | 'saved_unverified' | 'none';

/** What a `restartContainers` call did, for a caller that depends on the re-rendered compose. */
export type RestartOutcome = 'restarted' | 'skipped' | 'failed';

/** Backend response from the `get_auth_status` Tauri command. */
export interface AuthStatusResponse {
  /** Backend-derived discriminant (SSOT: Rust `AuthReadiness::derive`). */
  status?: AuthReadiness;
  api_key_configured: boolean;
  /** True only when Claude Code in the running container reports a sign-in. */
  oauth_authenticated: boolean;
  /** Claude Code's sign-in verdict; absent in older payloads. */
  oauth_sign_in?: OauthSignIn;
  /**
   * Whether the active provider needs Anthropic auth at all (R7); `false` for
   * non-anthropic providers, so the gate must not block on the credential flags.
   */
  needs_anthropic_auth: boolean;
  /** False when the project has no active provider (logout) → "choose a provider". */
  provider_configured: boolean;
}

/**
 * Passes the backend `status` discriminant through (SSOT: Rust `AuthReadiness::derive`).
 * @param auth - Raw auth status from the backend.
 */
export function authStatusToProjectStatus(auth: AuthStatusResponse): AuthReadiness {
  if (auth.status) return auth.status;
  if (!auth.provider_configured) return 'no_provider';
  if (!auth.needs_anthropic_auth || auth.api_key_configured || auth.oauth_authenticated) {
    return 'ready';
  }
  return 'auth_required';
}

/** SSOT for project lifecycle state (switching, adding, container lifecycle, reconcile). */
@Injectable({ providedIn: 'root' })
export class ProjectStateService {
  readonly activeProject = signal<string | null>(null);
  targetProject: string | null = null;
  /** All configured projects from `~/.speedwave/config.json`. */
  projects: ProjectEntry[] = [];
  readonly status = signal<ProjectStatus>('loading');
  error = '';
  needsRestart = false;
  restarting = false;
  restartInFlight: Promise<void> | null = null;
  restartError = '';
  /** Restart requested while status was pre-ready; surfaced once we settle. */
  private pendingRestartOnSettle = false;
  private restartOwedTo: string | null = null;
  private switchesStarted = 0;

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
  private restartFailedListeners: Array<() => void> = [];
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
   * Fires on container-restart completion (distinct from plain ready) so the chat layer resumes
   * the live session across a model switch. Returns unsubscribe.
   * @param cb - The callback to invoke on restart completion.
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

  /**
   * Subscribe to a container restart that began and failed, so work held for it can go on.
   * @param cb - Listener invoked after the failure; unsubscribe via the returned function.
   */
  onRestartFailed(cb: () => void): () => void {
    this.restartFailedListeners.push(cb);
    return () => {
      this.restartFailedListeners = this.restartFailedListeners.filter((l) => l !== cb);
    };
  }

  /** Awaits all begin-callbacks; a failing pre-restart hook must not block the restart. */
  private async notifyRestartBegin(): Promise<void> {
    for (const cb of this.restartBeginListeners) {
      try {
        await cb();
      } catch {}
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
      this.activeProject.set(result.active_project);
      this.projects = result.projects;

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
        return;
      }
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
    } catch {}
  }

  /** Resolves post-switch status via `get_auth_status` (no_provider vs ready vs auth_required). */
  private async resolveSwitchSucceededStatus(): Promise<void> {
    if (!this.activeProject()) return;
    try {
      const auth = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', {
        project: this.activeProject(),
      });
      this.status.set(authStatusToProjectStatus(auth));
      this.applyPendingRestartOnSettle();
    } catch (err) {
      this.status.set('error');
      this.error = String(err);
    }
    this.notifyChange();
    if (this.status() === 'ready') {
      this.notifyReady();
    } else if (this.status() === 'error') {
      this.notifyFailed(this.error);
    }
    this.notifySettled();
  }

  /** Latch: exactly one container flow at a time (status alone is event-mutable). */
  private ensureInFlight = false;

  /** Checks OS prereqs, then verifies containers are running, starting them if not. */
  async ensureContainersRunning(): Promise<void> {
    if (
      this.ensureInFlight ||
      this.status() === 'system_check' ||
      this.status() === 'checking' ||
      this.status() === 'starting' ||
      this.status() === 'auth_required'
    ) {
      return;
    }
    this.ensureInFlight = true;
    try {
      await this.ensureContainersRunningInner();
    } finally {
      this.ensureInFlight = false;
    }
  }

  /** Body of [ensureContainersRunning]; only the latched wrapper may call it. */
  private async ensureContainersRunningInner(): Promise<void> {
    if (!this.activeProject()) {
      this.status.set('error');
      this.error = 'No active project selected.';
      this.notifyChange();
      return;
    }

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

    this.status.set('checking');
    this.notifyChange();
    try {
      const running = await this.tauri.invoke<boolean>('check_containers_running', {
        project: this.activeProject(),
      });
      if (!running) {
        this.status.set('starting');
        this.notifyChange();
        await this.tauri.invoke('start_containers', { project: this.activeProject() });
      }
      const auth = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', {
        project: this.activeProject(),
      });
      const next = authStatusToProjectStatus(auth);
      if (next === 'ready') {
        await this.waitForSystemHealthy();
      }
      this.status.set(next);
      this.applyPendingRestartOnSettle();
    } catch (err) {
      const msg = String(err);
      if (msg.startsWith('System check failed:')) {
        this.status.set('check_failed');
        this.errorKind = undefined;
      } else if (msg.startsWith(CLOUDSTORAGE_TCC_PREFIX)) {
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
          project: this.activeProject(),
        });
        if (!report) return;
        this.healthStore.health.set(report);
        if (report.overall_healthy) return;
        last = report;
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error(unhealthySummary(last));
      }
      await new Promise((resolve) => setTimeout(resolve, this.healthGatePollMs));
    }
  }

  /** Re-checks Claude auth status after user completes authentication. */
  async retryAuth(): Promise<void> {
    if (!this.activeProject()) return;
    try {
      const auth = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', {
        project: this.activeProject(),
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
    if (auth.oauth_sign_in === 'saved_unverified') return;
    const next = authStatusToProjectStatus(auth);
    if (next === 'ready') {
      if (this.status() === 'auth_required' || this.status() === 'no_provider') {
        this.status.set('ready');
        this.applyPendingRestartOnSettle();
        this.notifyChange();
        this.notifyReady();
        this.notifySettled();
      }
      return;
    }
    if (this.status() === 'ready' || this.status() === next) return;
    this.status.set(next);
    this.applyPendingRestartOnSettle();
    this.notifyChange();
  }

  /** Force-sets status to no_provider, skipping the never-downgrade guard. */
  forceUnconfigured(): void {
    this.status.set('no_provider');
    this.applyPendingRestartOnSettle();
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
    try {
      await this.tauri.invoke('retry_bundle_reconcile');
    } catch (err) {
      this.log.warn(`retry_bundle_reconcile failed: ${String(err)}`);
    }
    await this.ensureContainersRunning();
  }

  /** Dismisses the error banner, checking containers first. */
  async dismissError(): Promise<void> {
    try {
      const running = await this.tauri.invoke<boolean>('check_containers_running', {
        project: this.activeProject(),
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
    this.applyPendingRestartOnSettle();
    this.notifyChange();
  }

  /**
   * True while `project` is the active project and no switch runs, so work finishing for it still applies.
   * @param project - the project a late result or a save belongs to
   */
  isSettledOn(project: string | null): boolean {
    return project === this.activeProject() && this.status() !== 'switching';
  }

  /**
   * Marks the moment work for `project` begins: `null` unless the app is settled on it now.
   * @param project - the project the work belongs to
   */
  settledMark(project: string | null): number | null {
    return this.isSettledOn(project) ? this.switchesStarted : null;
  }

  /**
   * True while the app is settled on `project` and no switch has started since `mark` was taken, even one that failed back.
   * @param project - the project the work belongs to
   * @param mark - what `settledMark` returned when the work began
   */
  isStillSettledOn(project: string | null, mark: number | null): boolean {
    return mark === this.switchesStarted && this.isSettledOn(project);
  }

  /**
   * Requests the restart a save of `project` needs, now while the app is settled on it, or once a switch away from it fails back to it.
   * @param project - the project whose saved settings its running containers do not have yet
   */
  requestRestartFor(project: string | null): void {
    if (this.isSettledOn(project)) {
      this.requestRestart();
    } else if (
      project !== null &&
      this.status() === 'switching' &&
      project === this.activeProject()
    ) {
      this.restartOwedTo = project;
    }
  }

  /** Marks that pending changes require a container restart. */
  requestRestart(): void {
    if (this.status() === 'no_provider') {
      void this.ensureContainersRunning();
      return;
    }
    if (this.status() !== 'ready' && this.status() !== 'auth_required') {
      this.pendingRestartOnSettle = true;
      return;
    }
    this.needsRestart = true;
    this.notifyChange();
  }

  /** Promotes a deferred restart request to a live needsRestart once ready. */
  private applyPendingRestartOnSettle(): void {
    if (!this.pendingRestartOnSettle) return;
    if (this.status() === 'no_provider') {
      this.pendingRestartOnSettle = false;
      return;
    }
    if (this.status() === 'ready' || this.status() === 'auth_required') {
      this.pendingRestartOnSettle = false;
      this.needsRestart = true;
    }
  }

  /**
   * Registers a status re-fetcher; the integrations component uses this so that on a failed
   * enable (build/restart) the row visibly reverts to reflect the backend's rollback.
   * @param cb - The refresher callback to register.
   */
  registerIntegrationStatusRefresher(cb: () => void): () => void {
    this.statusRefreshers.push(cb);
    return () => {
      this.statusRefreshers = this.statusRefreshers.filter((l) => l !== cb);
    };
  }

  /**
   * Restarts integration containers; backend rebuilds missing worker images.
   * @returns `skipped` when it never ran (no project, one already in flight, so `restartError` still belongs to an older attempt), else whether it succeeded.
   */
  async restartContainers(): Promise<RestartOutcome> {
    if (!this.activeProject() || this.restarting) return 'skipped';
    const project = this.activeProject();
    const justEnabled = this.pendingJustEnabled;
    this.restarting = true;
    this.restartError = '';
    this.notifyChange();
    const run = this.runRestart(project, justEnabled);
    const done = run.then(
      () => undefined,
      () => undefined
    );
    this.restartInFlight = done;
    try {
      return await run;
    } finally {
      if (this.restartInFlight === done) this.restartInFlight = null;
    }
  }

  private async runRestart(
    project: string | null,
    justEnabled: string | null
  ): Promise<RestartOutcome> {
    let restartedOk = false;
    try {
      await this.notifyRestartBegin();
      await this.tauri.invoke('restart_integration_containers', { project, justEnabled });
      this.needsRestart = false;
      restartedOk = true;
      try {
        await this.tauri.invoke('invalidate_slash_cache', { projectId: project });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`[ProjectStateService] invalidate_slash_cache failed: ${msg}`);
      }
    } catch (e: unknown) {
      this.restartError = e instanceof Error ? e.message : String(e);
      for (const cb of this.statusRefreshers) cb();
    }

    this.restarting = false;
    this.pendingJustEnabled = null;
    this.notifyChange();
    if (restartedOk) {
      if (this.status() === 'auth_required') await this.retryAuth();
      this.notifyReady();
      this.notifySettled();
      this.notifyRestartComplete();
    } else {
      for (const cb of this.restartFailedListeners) cb();
    }
    return restartedOk ? 'restarted' : 'failed';
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
   * @param dir - The project directory path.
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
        this.switchesStarted += 1;
        this.targetProject = event.payload.project;
        this.status.set('switching');
        this.error = '';
        this.errorKind = undefined;
        this.failureProvider = undefined;
        this.failureProjectDir = undefined;
        if (this.needsRestart || this.pendingRestartOnSettle) {
          this.restartOwedTo = this.activeProject();
        }
        this.needsRestart = false;
        this.pendingRestartOnSettle = false;
        this.restarting = false;
        this.restartError = '';
        this.notifyChange();
      });

      await this.tauri.listen<{ project: string }>('project_switch_succeeded', (event) => {
        this.activeProject.set(event.payload.project);
        this.targetProject = null;
        this.restartOwedTo = null;
        this.error = '';
        void this.resolveSwitchSucceededStatus();
        void this.refreshProjectList();
      });

      await this.tauri.listen<ProjectSwitchFailedPayload>('project_switch_failed', (event) => {
        this.activeProject.set(event.payload.project);
        this.targetProject = null;
        if (this.restartOwedTo === event.payload.project) this.pendingRestartOnSettle = true;
        this.restartOwedTo = null;
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
        if (
          this.status() === 'switching' ||
          this.status() === 'starting' ||
          this.status() === 'checking' ||
          this.status() === 'system_check' ||
          this.status() === 'check_failed' ||
          this.status() === 'loading' ||
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
          if (this.status() === 'rebuilding') {
            this.ensureContainersRunning();
          }
        }
      });
    } catch {}
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
