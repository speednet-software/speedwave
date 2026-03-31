import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ProjectStateService } from './project-state.service';
import { TauriService } from './tauri.service';
import { MockTauriService, MOCK_BUNDLE_RECONCILE_DONE } from '../testing/mock-tauri.service';

describe('ProjectStateService', () => {
  let service: ProjectStateService;
  let mockTauri: MockTauriService;

  beforeEach(() => {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_projects':
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        case 'get_bundle_reconcile_state':
          return MOCK_BUNDLE_RECONCILE_DONE;
        case 'run_system_check':
          return undefined;
        case 'check_containers_running':
          return true;
        case 'start_containers':
          return undefined;
        case 'get_auth_status':
          return { api_key_configured: false, oauth_authenticated: true };
        default:
          return undefined;
      }
    };

    TestBed.configureTestingModule({
      providers: [ProjectStateService, { provide: TauriService, useValue: mockTauri }],
    });
    service = TestBed.inject(ProjectStateService);
  });

  describe('init', () => {
    it('loads active project and sets status to ready', async () => {
      await service.init();

      expect(service.activeProject).toBe('test');
      expect(service.status).toBe('ready');
    });

    it('is idempotent — second call is no-op', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      await service.init();
      const firstCount = spy.mock.calls.length;
      await service.init();
      expect(spy.mock.calls.length).toBe(firstCount);
    });

    it('stays loading when Tauri is not available', async () => {
      mockTauri.invokeHandler = async () => {
        throw new Error('not in Tauri');
      };

      await service.init();

      expect(service.status).toBe('loading');
    });

    it('registers listeners even when invoke fails', async () => {
      mockTauri.invokeHandler = async () => {
        throw new Error('not in Tauri');
      };

      await service.init();

      // Listeners should still work
      mockTauri.dispatchEvent('project_switch_started', { project: 'new' });
      expect(service.status).toBe('switching');
    });
  });

  describe('ensureContainersRunning', () => {
    it('sets checking then ready when containers already running', async () => {
      await service.init();
      const statuses: string[] = [];
      service.onChange(() => statuses.push(service.status));

      await service.ensureContainersRunning();

      expect(statuses).toContain('checking');
      expect(service.status).toBe('ready');
    });

    it('sets checking then starting then ready when containers not running', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
            return undefined;
          case 'check_containers_running':
            return false;
          case 'start_containers':
            return undefined;
          case 'get_auth_status':
            return { api_key_configured: false, oauth_authenticated: true };
          default:
            return undefined;
        }
      };
      await service.init();
      service.status = 'ready' as const;

      const statuses: string[] = [];
      service.onChange(() => statuses.push(service.status));

      await service.ensureContainersRunning();

      expect(statuses).toContain('checking');
      expect(statuses).toContain('starting');
      expect(service.status).toBe('ready');
    });

    it('sets error on failure', async () => {
      await service.init();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'run_system_check') return undefined;
        if (cmd === 'check_containers_running') throw new Error('connection refused');
        return undefined;
      };

      await service.ensureContainersRunning();

      expect(service.status).toBe('error');
      expect(service.error).toContain('connection refused');
    });

    it('sets error when no active project', async () => {
      service.activeProject = null;

      await service.ensureContainersRunning();

      expect(service.status).toBe('error');
      expect(service.error).toContain('No active project');
    });

    it('sets system_check status during prereq phase', async () => {
      await service.init();
      const statuses: string[] = [];
      service.onChange(() => statuses.push(service.status));

      await service.ensureContainersRunning();

      expect(statuses).toContain('system_check');
    });

    it('sets check_failed when run_system_check throws', async () => {
      await service.init();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'run_system_check') throw new Error('WSL2 is not available');
        return undefined;
      };

      await service.ensureContainersRunning();

      expect(service.status).toBe('check_failed');
      expect(service.error).toContain('WSL2 is not available');
    });

    it('guard prevents reentry when status is system_check', async () => {
      await service.init();
      service.status = 'system_check';
      const spy = vi.spyOn(mockTauri, 'invoke');
      const callsBefore = spy.mock.calls.length;

      await service.ensureContainersRunning();

      expect(spy.mock.calls.length).toBe(callsBefore);
      expect(service.status).toBe('system_check');
    });

    it('proceeds to checking after successful system check', async () => {
      await service.init();
      const statuses: string[] = [];
      service.onChange(() => statuses.push(service.status));

      await service.ensureContainersRunning();

      const systemCheckIdx = statuses.indexOf('system_check');
      const checkingIdx = statuses.indexOf('checking');
      expect(systemCheckIdx).toBeGreaterThanOrEqual(0);
      expect(checkingIdx).toBeGreaterThan(systemCheckIdx);
    });

    it('sets check_failed on security failure prefix', async () => {
      await service.init();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'run_system_check') return undefined;
        if (cmd === 'check_containers_running') throw 'System check failed: cap_drop ALL missing';
        return undefined;
      };

      await service.ensureContainersRunning();

      expect(service.status).toBe('check_failed');
      expect(service.error).toContain('System check failed:');
    });

    it('sets dismissable error on runtime failure', async () => {
      await service.init();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'run_system_check') return undefined;
        if (cmd === 'check_containers_running') throw new Error('network timeout');
        return undefined;
      };

      await service.ensureContainersRunning();

      expect(service.status).toBe('error');
      expect(service.error).toContain('network timeout');
    });
  });

  describe('reconcile status', () => {
    it('sets rebuilding when reconcile in_progress', async () => {
      await service.init();
      service.status = 'ready';

      mockTauri.dispatchEvent('bundle_reconcile_status', {
        phase: 'images_built',
        in_progress: true,
        last_error: null,
        pending_running_projects: [],
        applied_bundle_id: null,
      });

      expect(service.status).toBe('rebuilding');
    });

    it('sets error when reconcile has last_error', async () => {
      await service.init();
      service.status = 'ready';

      mockTauri.dispatchEvent('bundle_reconcile_status', {
        phase: 'images_built',
        in_progress: false,
        last_error: 'Image rebuild failed',
        pending_running_projects: [],
        applied_bundle_id: null,
      });

      expect(service.status).toBe('error');
      expect(service.error).toBe('Image rebuild failed');
    });

    it('triggers ensureContainersRunning when reconcile completes from rebuilding', async () => {
      await service.init();
      service.status = 'rebuilding';

      const spy = vi.spyOn(service, 'ensureContainersRunning').mockResolvedValue();

      mockTauri.dispatchEvent('bundle_reconcile_status', {
        phase: 'done',
        in_progress: false,
        last_error: null,
        pending_running_projects: [],
        applied_bundle_id: 'new-bundle',
      });

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('ignores reconcile events during switching', async () => {
      await service.init();
      mockTauri.dispatchEvent('project_switch_started', { project: 'new' });
      expect(service.status).toBe('switching');

      mockTauri.dispatchEvent('bundle_reconcile_status', {
        phase: 'images_built',
        in_progress: true,
        last_error: null,
        pending_running_projects: [],
        applied_bundle_id: null,
      });

      expect(service.status).toBe('switching');
    });

    it('starts in rebuilding when init sees in_progress reconcile', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return {
              phase: 'pending',
              in_progress: true,
              last_error: null,
              pending_running_projects: [],
              applied_bundle_id: null,
            };
          default:
            return undefined;
        }
      };

      await service.init();

      expect(service.status).toBe('rebuilding');
    });
  });

  describe('event handling', () => {
    beforeEach(async () => {
      await service.init();
    });

    it('project_switch_started sets switching state', () => {
      mockTauri.dispatchEvent('project_switch_started', { project: 'new-project' });

      expect(service.status).toBe('switching');
      expect(service.targetProject).toBe('new-project');
      expect(service.error).toBe('');
    });

    it('project_switch_succeeded sets ready state', () => {
      mockTauri.dispatchEvent('project_switch_started', { project: 'new-project' });
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'new-project' });

      expect(service.status).toBe('ready');
      expect(service.activeProject).toBe('new-project');
      expect(service.targetProject).toBeNull();
      expect(service.error).toBe('');
    });

    it('project_switch_failed sets error state with rollback', () => {
      mockTauri.dispatchEvent('project_switch_started', { project: 'new-project' });
      mockTauri.dispatchEvent('project_switch_failed', {
        project: 'old-project',
        error: 'container crash',
      });

      expect(service.status).toBe('error');
      expect(service.activeProject).toBe('old-project');
      expect(service.targetProject).toBeNull();
      expect(service.error).toBe('container crash');
    });

    it('project_switch_failed handles null rollback project', () => {
      mockTauri.dispatchEvent('project_switch_failed', {
        project: null,
        error: 'no previous project',
      });

      expect(service.status).toBe('error');
      expect(service.activeProject).toBeNull();
    });
  });

  describe('onChange', () => {
    it('notifies on every state transition', async () => {
      await service.init();
      const cb = vi.fn();
      service.onChange(cb);

      mockTauri.dispatchEvent('project_switch_started', { project: 'p' });
      expect(cb).toHaveBeenCalledTimes(1);

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'p' });
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it('returns working unsubscribe function', async () => {
      await service.init();
      const cb = vi.fn();
      const unsub = service.onChange(cb);
      unsub();

      mockTauri.dispatchEvent('project_switch_started', { project: 'p' });
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('onProjectReady', () => {
    it('fires only on succeeded, not on started or failed', async () => {
      await service.init();
      const cb = vi.fn();
      service.onProjectReady(cb);

      mockTauri.dispatchEvent('project_switch_started', { project: 'p' });
      expect(cb).not.toHaveBeenCalled();

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'p' });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('returns working unsubscribe', async () => {
      await service.init();
      const cb = vi.fn();
      const unsub = service.onProjectReady(cb);
      unsub();

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'p' });
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('onProjectFailed', () => {
    it('fires with error string on failure', async () => {
      await service.init();
      const cb = vi.fn();
      service.onProjectFailed(cb);

      mockTauri.dispatchEvent('project_switch_failed', {
        project: 'old',
        error: 'boom',
      });
      expect(cb).toHaveBeenCalledWith('boom');
    });
  });

  describe('onProjectSettled', () => {
    it('fires on both succeeded and failed', async () => {
      await service.init();
      const cb = vi.fn();
      service.onProjectSettled(cb);

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'p' });
      expect(cb).toHaveBeenCalledTimes(1);

      mockTauri.dispatchEvent('project_switch_failed', {
        project: 'p',
        error: 'fail',
      });
      expect(cb).toHaveBeenCalledTimes(2);
    });
  });

  describe('dismissError', () => {
    it('sets ready when containers are running', async () => {
      service.status = 'error';
      service.error = 'some error';
      await service.dismissError();
      expect(service.status).toBe('ready');
      expect(service.error).toBe('');
    });

    it('updates error when containers are not running', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'check_containers_running') return false;
        return undefined;
      };
      service.status = 'error';
      service.error = 'old error';
      service.activeProject = 'test';
      await service.dismissError();
      expect(service.error).toContain('Containers are not running');
    });

    it('dismisses on check failure', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'check_containers_running') throw new Error('timeout');
        return undefined;
      };
      service.status = 'error';
      service.error = 'some error';
      await service.dismissError();
      expect(service.status).toBe('ready');
      expect(service.error).toBe('');
    });
  });

  describe('ensureContainersRunning error handling', () => {
    it('catches errors from ensureContainersRunning after reconcile done', async () => {
      await service.init();
      service.status = 'rebuilding';

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'run_system_check') return undefined;
        if (cmd === 'check_containers_running') throw new Error('check failed');
        return undefined;
      };

      mockTauri.dispatchEvent('bundle_reconcile_status', {
        phase: 'done',
        in_progress: false,
        last_error: null,
        pending_running_projects: [],
        applied_bundle_id: 'new-bundle',
      });

      // Wait for the async error handling
      await new Promise((r) => setTimeout(r, 20));
      expect(service.status).toBe('error');
      expect(service.error).toContain('check failed');
    });

    it('clears error when retrying', async () => {
      service.activeProject = 'test';
      service.error = 'previous error';
      const statuses: string[] = [];
      service.onChange(() => statuses.push(service.status));
      await service.ensureContainersRunning();
      expect(service.error).toBe('');
      expect(statuses[0]).toBe('system_check');
    });
  });

  describe('switchProject', () => {
    it('invokes the backend switch_project command', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      await service.switchProject('alpha');
      expect(spy).toHaveBeenCalledWith('switch_project', { name: 'alpha' });
    });
  });

  describe('addProject', () => {
    it('invokes the backend add_project command', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      await service.addProject('beta', '/tmp/beta');
      expect(spy).toHaveBeenCalledWith('add_project', { name: 'beta', dir: '/tmp/beta' });
    });
  });

  describe('auth gate', () => {
    it('transitions to auth_required when Claude is not authenticated', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return { api_key_configured: false, oauth_authenticated: false };
          default:
            return undefined;
        }
      };
      await service.init();
      expect(service.status).toBe('auth_required');
    });

    it('transitions to ready when OAuth is authenticated', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return { api_key_configured: false, oauth_authenticated: true };
          default:
            return undefined;
        }
      };
      await service.init();
      expect(service.status).toBe('ready');
    });

    it('transitions to ready when API key is configured', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return { api_key_configured: true, oauth_authenticated: false };
          default:
            return undefined;
        }
      };
      await service.init();
      expect(service.status).toBe('ready');
    });

    it('sets error when get_auth_status throws', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            throw new Error('container not ready');
          default:
            return undefined;
        }
      };
      await service.init();
      expect(service.status).toBe('error');
    });

    it('retryAuth transitions to ready when auth succeeds', async () => {
      let authed = false;
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return { api_key_configured: false, oauth_authenticated: authed };
          default:
            return undefined;
        }
      };
      await service.init();
      expect(service.status).toBe('auth_required');

      authed = true;
      await service.retryAuth();
      expect(service.status).toBe('ready');
    });

    it('retryAuth stays in auth_required when auth check fails', async () => {
      service.activeProject = 'test';
      service.status = 'auth_required';

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_auth_status') throw new Error('connection refused');
        return undefined;
      };

      await service.retryAuth();
      expect(service.status).toBe('auth_required');
    });

    it('retryAuth sets auth_required when no auth configured', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'get_auth_status':
            return { api_key_configured: false, oauth_authenticated: false };
          default:
            return undefined;
        }
      };
      service.activeProject = 'test';
      service.status = 'ready';

      await service.retryAuth();
      expect(service.status).toBe('auth_required');
    });

    it('applyAuthStatus sets ready when auth is valid', () => {
      service.status = 'auth_required';
      service.applyAuthStatus({ api_key_configured: true, oauth_authenticated: false });
      expect(service.status).toBe('ready');
    });

    it('applyAuthStatus sets auth_required when no auth', () => {
      service.status = 'ready';
      service.applyAuthStatus({ api_key_configured: false, oauth_authenticated: false });
      expect(service.status).toBe('auth_required');
    });

    it('applyAuthStatus does not downgrade ready to ready', () => {
      service.status = 'ready';
      const cb = vi.fn();
      service.onChange(cb);
      service.applyAuthStatus({ api_key_configured: true, oauth_authenticated: false });
      expect(service.status).toBe('ready');
      expect(cb).not.toHaveBeenCalled();
    });

    it('does not fire onProjectReady for auth_required', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return { api_key_configured: false, oauth_authenticated: false };
          default:
            return undefined;
        }
      };
      const cb = vi.fn();
      service.onProjectReady(cb);
      await service.init();
      expect(service.status).toBe('auth_required');
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('restart state', () => {
    beforeEach(async () => {
      await service.init();
    });

    it('requestRestart sets needsRestart and notifies', () => {
      const cb = vi.fn();
      service.onChange(cb);

      service.requestRestart();

      expect(service.needsRestart).toBe(true);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('multiple requestRestart calls are idempotent', () => {
      service.requestRestart();
      service.requestRestart();
      service.requestRestart();

      expect(service.needsRestart).toBe(true);
    });

    it('restartContainers invokes Tauri command and clears needsRestart', async () => {
      service.requestRestart();
      const spy = vi.spyOn(mockTauri, 'invoke');

      await service.restartContainers();

      expect(spy).toHaveBeenCalledWith('restart_integration_containers', { project: 'test' });
      expect(service.needsRestart).toBe(false);
      expect(service.restarting).toBe(false);
      expect(service.restartError).toBe('');
    });

    it('restartContainers fires notifyChange at each state transition', async () => {
      service.requestRestart();
      const states: Array<{ restarting: boolean; needsRestart: boolean }> = [];
      service.onChange(() => {
        states.push({ restarting: service.restarting, needsRestart: service.needsRestart });
      });

      let resolveInvoke!: () => void;
      mockTauri.invokeHandler = (cmd: string) => {
        if (cmd === 'restart_integration_containers') {
          return new Promise<void>((resolve) => {
            resolveInvoke = resolve;
          });
        }
        return Promise.resolve(undefined);
      };

      const promise = service.restartContainers();

      expect(states).toHaveLength(1);
      expect(states[0]).toEqual({ restarting: true, needsRestart: true });

      resolveInvoke();
      await promise;

      expect(states).toHaveLength(2);
      expect(states[1]).toEqual({ restarting: false, needsRestart: false });
    });

    it('restartContainers sets restartError on failure', async () => {
      service.requestRestart();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'restart_integration_containers') throw new Error('compose failed');
        return undefined;
      };

      await service.restartContainers();

      expect(service.restartError).toBe('compose failed');
      expect(service.restarting).toBe(false);
      expect(service.needsRestart).toBe(true);
    });

    it('restartContainers recovers after previous failure', async () => {
      service.requestRestart();
      let shouldFail = true;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'restart_integration_containers') {
          if (shouldFail) throw new Error('first attempt failed');
          return undefined;
        }
        return undefined;
      };

      await service.restartContainers();
      expect(service.restartError).toBe('first attempt failed');

      shouldFail = false;
      await service.restartContainers();
      expect(service.restartError).toBe('');
      expect(service.needsRestart).toBe(false);
    });

    it('restartContainers is no-op when already restarting', async () => {
      service.requestRestart();
      service.restarting = true;
      const spy = vi.spyOn(mockTauri, 'invoke');
      const callsBefore = spy.mock.calls.length;

      await service.restartContainers();

      expect(spy.mock.calls.length).toBe(callsBefore);
    });

    it('restartContainers is no-op when no active project', async () => {
      service.activeProject = null;
      service.requestRestart();
      const spy = vi.spyOn(mockTauri, 'invoke');
      const callsBefore = spy.mock.calls.length;

      await service.restartContainers();

      expect(spy.mock.calls.length).toBe(callsBefore);
    });

    it('dismissRestart does not affect restarting flag', () => {
      service.needsRestart = true;
      service.restarting = true;

      service.dismissRestart();

      expect(service.restarting).toBe(true);
      expect(service.needsRestart).toBe(false);
    });

    it('dismissRestart clears needsRestart and restartError', () => {
      service.needsRestart = true;
      service.restartError = 'some error';
      const cb = vi.fn();
      service.onChange(cb);

      service.dismissRestart();

      expect(service.needsRestart).toBe(false);
      expect(service.restartError).toBe('');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('project switch clears restart state', () => {
      service.needsRestart = true;
      service.restarting = true;
      service.restartError = 'error';

      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });

      expect(service.needsRestart).toBe(false);
      expect(service.restarting).toBe(false);
      expect(service.restartError).toBe('');
    });
  });
});
