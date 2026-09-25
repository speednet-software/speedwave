import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  ProjectStateService,
  unhealthySummary,
  authStatusToProjectStatus,
  type AuthStatusResponse,
} from './project-state.service';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import { MockTauriService, MOCK_BUNDLE_RECONCILE_DONE } from '../testing/mock-tauri.service';
import { createDeferred } from '../testing/deferred';
import { HealthStoreService } from './health-store.service';
import type { HealthReport } from '../models/health';
import { makeMockLogger } from '../testing/mock-logger';

function makeHealth(overrides: Partial<HealthReport>): HealthReport {
  return {
    containers: [{ name: 'claude', status: 'running', healthy: true }],
    vm: { running: true, vm_type: 'lima' },
    mcp_os: { running: true },
    ide_bridge: { running: true, port: null, ws_url: null, detected_ides: [], selected_ide: null },
    overall_healthy: true,
    ...overrides,
  };
}

describe('ProjectStateService', () => {
  let service: ProjectStateService;
  let mockTauri: MockTauriService;
  let mockLogger: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    mockTauri = new MockTauriService();
    mockLogger = makeMockLogger();
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
          return {
            api_key_configured: false,
            oauth_authenticated: true,
            needs_anthropic_auth: true,
            provider_configured: true,
          };
        default:
          return undefined;
      }
    };

    TestBed.configureTestingModule({
      providers: [
        ProjectStateService,
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });
    service = TestBed.inject(ProjectStateService);
  });

  describe('init', () => {
    it('loads active project and sets status to ready', async () => {
      await service.init();

      expect(service.activeProject()).toBe('test');
      expect(service.status()).toBe('ready');
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

      expect(service.status()).toBe('loading');
    });

    it('registers listeners even when invoke fails', async () => {
      mockTauri.invokeHandler = async () => {
        throw new Error('not in Tauri');
      };

      await service.init();

      mockTauri.dispatchEvent('project_switch_started', { project: 'new' });
      expect(service.status()).toBe('switching');
    });

    it('sets status=error and logs when invoke fails INSIDE Tauri', async () => {
      mockTauri.runningInTauri = true;
      mockTauri.invokeHandler = async () => {
        throw new Error('list_projects boom');
      };

      await service.init();

      expect(service.status()).toBe('error');
      expect(service.error).toContain('list_projects boom');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('init failed: list_projects boom')
      );
    });

    it('stays silent (no error status, no log) when invoke fails OUTSIDE Tauri', async () => {
      mockTauri.runningInTauri = false;
      mockTauri.invokeHandler = async () => {
        throw new Error('not in Tauri');
      };

      await service.init();

      expect(service.status()).toBe('loading');
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('ensureContainersRunning', () => {
    it('sets checking then ready when containers already running', async () => {
      await service.init();
      const statuses: string[] = [];
      service.onChange(() => statuses.push(service.status()));

      await service.ensureContainersRunning();

      expect(statuses).toContain('checking');
      expect(service.status()).toBe('ready');
    });

    it('reaches ready for a non-anthropic provider with no anthropic auth (needs_anthropic_auth=false)', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
          case 'start_containers':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return {
              api_key_configured: false,
              oauth_authenticated: false,
              needs_anthropic_auth: false,
              provider_configured: true,
            };
          default:
            return undefined;
        }
      };
      await service.init();

      await service.ensureContainersRunning();

      expect(service.status()).toBe('ready');
    });

    it('ensureContainersRunning sets no_provider when provider_configured=false (logout)', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
          case 'start_containers':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return {
              api_key_configured: true,
              oauth_authenticated: true,
              needs_anthropic_auth: false,
              provider_configured: false,
            };
          default:
            return undefined;
        }
      };
      await service.init();

      await service.ensureContainersRunning();

      expect(service.status()).toBe('no_provider');
    });

    it('still requires anthropic auth when needs_anthropic_auth=true and neither credential present', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
          case 'start_containers':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return {
              api_key_configured: false,
              oauth_authenticated: false,
              needs_anthropic_auth: true,
              provider_configured: true,
            };
          default:
            return undefined;
        }
      };
      await service.init();

      await service.ensureContainersRunning();

      expect(service.status()).toBe('auth_required');
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
            return {
              api_key_configured: false,
              oauth_authenticated: true,
              needs_anthropic_auth: true,
              provider_configured: true,
            };
          default:
            return undefined;
        }
      };
      await service.init();
      service.status.set('ready');

      const statuses: string[] = [];
      service.onChange(() => statuses.push(service.status()));

      await service.ensureContainersRunning();

      expect(statuses).toContain('checking');
      expect(statuses).toContain('starting');
      expect(service.status()).toBe('ready');
    });

    it('sets error on failure', async () => {
      await service.init();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'run_system_check') return undefined;
        if (cmd === 'check_containers_running') throw new Error('connection refused');
        return undefined;
      };

      await service.ensureContainersRunning();

      expect(service.status()).toBe('error');
      expect(service.error).toContain('connection refused');
    });

    it('sets error when no active project', async () => {
      service.activeProject.set(null);

      await service.ensureContainersRunning();

      expect(service.status()).toBe('error');
      expect(service.error).toContain('No active project');
    });

    it('holds the overlay until get_health reports overall_healthy', async () => {
      let healthCalls = 0;
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
          case 'start_containers':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return {
              api_key_configured: false,
              oauth_authenticated: true,
              needs_anthropic_auth: true,
              provider_configured: true,
            };
          case 'get_health':
            healthCalls += 1;
            return healthCalls < 3 ? makeHealth({ overall_healthy: false }) : makeHealth({});
          default:
            return undefined;
        }
      };
      service.healthGatePollMs = 1;
      await service.init();

      expect(service.status()).toBe('ready');
      expect(healthCalls).toBe(3);
    });

    it('sets error with an unhealthy summary when the health gate times out', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
          case 'start_containers':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return {
              api_key_configured: false,
              oauth_authenticated: true,
              needs_anthropic_auth: true,
              provider_configured: true,
            };
          case 'get_health':
            return makeHealth({
              overall_healthy: false,
              vm: { running: false, vm_type: 'lima' },
            });
          default:
            return undefined;
        }
      };
      service.healthGatePollMs = 1;
      service.healthGateTimeoutMs = 5;
      await service.init();

      expect(service.status()).toBe('error');
      expect(service.error).toContain('System did not become healthy');
      expect(service.error).toContain('VM not running');
    });

    it('passes the health gate when get_health returns no report', async () => {
      await service.init();

      expect(service.status()).toBe('ready');
    });

    it('seeds the shared health store with the gate snapshot', async () => {
      const healthy = makeHealth({});
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
          case 'start_containers':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return {
              api_key_configured: false,
              oauth_authenticated: true,
              needs_anthropic_auth: true,
              provider_configured: true,
            };
          case 'get_health':
            return healthy;
          default:
            return undefined;
        }
      };
      await service.init();

      expect(service.status()).toBe('ready');
      expect(TestBed.inject(HealthStoreService).health()).toEqual(healthy);
    });

    it('keeps polling through transient get_health failures', async () => {
      let healthCalls = 0;
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
          case 'start_containers':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return {
              api_key_configured: false,
              oauth_authenticated: true,
              needs_anthropic_auth: true,
              provider_configured: true,
            };
          case 'get_health':
            healthCalls += 1;
            if (healthCalls === 1) throw new Error('probe boom');
            return makeHealth({});
          default:
            return undefined;
        }
      };
      service.healthGatePollMs = 1;
      await service.init();

      expect(service.status()).toBe('ready');
      expect(healthCalls).toBe(2);
    });

    it('sets system_check status during prereq phase', async () => {
      await service.init();
      const statuses: string[] = [];
      service.onChange(() => statuses.push(service.status()));

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

      expect(service.status()).toBe('check_failed');
      expect(service.error).toContain('WSL2 is not available');
    });

    it('guard prevents reentry when status is system_check', async () => {
      await service.init();
      service.status.set('system_check');
      const spy = vi.spyOn(mockTauri, 'invoke');
      const callsBefore = spy.mock.calls.length;

      await service.ensureContainersRunning();

      expect(spy.mock.calls.length).toBe(callsBefore);
      expect(service.status()).toBe('system_check');
    });

    it('proceeds to checking after successful system check', async () => {
      await service.init();
      const statuses: string[] = [];
      service.onChange(() => statuses.push(service.status()));

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

      expect(service.status()).toBe('check_failed');
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

      expect(service.status()).toBe('error');
      expect(service.error).toContain('network timeout');
    });
  });

  describe('requestRestart', () => {
    it('flags a restart when the project is already running', () => {
      service.status.set('ready');
      const ensureSpy = vi.spyOn(service, 'ensureContainersRunning').mockResolvedValue();

      service.requestRestart();

      expect(service.needsRestart).toBe(true);
      expect(ensureSpy).not.toHaveBeenCalled();
    });

    it('starts containers instead of flagging when the project has no provider', () => {
      service.status.set('no_provider');
      service.needsRestart = false;
      const ensureSpy = vi.spyOn(service, 'ensureContainersRunning').mockResolvedValue();

      service.requestRestart();

      expect(ensureSpy).toHaveBeenCalled();
      expect(service.needsRestart).toBe(false);
    });

    it('defers a restart requested mid-switch, keeping needsRestart false for now', () => {
      service.status.set('switching');
      service.needsRestart = false;
      const ensureSpy = vi.spyOn(service, 'ensureContainersRunning').mockResolvedValue();

      service.requestRestart();

      expect(service.needsRestart).toBe(false);
      expect(ensureSpy).not.toHaveBeenCalled();
    });

    it('surfaces a restart requested during switching once the switch settles to ready', async () => {
      await service.init();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_auth_status') {
          return {
            api_key_configured: false,
            oauth_authenticated: false,
            needs_anthropic_auth: false,
            provider_configured: true,
          };
        }
        return undefined;
      };
      mockTauri.dispatchEvent('project_switch_started', { project: 'e2e-test' });
      expect(service.status()).toBe('switching');

      service.requestRestart();
      expect(service.needsRestart).toBe(false);

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'e2e-test' });
      await new Promise((r) => setTimeout(r, 0));

      expect(service.status()).toBe('ready');
      expect(service.needsRestart).toBe(true);
    });

    it('clears a deferred restart intent when the switch settles on no_provider', async () => {
      await service.init();
      mockTauri.dispatchEvent('project_switch_started', { project: 'bare' });
      service.requestRestart();
      expect(service.needsRestart).toBe(false);

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_auth_status') {
          return {
            api_key_configured: false,
            oauth_authenticated: false,
            needs_anthropic_auth: false,
            provider_configured: false,
          };
        }
        return undefined;
      };
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'bare' });
      await new Promise((r) => setTimeout(r, 0));

      expect(service.status()).toBe('no_provider');
      expect(service.needsRestart).toBe(false);

      service.applyAuthStatus({
        api_key_configured: true,
        oauth_authenticated: false,
        needs_anthropic_auth: true,
        provider_configured: true,
      });
      expect(service.status()).toBe('ready');
      expect(service.needsRestart).toBe(false);
    });

    it('drops a deferred restart intent when a new switch starts', async () => {
      await service.init();
      service.status.set('switching');
      service.requestRestart();

      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_auth_status') {
          return {
            api_key_configured: false,
            oauth_authenticated: false,
            needs_anthropic_auth: false,
            provider_configured: true,
          };
        }
        return undefined;
      };
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other' });
      await new Promise((r) => setTimeout(r, 0));

      expect(service.status()).toBe('ready');
      expect(service.needsRestart).toBe(false);
    });
  });

  describe('reconcile status', () => {
    it('sets rebuilding when reconcile in_progress', async () => {
      await service.init();
      service.status.set('ready');

      mockTauri.dispatchEvent('bundle_reconcile_status', {
        phase: 'images_built',
        in_progress: true,
        last_error: null,
        pending_running_projects: [],
        applied_bundle_id: null,
      });

      expect(service.status()).toBe('rebuilding');
    });

    it('sets error when reconcile has last_error', async () => {
      await service.init();
      service.status.set('ready');

      mockTauri.dispatchEvent('bundle_reconcile_status', {
        phase: 'images_built',
        in_progress: false,
        last_error: 'Image rebuild failed',
        pending_running_projects: [],
        applied_bundle_id: null,
      });

      expect(service.status()).toBe('error');
      expect(service.error).toBe('Image rebuild failed');
    });

    it('triggers ensureContainersRunning when reconcile completes from rebuilding', async () => {
      await service.init();
      service.status.set('rebuilding');

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

    it('ignores reconcile events while the manual retry flow is in progress', async () => {
      await service.init();
      for (const active of ['loading', 'system_check'] as const) {
        service.status.set(active);
        mockTauri.dispatchEvent('bundle_reconcile_status', {
          phase: 'images_built',
          in_progress: true,
          last_error: null,
          pending_running_projects: [],
          applied_bundle_id: null,
        });
        expect(service.status()).toBe(active);
      }
    });

    it('keeps the blocking system check page when a reconcile failure arrives', async () => {
      await service.init();
      service.status.set('check_failed');
      service.error = 'System check failed: WSL2 is not available';

      mockTauri.dispatchEvent('bundle_reconcile_status', {
        phase: 'done',
        in_progress: false,
        last_error: 'Container engine did not answer the image check',
        pending_running_projects: [],
        applied_bundle_id: 'bundle',
      });

      expect(service.status()).toBe('check_failed');
      expect(service.error).toBe('System check failed: WSL2 is not available');
    });

    it('ignores reconcile events during switching', async () => {
      await service.init();
      mockTauri.dispatchEvent('project_switch_started', { project: 'new' });
      expect(service.status()).toBe('switching');

      mockTauri.dispatchEvent('bundle_reconcile_status', {
        phase: 'images_built',
        in_progress: true,
        last_error: null,
        pending_running_projects: [],
        applied_bundle_id: null,
      });

      expect(service.status()).toBe('switching');
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

      expect(service.status()).toBe('rebuilding');
    });
  });

  describe('event handling', () => {
    beforeEach(async () => {
      await service.init();
    });

    it('project_switch_started sets switching state', () => {
      mockTauri.dispatchEvent('project_switch_started', { project: 'new-project' });

      expect(service.status()).toBe('switching');
      expect(service.targetProject).toBe('new-project');
      expect(service.error).toBe('');
    });

    it('project_switch_succeeded sets ready state', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_auth_status') {
          return {
            api_key_configured: false,
            oauth_authenticated: true,
            needs_anthropic_auth: true,
            provider_configured: true,
          };
        }
        return undefined;
      };
      mockTauri.dispatchEvent('project_switch_started', { project: 'new-project' });
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'new-project' });
      await new Promise((r) => setTimeout(r, 0));

      expect(service.status()).toBe('ready');
      expect(service.activeProject()).toBe('new-project');
      expect(service.targetProject).toBeNull();
      expect(service.error).toBe('');
    });

    it('project_switch_succeeded resolves no_provider when the project has no LLM provider', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_auth_status') {
          return {
            api_key_configured: false,
            oauth_authenticated: false,
            needs_anthropic_auth: false,
            provider_configured: false,
          };
        }
        return undefined;
      };
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'fresh-project' });
      await new Promise((r) => setTimeout(r, 0));

      expect(service.status()).toBe('no_provider');
    });

    it('project_switch_succeeded sets error state when get_auth_status throws', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_auth_status') throw new Error('container not ready');
        return undefined;
      };
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'p' });
      await new Promise((r) => setTimeout(r, 0));

      expect(service.status()).toBe('error');
      expect(service.error).toBe('Error: container not ready');
    });

    it('project_switch_succeeded auth failure fires onProjectFailed + onProjectSettled (parity with other error paths)', async () => {
      const failed = vi.fn();
      const settled = vi.fn();
      service.onProjectFailed(failed);
      service.onProjectSettled(settled);
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_auth_status') throw new Error('container not ready');
        return undefined;
      };

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'p' });
      await new Promise((r) => setTimeout(r, 0));

      expect(service.status()).toBe('error');
      expect(failed).toHaveBeenCalledWith(expect.stringContaining('container not ready'));
      expect(settled).toHaveBeenCalledTimes(1);
    });

    it('project_switch_succeeded honors the backend status discriminant over contradictory flags', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_auth_status') {
          return {
            status: 'no_provider',
            api_key_configured: true,
            oauth_authenticated: true,
            needs_anthropic_auth: false,
            provider_configured: true,
          };
        }
        return undefined;
      };
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'p' });
      await new Promise((r) => setTimeout(r, 0));

      expect(service.status()).toBe('no_provider');
    });

    it('project_switch_failed sets error state with rollback', () => {
      mockTauri.dispatchEvent('project_switch_started', { project: 'new-project' });
      mockTauri.dispatchEvent('project_switch_failed', {
        project: 'old-project',
        error: 'container crash',
      });

      expect(service.status()).toBe('error');
      expect(service.activeProject()).toBe('old-project');
      expect(service.targetProject).toBeNull();
      expect(service.error).toBe('container crash');
    });

    it('project_switch_failed handles null rollback project', () => {
      mockTauri.dispatchEvent('project_switch_failed', {
        project: null,
        error: 'no previous project',
      });

      expect(service.status()).toBe('error');
      expect(service.activeProject()).toBeNull();
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
      await new Promise((r) => setTimeout(r, 0));
      expect(cb).toHaveBeenCalledTimes(3);
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
      await new Promise((r) => setTimeout(r, 0));
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('returns working unsubscribe', async () => {
      await service.init();
      const cb = vi.fn();
      const unsub = service.onProjectReady(cb);
      unsub();

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'p' });
      await new Promise((r) => setTimeout(r, 0));
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
      await new Promise((r) => setTimeout(r, 0));
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
      service.status.set('error');
      service.error = 'some error';
      await service.dismissError();
      expect(service.status()).toBe('ready');
      expect(service.error).toBe('');
    });

    it('updates error when containers are not running', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'check_containers_running') return false;
        return undefined;
      };
      service.status.set('error');
      service.error = 'old error';
      service.activeProject.set('test');
      await service.dismissError();
      expect(service.error).toContain('Containers are not running');
    });

    it('dismisses on check failure', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'check_containers_running') throw new Error('timeout');
        return undefined;
      };
      service.status.set('error');
      service.error = 'some error';
      await service.dismissError();
      expect(service.status()).toBe('ready');
      expect(service.error).toBe('');
    });
  });

  describe('ensureContainersRunning error handling', () => {
    it('catches errors from ensureContainersRunning after reconcile done', async () => {
      await service.init();
      service.status.set('rebuilding');

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

      await new Promise((r) => setTimeout(r, 20));
      expect(service.status()).toBe('error');
      expect(service.error).toContain('check failed');
    });

    it('clears error when retrying', async () => {
      service.activeProject.set('test');
      service.error = 'previous error';
      const statuses: string[] = [];
      service.onChange(() => statuses.push(service.status()));
      await service.ensureContainersRunning();
      expect(service.error).toBe('');
      expect(statuses[0]).toBe('system_check');
    });
  });

  describe('retry', () => {
    it('re-enters the bundle reconcile before restarting the container flow', async () => {
      service.activeProject.set('test');
      const spy = vi.spyOn(mockTauri, 'invoke');
      await service.retry();
      const names = spy.mock.calls.map((c) => c[0]);
      expect(names[0]).toBe('retry_bundle_reconcile');
      expect(names).toContain('run_system_check');
    });

    it('continues the container flow when the reconcile re-entry rejects', async () => {
      service.activeProject.set('test');
      const base = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'retry_bundle_reconcile') throw new Error('gate probe failed');
        return base(cmd, args);
      };
      const spy = vi.spyOn(mockTauri, 'invoke');
      await service.retry();
      expect(spy.mock.calls.map((c) => c[0])).toContain('run_system_check');
    });
  });

  describe('ensure re-entrancy', () => {
    it('runs a single container flow when re-entered from the rebuilding state', async () => {
      service.activeProject.set('test');
      const pendingCheck = createDeferred();
      const base = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'run_system_check') {
          await pendingCheck.promise;
          return undefined;
        }
        return base(cmd, args);
      };
      const spy = vi.spyOn(mockTauri, 'invoke');
      const first = service.ensureContainersRunning();
      await new Promise((r) => setTimeout(r, 0));
      service.status.set('rebuilding');
      const second = service.ensureContainersRunning();
      await new Promise((r) => setTimeout(r, 0));
      pendingCheck.resolve();
      await Promise.all([first, second]);
      expect(spy.mock.calls.filter((c) => c[0] === 'run_system_check')).toHaveLength(1);
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
            return {
              api_key_configured: false,
              oauth_authenticated: false,
              needs_anthropic_auth: true,
              provider_configured: true,
            };
          default:
            return undefined;
        }
      };
      await service.init();
      expect(service.status()).toBe('auth_required');
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
            return {
              api_key_configured: false,
              oauth_authenticated: true,
              needs_anthropic_auth: true,
              provider_configured: true,
            };
          default:
            return undefined;
        }
      };
      await service.init();
      expect(service.status()).toBe('ready');
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
            return {
              api_key_configured: true,
              oauth_authenticated: false,
              needs_anthropic_auth: true,
              provider_configured: true,
            };
          default:
            return undefined;
        }
      };
      await service.init();
      expect(service.status()).toBe('ready');
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
      expect(service.status()).toBe('error');
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
            return {
              api_key_configured: false,
              oauth_authenticated: authed,
              needs_anthropic_auth: true,
              provider_configured: true,
            };
          default:
            return undefined;
        }
      };
      await service.init();
      expect(service.status()).toBe('auth_required');

      authed = true;
      await service.retryAuth();
      expect(service.status()).toBe('ready');
    });

    it('retryAuth sets error (NOT auth_required) and logs when the auth check throws', async () => {
      service.activeProject.set('test');
      service.status.set('auth_required');
      const failed = vi.fn();
      const settled = vi.fn();
      service.onProjectFailed(failed);
      service.onProjectSettled(settled);

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_auth_status') throw new Error('connection refused');
        return undefined;
      };

      await service.retryAuth();

      expect(service.status()).toBe('error');
      expect(service.error).toContain('connection refused');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('retryAuth check failed: connection refused')
      );
      expect(failed).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
      expect(settled).toHaveBeenCalled();
    });

    it('retryAuth sets auth_required when no auth configured', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'get_auth_status':
            return {
              api_key_configured: false,
              oauth_authenticated: false,
              needs_anthropic_auth: true,
              provider_configured: true,
            };
          default:
            return undefined;
        }
      };
      service.activeProject.set('test');
      service.status.set('ready');

      await service.retryAuth();
      expect(service.status()).toBe('auth_required');
    });

    it('retryAuth sets no_provider when provider_configured=false', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'get_auth_status':
            return {
              api_key_configured: false,
              oauth_authenticated: false,
              needs_anthropic_auth: true,
              provider_configured: false,
            };
          default:
            return undefined;
        }
      };
      service.activeProject.set('test');
      service.status.set('ready');

      await service.retryAuth();
      expect(service.status()).toBe('no_provider');
    });

    it('applyAuthStatus sets ready when auth is valid', () => {
      service.status.set('auth_required');
      service.applyAuthStatus({
        api_key_configured: true,
        oauth_authenticated: false,
        needs_anthropic_auth: true,
        provider_configured: true,
      });
      expect(service.status()).toBe('ready');
    });

    it('applyAuthStatus sets auth_required when no auth (from a pre-ready state)', () => {
      service.status.set('starting');
      service.applyAuthStatus({
        api_key_configured: false,
        oauth_authenticated: false,
        needs_anthropic_auth: true,
        provider_configured: true,
      });
      expect(service.status()).toBe('auth_required');
    });

    it('applyAuthStatus never downgrades a live ready session', () => {
      for (const auth of [
        {
          api_key_configured: true,
          oauth_authenticated: true,
          needs_anthropic_auth: false,
          provider_configured: false,
        },
        {
          api_key_configured: false,
          oauth_authenticated: false,
          needs_anthropic_auth: true,
          provider_configured: true,
        },
      ]) {
        service.status.set('ready');
        const cb = vi.fn();
        service.onChange(cb);
        service.applyAuthStatus(auth);
        expect(service.status()).toBe('ready');
        expect(cb).not.toHaveBeenCalled();
      }
    });

    it('applyAuthStatus does not downgrade ready to ready', () => {
      service.status.set('ready');
      const cb = vi.fn();
      service.onChange(cb);
      service.applyAuthStatus({
        api_key_configured: true,
        oauth_authenticated: false,
        needs_anthropic_auth: true,
        provider_configured: true,
      });
      expect(service.status()).toBe('ready');
      expect(cb).not.toHaveBeenCalled();
    });

    it('applyAuthStatus does not re-notify when already auth_required', () => {
      service.status.set('auth_required');
      const cb = vi.fn();
      service.onChange(cb);
      service.applyAuthStatus({
        api_key_configured: false,
        oauth_authenticated: false,
        needs_anthropic_auth: true,
        provider_configured: true,
      });
      expect(service.status()).toBe('auth_required');
      expect(cb).not.toHaveBeenCalled();
    });

    it('applyAuthStatus does not re-notify when already no_provider', () => {
      service.status.set('no_provider');
      const cb = vi.fn();
      service.onChange(cb);
      service.applyAuthStatus({
        api_key_configured: false,
        oauth_authenticated: false,
        needs_anthropic_auth: true,
        provider_configured: false,
      });
      expect(service.status()).toBe('no_provider');
      expect(cb).not.toHaveBeenCalled();
    });

    it('applyAuthStatus notifies once when one pre-ready state replaces another', () => {
      service.status.set('no_provider');
      const cb = vi.fn();
      service.onChange(cb);
      service.applyAuthStatus({
        api_key_configured: false,
        oauth_authenticated: false,
        needs_anthropic_auth: true,
        provider_configured: true,
      });
      expect(service.status()).toBe('auth_required');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('applyAuthStatus sets no_provider when provider_configured=false', () => {
      service.status.set('starting');
      service.applyAuthStatus({
        api_key_configured: true,
        oauth_authenticated: true,
        needs_anthropic_auth: false,
        provider_configured: false,
      });
      expect(service.status()).toBe('no_provider');
    });

    it('applyAuthStatus recovers no_provider to ready once a provider is configured', () => {
      service.status.set('no_provider');
      service.applyAuthStatus({
        api_key_configured: true,
        oauth_authenticated: false,
        needs_anthropic_auth: true,
        provider_configured: true,
      });
      expect(service.status()).toBe('ready');
    });

    it('applyAuthStatus never-downgrade guard also holds for discriminant payloads', () => {
      for (const status of ['no_provider', 'auth_required'] as const) {
        service.status.set('ready');
        const cb = vi.fn();
        service.onChange(cb);
        service.applyAuthStatus({
          status,
          api_key_configured: false,
          oauth_authenticated: false,
          needs_anthropic_auth: true,
          provider_configured: status !== 'no_provider',
        });
        expect(service.status()).toBe('ready');
        expect(cb).not.toHaveBeenCalled();
      }
    });

    it('applyAuthStatus promotes no_provider to ready from a discriminant payload', () => {
      service.status.set('no_provider');
      service.applyAuthStatus({
        status: 'ready',
        api_key_configured: false,
        oauth_authenticated: false,
        needs_anthropic_auth: true,
        provider_configured: true,
      });
      expect(service.status()).toBe('ready');
    });

    it('ensureContainersRunning honors status=ready despite provider_configured=false', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
          case 'start_containers':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return {
              status: 'ready',
              api_key_configured: false,
              oauth_authenticated: false,
              needs_anthropic_auth: true,
              provider_configured: false,
            };
          default:
            return undefined;
        }
      };
      await service.init();

      expect(service.status()).toBe('ready');
    });

    it('ensureContainersRunning honors status=no_provider despite provider_configured=true', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'run_system_check':
          case 'start_containers':
            return undefined;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return {
              status: 'no_provider',
              api_key_configured: true,
              oauth_authenticated: true,
              needs_anthropic_auth: false,
              provider_configured: true,
            };
          default:
            return undefined;
        }
      };
      await service.init();

      expect(service.status()).toBe('no_provider');
    });

    it('forceUnconfigured downgrades a live ready session (deliberate logout)', () => {
      service.status.set('ready');
      const cb = vi.fn();
      service.onChange(cb);
      service.forceUnconfigured();
      expect(service.status()).toBe('no_provider');
      expect(cb).toHaveBeenCalled();
    });

    it('forceUnconfigured sets no_provider from any pre-ready status', () => {
      for (const status of ['auth_required', 'starting', 'checking'] as const) {
        service.status.set(status);
        service.forceUnconfigured();
        expect(service.status()).toBe('no_provider');
      }
    });

    it('forceUnconfigured is idempotent (no_provider to no_provider still notifies)', () => {
      service.status.set('no_provider');
      const cb = vi.fn();
      service.onChange(cb);
      service.forceUnconfigured();
      expect(service.status()).toBe('no_provider');
      expect(cb).toHaveBeenCalled();
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
            return {
              api_key_configured: false,
              oauth_authenticated: false,
              needs_anthropic_auth: true,
              provider_configured: true,
            };
          default:
            return undefined;
        }
      };
      const cb = vi.fn();
      service.onProjectReady(cb);
      await service.init();
      expect(service.status()).toBe('auth_required');
      expect(cb).not.toHaveBeenCalled();
    });

    it('applyAuthStatus with oauth_sign_in saved_unverified leaves status untouched and fires no listeners', () => {
      for (const status of ['auth_required', 'no_provider', 'ready', 'starting'] as const) {
        service.status.set(status);
        const changeCb = vi.fn();
        const readyCb = vi.fn();
        service.onChange(changeCb);
        service.onProjectReady(readyCb);
        service.applyAuthStatus({
          status: 'auth_required',
          oauth_sign_in: 'saved_unverified',
          api_key_configured: false,
          oauth_authenticated: false,
          needs_anthropic_auth: true,
          provider_configured: true,
        });
        expect(service.status()).toBe(status);
        expect(changeCb).not.toHaveBeenCalled();
        expect(readyCb).not.toHaveBeenCalled();
      }
    });

    it('applyAuthStatus promotes auth_required to ready with oauth_sign_in verified', () => {
      service.status.set('auth_required');
      service.applyAuthStatus({
        status: 'ready',
        oauth_sign_in: 'verified',
        api_key_configured: false,
        oauth_authenticated: true,
        needs_anthropic_auth: true,
        provider_configured: true,
      });
      expect(service.status()).toBe('ready');
    });

    it('applyAuthStatus moves no_provider to auth_required with oauth_sign_in none', () => {
      service.status.set('no_provider');
      service.applyAuthStatus({
        status: 'auth_required',
        oauth_sign_in: 'none',
        api_key_configured: false,
        oauth_authenticated: false,
        needs_anthropic_auth: true,
        provider_configured: true,
      });
      expect(service.status()).toBe('auth_required');
    });
  });

  describe('isSettledOn', () => {
    beforeEach(async () => {
      await service.init();
    });

    it('is true for the active project while no switch runs', () => {
      expect(service.activeProject()).toBe('test');
      expect(service.isSettledOn('test')).toBe(true);
    });

    it('is false for any other project, and for none', () => {
      expect(service.isSettledOn('other')).toBe(false);
      expect(service.isSettledOn(null)).toBe(false);
    });

    it('is false for the active project from the moment a switch starts until it lands', () => {
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      expect(service.activeProject()).toBe('test');
      expect(service.isSettledOn('test')).toBe(false);
      expect(service.isSettledOn('other')).toBe(false);

      mockTauri.dispatchEvent('project_switch_failed', { project: 'test', error: 'failed' });
      expect(service.isSettledOn('test')).toBe(true);
    });

    it('is false after a switch lands until its status is resolved', async () => {
      const auth = createDeferred<unknown>();
      mockTauri.invokeHandler = async (cmd: string) =>
        cmd === 'get_auth_status' ? auth.promise : undefined;
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other' });

      expect(service.activeProject()).toBe('other');
      expect(service.isSettledOn('other')).toBe(false);

      auth.resolve({
        api_key_configured: false,
        oauth_authenticated: true,
        needs_anthropic_auth: true,
        provider_configured: true,
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(service.isSettledOn('other')).toBe(true);
    });
  });

  describe('settledMark and isStillSettledOn', () => {
    beforeEach(async () => {
      await service.init();
    });

    it('a mark taken while settled holds until a switch starts', () => {
      const mark = service.settledMark('test');

      expect(mark).not.toBeNull();
      expect(service.isStillSettledOn('test', mark)).toBe(true);

      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      expect(service.isStillSettledOn('test', mark)).toBe(false);
    });

    it('a mark stays spent after a switch that failed back, while a new one holds', () => {
      const before = service.settledMark('test');
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      mockTauri.dispatchEvent('project_switch_failed', { project: 'test', error: 'failed' });

      expect(service.isSettledOn('test')).toBe(true);
      expect(service.isStillSettledOn('test', before)).toBe(false);
      const after = service.settledMark('test');
      expect(service.isStillSettledOn('test', after)).toBe(true);
    });

    it('a mark taken during a switch or for another project never holds', () => {
      expect(service.settledMark('other')).toBeNull();
      expect(service.isStillSettledOn('other', service.settledMark('other'))).toBe(false);

      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      const during = service.settledMark('test');
      mockTauri.dispatchEvent('project_switch_failed', { project: 'test', error: 'failed' });

      expect(during).toBeNull();
      expect(service.isStillSettledOn('test', during)).toBe(false);
    });

    it('a mark holds only for the project it was taken for', () => {
      const mark = service.settledMark('test');

      expect(service.isStillSettledOn('other', mark)).toBe(false);
      expect(service.isStillSettledOn(null, mark)).toBe(false);
    });
  });

  describe('requestRestartFor', () => {
    beforeEach(async () => {
      await service.init();
    });

    it('flags the restart at once while the app is settled on the project', () => {
      service.status.set('ready');

      service.requestRestartFor('test');

      expect(service.needsRestart).toBe(true);
    });

    it('drops a request for a project the app is not on', () => {
      service.status.set('ready');

      service.requestRestartFor('other');

      expect(service.needsRestart).toBe(false);
    });

    it('surfaces a restart owed by a save that lands during a switch once the switch fails back', async () => {
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      service.requestRestartFor('test');
      expect(service.needsRestart).toBe(false);

      mockTauri.dispatchEvent('project_switch_failed', { project: 'test', error: 'failed' });
      await service.retry();

      expect(service.status()).toBe('ready');
      expect(service.needsRestart).toBe(true);
    });

    it('forgets a restart owed to the project a switch left, also when a later switch fails back to it', async () => {
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      service.requestRestartFor('test');
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other' });
      await new Promise((r) => setTimeout(r, 0));
      expect(service.status()).toBe('ready');
      expect(service.needsRestart).toBe(false);

      mockTauri.dispatchEvent('project_switch_started', { project: 'test' });
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'test' });
      await new Promise((r) => setTimeout(r, 0));
      mockTauri.dispatchEvent('project_switch_started', { project: 'third' });
      mockTauri.dispatchEvent('project_switch_failed', { project: 'test', error: 'failed' });
      await service.dismissError();

      expect(service.status()).toBe('ready');
      expect(service.needsRestart).toBe(false);
    });

    it('keeps a restart requested before a switch that fails back', async () => {
      service.status.set('ready');
      service.requestRestart();
      expect(service.needsRestart).toBe(true);

      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      expect(service.needsRestart).toBe(false);
      mockTauri.dispatchEvent('project_switch_failed', { project: 'test', error: 'failed' });
      await service.retry();

      expect(service.needsRestart).toBe(true);
    });

    it('surfaces a restart owed across a failed switch when its error is dismissed', async () => {
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      service.requestRestartFor('test');
      mockTauri.dispatchEvent('project_switch_failed', { project: 'test', error: 'failed' });
      expect(service.status()).toBe('error');

      await service.dismissError();

      expect(service.status()).toBe('ready');
      expect(service.needsRestart).toBe(true);
    });

    it('surfaces a restart owed across a failed switch when the dismiss cannot check the containers', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'check_containers_running') throw new Error('timeout');
        return undefined;
      };
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      service.requestRestartFor('test');
      mockTauri.dispatchEvent('project_switch_failed', { project: 'test', error: 'failed' });

      await service.dismissError();

      expect(service.status()).toBe('ready');
      expect(service.needsRestart).toBe(true);
    });

    it('holds a restart owed across a failed switch while a dismiss finds the containers down', async () => {
      let running = false;
      mockTauri.invokeHandler = async (cmd: string) =>
        cmd === 'check_containers_running' ? running : undefined;
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      service.requestRestartFor('test');
      mockTauri.dispatchEvent('project_switch_failed', { project: 'test', error: 'failed' });

      await service.dismissError();
      expect(service.status()).toBe('error');
      expect(service.needsRestart).toBe(false);

      running = true;
      await service.dismissError();
      expect(service.status()).toBe('ready');
      expect(service.needsRestart).toBe(true);
    });

    it('surfaces a restart owed across a failed switch when a sign-in check finds the project signed out', () => {
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      service.requestRestartFor('test');
      mockTauri.dispatchEvent('project_switch_failed', { project: 'test', error: 'failed' });

      service.applyAuthStatus({
        api_key_configured: false,
        oauth_authenticated: false,
        needs_anthropic_auth: true,
        provider_configured: true,
      });

      expect(service.status()).toBe('auth_required');
      expect(service.needsRestart).toBe(true);
    });

    it('drops a restart owed across a failed switch once a logout leaves the project without a provider', () => {
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      service.requestRestartFor('test');
      mockTauri.dispatchEvent('project_switch_failed', { project: 'test', error: 'failed' });

      service.forceUnconfigured();
      service.applyAuthStatus({
        api_key_configured: false,
        oauth_authenticated: true,
        needs_anthropic_auth: true,
        provider_configured: true,
      });

      expect(service.status()).toBe('ready');
      expect(service.needsRestart).toBe(false);
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

      expect(spy).toHaveBeenCalledWith('restart_integration_containers', {
        project: 'test',
        justEnabled: null,
      });
      expect(service.needsRestart).toBe(false);
      expect(service.restarting).toBe(false);
      expect(service.restartError).toBe('');
    });

    it('restartContainers fires onRestartBegin before the Tauri invoke, and ready before restart-complete', async () => {
      const order: string[] = [];
      service.onRestartBegin(async () => {
        order.push('begin');
      });
      service.onProjectReady(() => {
        order.push('ready');
      });
      service.onRestartComplete(() => {
        order.push('complete');
      });
      vi.spyOn(mockTauri, 'invoke').mockImplementation(async (cmd: string) => {
        if (cmd === 'restart_integration_containers') order.push('invoke');
        return undefined as unknown as never;
      });

      await service.restartContainers();

      expect(order.indexOf('begin')).toBeLessThan(order.indexOf('invoke'));
      expect(order.indexOf('ready')).toBeLessThan(order.indexOf('complete'));
    });

    it('restartContainers runs the restart-failed listeners only when the restart fails', async () => {
      const failed = vi.fn();
      const complete = vi.fn();
      service.onRestartFailed(failed);
      service.onRestartComplete(complete);

      await expect(service.restartContainers()).resolves.toBe('restarted');
      expect(failed).not.toHaveBeenCalled();

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'restart_integration_containers') throw new Error('compose failed');
        return undefined;
      };
      await expect(service.restartContainers()).resolves.toBe('failed');

      expect(failed).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(1);
    });

    it('an unsubscribed restart-failed listener is not run', async () => {
      const failed = vi.fn();
      const unsubscribe = service.onRestartFailed(failed);
      unsubscribe();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'restart_integration_containers') throw new Error('compose failed');
        return undefined;
      };

      await expect(service.restartContainers()).resolves.toBe('failed');

      expect(failed).not.toHaveBeenCalled();
    });

    it('restartContainers clears a stale auth_required after switching to a no-auth provider', async () => {
      service.status.set('auth_required');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_auth_status')
          return {
            api_key_configured: false,
            oauth_authenticated: false,
            needs_anthropic_auth: false,
            provider_configured: true,
          };
        return undefined;
      };

      await service.restartContainers();

      expect(service.status()).toBe('ready');
    });

    it('restartContainers logs (not console) when invalidate_slash_cache fails but still succeeds', async () => {
      service.requestRestart();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'invalidate_slash_cache') throw new Error('cache gone');
        return undefined;
      };

      await service.restartContainers();

      expect(service.needsRestart).toBe(false);
      expect(service.restartError).toBe('');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('invalidate_slash_cache failed: cache gone')
      );
    });

    it('restartContainers fires notifyChange at each state transition', async () => {
      service.requestRestart();
      const states: Array<{ restarting: boolean; needsRestart: boolean }> = [];
      service.onChange(() => {
        states.push({ restarting: service.restarting, needsRestart: service.needsRestart });
      });

      const pendingRestart = createDeferred();
      mockTauri.invokeHandler = (cmd: string) => {
        if (cmd === 'restart_integration_containers') return pendingRestart.promise;
        return Promise.resolve(undefined);
      };

      const promise = service.restartContainers();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(states).toHaveLength(1);
      expect(states[0]).toEqual({ restarting: true, needsRestart: true });

      pendingRestart.resolve();
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

      const outcome = await service.restartContainers();

      expect(outcome).toBe('failed');
      expect(service.restartError).toBe('compose failed');
      expect(service.restarting).toBe(false);
      expect(service.needsRestart).toBe(true);
    });

    it('restartInFlight exists only while a restart runs and settles after its complete listeners', async () => {
      const order: string[] = [];
      service.onRestartComplete(() => order.push('complete'));
      const pendingRestart = createDeferred();
      mockTauri.invokeHandler = (cmd: string) => {
        if (cmd === 'restart_integration_containers') return pendingRestart.promise;
        return Promise.resolve(undefined);
      };
      expect(service.restartInFlight).toBeNull();

      const promise = service.restartContainers();
      const inFlight = service.restartInFlight;
      expect(inFlight).not.toBeNull();
      void inFlight?.then(() => order.push('settled'));
      await new Promise((r) => setTimeout(r, 0));
      expect(order).toEqual([]);

      pendingRestart.resolve();
      await promise;
      await inFlight;

      expect(order).toEqual(['complete', 'settled']);
      expect(service.restartInFlight).toBeNull();
    });

    it('restartInFlight settles when the restart fails', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'restart_integration_containers') throw new Error('compose failed');
        return undefined;
      };

      const promise = service.restartContainers();
      const inFlight = service.restartInFlight;

      await expect(promise).resolves.toBe('failed');
      await expect(inFlight).resolves.toBeUndefined();
      expect(service.restartInFlight).toBeNull();
    });

    it('a restart ending after a project switch let a newer one start leaves the newer handle', async () => {
      const first = createDeferred();
      const second = createDeferred();
      const pending = [first, second];
      mockTauri.invokeHandler = (cmd: string) => {
        const next = cmd === 'restart_integration_containers' ? pending.shift() : undefined;
        return next ? next.promise : Promise.resolve(undefined);
      };

      const older = service.restartContainers();
      await new Promise((r) => setTimeout(r, 0));
      mockTauri.dispatchEvent('project_switch_started', { project: 'test' });
      const newer = service.restartContainers();
      const newerHandle = service.restartInFlight;
      await new Promise((r) => setTimeout(r, 0));
      first.resolve();
      await older;

      expect(newerHandle).not.toBeNull();
      expect(service.restartInFlight).toBe(newerHandle);

      second.resolve();
      await newer;

      expect(service.restartInFlight).toBeNull();
    });

    it('restartInFlight stays null for a restart that never started', async () => {
      service.restarting = true;

      await expect(service.restartContainers()).resolves.toBe('skipped');

      expect(service.restartInFlight).toBeNull();
    });

    it('restartContainers separates a restart it ran from one it never started', async () => {
      service.requestRestart();

      await expect(service.restartContainers()).resolves.toBe('restarted');

      service.restarting = true;
      await expect(service.restartContainers()).resolves.toBe('skipped');

      service.restarting = false;
      service.activeProject.set(null);
      await expect(service.restartContainers()).resolves.toBe('skipped');
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
      service.activeProject.set(null);
      service.requestRestart();
      const spy = vi.spyOn(mockTauri, 'invoke');
      const callsBefore = spy.mock.calls.length;

      await service.restartContainers();

      expect(spy.mock.calls.length).toBe(callsBefore);
    });

    it('restartContainers invalidates the slash cache and fires onProjectReady + onProjectSettled on success', async () => {
      service.requestRestart();
      const spy = vi.spyOn(mockTauri, 'invoke');
      const readyCallback = vi.fn();
      const settledCallback = vi.fn();
      service.onProjectReady(readyCallback);
      service.onProjectSettled(settledCallback);

      await service.restartContainers();

      expect(spy).toHaveBeenCalledWith('invalidate_slash_cache', { projectId: 'test' });
      expect(readyCallback).toHaveBeenCalled();
      expect(settledCallback).toHaveBeenCalled();
    });

    it('restartContainers does not invalidate slash cache or fire ready/settled when restart fails', async () => {
      service.requestRestart();
      mockTauri.invokeHandler = (cmd: string) => {
        if (cmd === 'restart_integration_containers') {
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve(undefined);
      };
      const spy = vi.spyOn(mockTauri, 'invoke');
      const readyCallback = vi.fn();
      const settledCallback = vi.fn();
      service.onProjectReady(readyCallback);
      service.onProjectSettled(settledCallback);

      await service.restartContainers();

      expect(service.restartError).toBe('boom');
      expect(spy).not.toHaveBeenCalledWith('invalidate_slash_cache', expect.anything());
      expect(readyCallback).not.toHaveBeenCalled();
      expect(settledCallback).not.toHaveBeenCalled();
    });

    it('restartContainers still fires onProjectReady when invalidate_slash_cache itself fails', async () => {
      service.requestRestart();
      mockTauri.invokeHandler = (cmd: string) => {
        if (cmd === 'invalidate_slash_cache') {
          return Promise.reject(new Error('cache error'));
        }
        return Promise.resolve(undefined);
      };
      const readyCallback = vi.fn();
      const settledCallback = vi.fn();
      service.onProjectReady(readyCallback);
      service.onProjectSettled(settledCallback);

      await service.restartContainers();

      expect(service.restartError).toBe('');
      expect(service.needsRestart).toBe(false);
      expect(readyCallback).toHaveBeenCalled();
      expect(settledCallback).toHaveBeenCalled();
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

    it('restartContainers forwards pendingJustEnabled and clears it after', async () => {
      service.requestRestart();
      service.pendingJustEnabled = 'playwright';
      const spy = vi.spyOn(mockTauri, 'invoke');

      await service.restartContainers();

      expect(spy).toHaveBeenCalledWith('restart_integration_containers', {
        project: 'test',
        justEnabled: 'playwright',
      });
      expect(service.pendingJustEnabled).toBeNull();
    });

    it('restart failure triggers integration status refresh + clears pendingJustEnabled', async () => {
      service.requestRestart();
      service.pendingJustEnabled = 'playwright';
      const refresher = vi.fn();
      service.registerIntegrationStatusRefresher(refresher);

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'restart_integration_containers') {
          throw new Error('Image build failed: disk full');
        }
        return undefined;
      };

      await service.restartContainers();

      expect(refresher).toHaveBeenCalledTimes(1);
      expect(service.pendingJustEnabled).toBeNull();
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

    it('awaits onRestartBegin callbacks before restarting containers', async () => {
      const order: string[] = [];
      service.onRestartBegin(async () => {
        await Promise.resolve();
        order.push('begin');
      });
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'restart_integration_containers') order.push('restart');
        return undefined;
      };
      service.activeProject.set('p');
      await service.restartContainers();
      expect(order).toEqual(['begin', 'restart']);
    });

    it('a rejecting onRestartBegin callback does not block the restart', async () => {
      const order: string[] = [];
      service.onRestartBegin(async () => {
        throw new Error('hook failed');
      });
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'restart_integration_containers') order.push('restart');
        return undefined;
      };
      service.activeProject.set('p');
      await service.restartContainers();
      expect(order).toEqual(['restart']);
    });
  });

  describe('unhealthySummary', () => {
    it('reports unavailable status for a null report', () => {
      expect(unhealthySummary(null)).toContain('health status unavailable');
    });

    it('lists every failing subsystem', () => {
      const msg = unhealthySummary(
        makeHealth({
          overall_healthy: false,
          vm: { running: false, vm_type: 'lima' },
          mcp_os: { running: false },
          containers: [
            { name: 'claude', status: 'exited', healthy: false },
            { name: 'mcp-hub', status: 'running', healthy: true },
          ],
        })
      );

      expect(msg).toContain('VM not running');
      expect(msg).toContain('mcp-os worker stopped');
      expect(msg).toContain('unhealthy containers: claude');
      expect(msg).not.toContain('mcp-hub');
    });

    it('falls back to unknown reason when subsystems look fine', () => {
      expect(unhealthySummary(makeHealth({ overall_healthy: false }))).toContain('unknown reason');
    });
  });

  describe('authStatusToProjectStatus', () => {
    const auth = (o: Partial<AuthStatusResponse>): AuthStatusResponse => ({
      api_key_configured: false,
      oauth_authenticated: false,
      needs_anthropic_auth: true,
      provider_configured: true,
      ...o,
    });

    it('passes the backend discriminant through as the SSOT, overriding contradictory flags', () => {
      expect(
        authStatusToProjectStatus(
          auth({
            status: 'no_provider',
            provider_configured: true,
            api_key_configured: true,
            oauth_authenticated: true,
            needs_anthropic_auth: false,
          })
        )
      ).toBe('no_provider');
      expect(authStatusToProjectStatus(auth({ status: 'ready', provider_configured: false }))).toBe(
        'ready'
      );
      expect(
        authStatusToProjectStatus(
          auth({ status: 'auth_required', api_key_configured: true, oauth_authenticated: true })
        )
      ).toBe('auth_required');
    });

    it('no_provider wins first, regardless of credential flags', () => {
      expect(
        authStatusToProjectStatus(
          auth({ provider_configured: false, oauth_authenticated: true, api_key_configured: true })
        )
      ).toBe('no_provider');
    });

    it('ready when not needing anthropic auth', () => {
      expect(authStatusToProjectStatus(auth({ needs_anthropic_auth: false }))).toBe('ready');
    });

    it('ready when oauth or api key present', () => {
      expect(authStatusToProjectStatus(auth({ oauth_authenticated: true }))).toBe('ready');
      expect(authStatusToProjectStatus(auth({ api_key_configured: true }))).toBe('ready');
    });

    it('auth_required when anthropic auth needed and no credentials', () => {
      expect(authStatusToProjectStatus(auth({}))).toBe('auth_required');
    });
  });
});
