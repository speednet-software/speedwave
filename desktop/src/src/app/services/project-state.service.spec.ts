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
import { HealthStoreService } from './health-store.service';
import type { HealthReport } from '../models/health';

function makeMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

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

      // Listeners should still work
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
      // Non-anthropic provider, no Anthropic creds, backend says auth not needed:
      // gate must not strand the user on "auth required" (the free-model bug).
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
              // Stale Anthropic creds present, but the project was emptied:
              // no-provider wins so the user is routed to pick a provider.
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
      // Default handler returns undefined for get_health — gate must not block.
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

      // no_provider hides the restart overlay — start rather than set a dead flag.
      expect(ensureSpy).toHaveBeenCalled();
      expect(service.needsRestart).toBe(false);
    });

    it('defers a restart requested mid-switch, keeping needsRestart false for now', () => {
      service.status.set('switching');
      service.needsRestart = false;
      const ensureSpy = vi.spyOn(service, 'ensureContainersRunning').mockResolvedValue();

      service.requestRestart();

      // Overlay can't render while switching — flag stays down until we settle.
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
            provider_configured: true, // → ready
          };
        }
        return undefined;
      };
      mockTauri.dispatchEvent('project_switch_started', { project: 'e2e-test' });
      expect(service.status()).toBe('switching');

      // Save fires requestRestart while switching — deferred, not visible yet.
      service.requestRestart();
      expect(service.needsRestart).toBe(false);

      // Switch settles → the deferred intent becomes a live needsRestart.
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'e2e-test' });
      await new Promise((r) => setTimeout(r, 0));

      expect(service.status()).toBe('ready');
      expect(service.needsRestart).toBe(true);
    });

    it('clears a deferred restart intent when the switch settles on no_provider', async () => {
      await service.init();
      mockTauri.dispatchEvent('project_switch_started', { project: 'bare' });
      service.requestRestart(); // deferred while switching
      expect(service.needsRestart).toBe(false);

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_auth_status') {
          return {
            api_key_configured: false,
            oauth_authenticated: false,
            needs_anthropic_auth: false,
            provider_configured: false, // → no_provider
          };
        }
        return undefined;
      };
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'bare' });
      await new Promise((r) => setTimeout(r, 0));

      // No-provider settle voids the intent — nothing is running to restart.
      expect(service.status()).toBe('no_provider');
      expect(service.needsRestart).toBe(false);

      // The voided intent must not resurrect on a later ready settle.
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
      service.requestRestart(); // deferred

      // A brand-new switch supersedes the stale deferred intent.
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
            // Ready-looking flags, but the backend SSOT says no provider.
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
      // 1 (started) + 1 (resolveSwitchSucceededStatus) + 1 (refreshProjectList).
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

      // Wait for the async error handling
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
      const releases: Array<() => void> = [];
      const base = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'run_system_check') {
          await new Promise<void>((r) => releases.push(r));
          return undefined;
        }
        return base(cmd, args);
      };
      const spy = vi.spyOn(mockTauri, 'invoke');
      const first = service.ensureContainersRunning();
      await new Promise((r) => setTimeout(r, 0));
      // The bundle-done listener re-enters ensure while the first run is mid-flight.
      service.status.set('rebuilding');
      const second = service.ensureContainersRunning();
      await new Promise((r) => setTimeout(r, 0));
      while (releases.length) releases.shift()!();
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

      // A failed check must not masquerade as "not authenticated".
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
      // Opening Settings probes auth; a false negative (no_provider / auth_required)
      // must not blank a running chat. Both pre-ready outcomes are ignored when ready.
      for (const auth of [
        // → no_provider
        {
          api_key_configured: true,
          oauth_authenticated: true,
          needs_anthropic_auth: false,
          provider_configured: false,
        },
        // → auth_required
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

    it('applyAuthStatus sets no_provider when provider_configured=false', () => {
      service.status.set('starting');
      service.applyAuthStatus({
        // Auth flags are irrelevant: no-provider is checked first.
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
        // Discriminant says ready even though the flags alone would not.
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
      // Unlike applyAuthStatus, a user-initiated logout is not a false
      // negative — the chat view must blank to the no_provider screen.
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

      // justEnabled is null when no integration was just toggled.
      expect(spy).toHaveBeenCalledWith('restart_integration_containers', {
        project: 'test',
        justEnabled: null,
      });
      expect(service.needsRestart).toBe(false);
      expect(service.restarting).toBe(false);
      expect(service.restartError).toBe('');
    });

    it('restartContainers fires onRestartBegin before the Tauri invoke, and ready before restart-complete', async () => {
      // Ordering invariant chat resume relies on: id snapshot at begin, then ready (nulls the
      // live id) before restart-complete (reads the snapshot) — a reorder breaks resume.
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

    it('restartContainers clears a stale auth_required after switching to a no-auth provider', async () => {
      // Repro: logged out (auth_required) → switch to local + restart. Backend
      // now reports no auth needed, so the stale auth_required must clear.
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

      // The slash-cache miss is non-fatal: restart still completes.
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
      // Allow microtasks to settle so resolveInvoke is bound.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

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

      // Slash cache must be invalidated before the next slash-menu open.
      expect(spy).toHaveBeenCalledWith('invalidate_slash_cache', { projectId: 'test' });
      // onProjectReady/onProjectSettled fire so consumers re-fetch per-project state.
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
      // Post-success steps must not run when restart fails — state has not advanced.
      expect(spy).not.toHaveBeenCalledWith('invalidate_slash_cache', expect.anything());
      expect(readyCallback).not.toHaveBeenCalled();
      expect(settledCallback).not.toHaveBeenCalled();
    });

    it('restartContainers still fires onProjectReady when invalidate_slash_cache itself fails', async () => {
      // Regression guard: ensures ready fires even when invalidation fails.
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
      // activeProject must be set for restartContainers to proceed.
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
      expect(order).toEqual(['restart']); // restart still ran despite the rejecting hook
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
      // no_provider despite every credential flag and provider_configured=true.
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
      // ready despite provider_configured=false (backend already decided).
      expect(authStatusToProjectStatus(auth({ status: 'ready', provider_configured: false }))).toBe(
        'ready'
      );
      // auth_required despite credentials being present.
      expect(
        authStatusToProjectStatus(
          auth({ status: 'auth_required', api_key_configured: true, oauth_authenticated: true })
        )
      ).toBe('auth_required');
    });

    // The remaining cases exercise the legacy fallback (payload without `status`).

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
