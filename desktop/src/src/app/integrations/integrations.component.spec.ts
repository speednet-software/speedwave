import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { IntegrationsComponent } from './integrations.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { LoggerService } from '../services/logger.service';
import { BetaService } from '../services/beta.service';
import { MockTauriService } from '../testing/mock-tauri.service';

/**
 * Mock LoggerService for tests. Real LoggerService calls `@tauri-apps/plugin-log`
 * which has no Tauri context in unit tests; it would throw or no-op silently.
 * The mock lets us assert that the component logged the expected lifecycle
 * events (toggle clicks, validate outcomes, auto-disabled services) which is
 * what makes the user-supplied logs ZIP useful for support triage.
 */
function makeMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const MOCK_INTEGRATIONS = {
  services: [
    {
      service: 'gitlab',
      enabled: true,
      configured: true,
      display_name: 'GitLab',
      description: 'Code hosting',
      auth_fields: [
        {
          key: 'token',
          label: 'Token',
          field_type: 'password',
          placeholder: 'glpat-...',
          oauth_flow: false,
        },
      ],
      current_values: {},
      mappings: undefined,
    },
    {
      service: 'redmine',
      enabled: false,
      configured: false,
      display_name: 'Redmine',
      description: 'Project management',
      auth_fields: [
        {
          key: 'url',
          label: 'URL',
          field_type: 'url',
          placeholder: 'https://...',
          oauth_flow: false,
        },
        {
          key: 'api_key',
          label: 'API Key',
          field_type: 'password',
          placeholder: '',
          oauth_flow: false,
        },
      ],
      current_values: {},
      mappings: { tracker: 1 },
    },
    {
      service: 'github',
      enabled: false,
      configured: false,
      display_name: 'GitHub',
      description: 'Code hosting and CI/CD platform',
      auth_fields: [
        {
          key: 'token',
          label: 'GitHub Access Token',
          field_type: 'password',
          placeholder: 'gho_...',
          oauth_flow: true,
        },
      ],
      current_values: {},
      mappings: undefined,
    },
    {
      service: 'sharepoint',
      enabled: false,
      configured: false,
      display_name: 'SharePoint',
      description: 'Microsoft 365',
      auth_fields: [
        {
          key: 'access_token',
          label: 'Access Token',
          field_type: 'password',
          placeholder: '',
          oauth_flow: true,
        },
        {
          key: 'refresh_token',
          label: 'Refresh Token',
          field_type: 'password',
          placeholder: '',
          oauth_flow: true,
        },
        {
          key: 'client_id',
          label: 'Client ID',
          field_type: 'text',
          placeholder: '',
          oauth_flow: false,
        },
        {
          key: 'tenant_id',
          label: 'Tenant ID',
          field_type: 'text',
          placeholder: '',
          oauth_flow: false,
        },
        {
          key: 'site_id',
          label: 'Site ID',
          field_type: 'text',
          placeholder: '',
          oauth_flow: false,
        },
      ],
      current_values: {},
      mappings: undefined,
    },
  ],
  os: [
    {
      service: 'reminders',
      enabled: true,
      display_name: 'Reminders',
      description: 'Native reminders',
    },
  ],
};

function cloneMockIntegrations(): typeof MOCK_INTEGRATIONS {
  return JSON.parse(JSON.stringify(MOCK_INTEGRATIONS));
}

function setupMockTauri(mockTauri: MockTauriService): void {
  mockTauri.invokeHandler = async (cmd: string) => {
    switch (cmd) {
      case 'list_projects':
        return {
          projects: [{ name: 'test-project', dir: '/tmp/test' }],
          active_project: 'test-project',
        };
      case 'get_integrations':
        return cloneMockIntegrations();
      case 'list_available_ides':
        return [];
      case 'get_selected_ide':
        return null;
      case 'validate_os_integrations_on_startup':
        // Default: no auto-disabled integrations. Tests that exercise the
        // migration banner override the handler explicitly.
        return [];
      default:
        return undefined;
    }
  };
}

describe('IntegrationsComponent', () => {
  let component: IntegrationsComponent;
  let fixture: ComponentFixture<IntegrationsComponent>;
  let mockTauri: MockTauriService;
  let projectState: ProjectStateService;
  let mockLogger: ReturnType<typeof makeMockLogger>;
  // BetaService stub; defaults false to match production (tray toggles it).
  const betaEnabled = signal(false);

  beforeEach(async () => {
    betaEnabled.set(false);
    mockTauri = new MockTauriService();
    setupMockTauri(mockTauri);
    mockLogger = makeMockLogger();

    // Reset the static "already validated" map so each test starts clean —
    // the production guard prevents re-validation when re-entering the route,
    // but tests need to observe a fresh validate flow.
    (
      IntegrationsComponent as unknown as { validationByProject: Map<string, Promise<void>> }
    ).validationByProject.clear();

    await TestBed.configureTestingModule({
      imports: [IntegrationsComponent],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: mockLogger },
        { provide: BetaService, useValue: { enabled: betaEnabled.asReadonly() } },
      ],
    }).compileComponents();

    projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject = 'test-project';

    fixture = TestBed.createComponent(IntegrationsComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    component.ngOnDestroy();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should load active project and integrations on init', async () => {
    await component.ngOnInit();
    expect(component.activeProject).toBe('test-project');
    // GitHub is in BETA_ONLY_SERVICES, hidden unless beta is on (default off in tests).
    // Visible services: gitlab, redmine, sharepoint.
    expect(component.services).toHaveLength(3);
    expect(component.osIntegrations).toHaveLength(1);
  });

  it('should filter out hidden services (slack) but show sharepoint', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_projects':
          return {
            projects: [{ name: 'test-project', dir: '/tmp/test' }],
            active_project: 'test-project',
          };
        case 'get_integrations':
          return {
            services: [
              ...cloneMockIntegrations().services,
              {
                service: 'slack',
                enabled: true,
                configured: true,
                display_name: 'Slack',
                description: 'Team messaging',
                auth_fields: [],
                current_values: {},
                mappings: undefined,
              },
            ],
            os: [],
          };
        case 'list_available_ides':
          return [];
        case 'get_selected_ide':
          return null;
        default:
          return undefined;
      }
    };
    await component.ngOnInit();
    const serviceNames = component.services.map((s) => s.service);
    expect(serviceNames).not.toContain('slack');
    expect(serviceNames).toContain('sharepoint');
    expect(serviceNames).toContain('gitlab');
    expect(serviceNames).toContain('redmine');
  });

  describe('beta gating (ADR-058)', () => {
    const betaServices = ['office', 'github', 'atlassian'] as const;

    // Backend always returns the beta services; whether the user sees them is governed by the BetaService signal.
    function setupWithBetaServices(): void {
      const extra = betaServices.map((svc) => ({
        service: svc,
        enabled: false,
        configured: false,
        display_name: svc,
        description: '',
        auth_fields: [],
        current_values: {},
        mappings: undefined,
      }));
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return {
              projects: [{ name: 'test-project', dir: '/tmp/test' }],
              active_project: 'test-project',
            };
          case 'get_integrations':
            return {
              services: [...cloneMockIntegrations().services, ...extra],
              os: [],
            };
          case 'list_available_ides':
            return [];
          case 'get_selected_ide':
            return null;
          case 'validate_os_integrations_on_startup':
            return [];
          default:
            return undefined;
        }
      };
    }

    it.each(betaServices)('hides %s row when beta is off (default for new users)', async (svc) => {
      setupWithBetaServices();
      betaEnabled.set(false);
      await component.ngOnInit();
      expect(component.services.map((s) => s.service)).not.toContain(svc);
    });

    it.each(betaServices)('shows %s row when beta is on', async (svc) => {
      setupWithBetaServices();
      betaEnabled.set(true);
      await component.ngOnInit();
      expect(component.services.map((s) => s.service)).toContain(svc);
    });

    it('hides host-exec slot when beta is off', async () => {
      betaEnabled.set(false);
      await component.ngOnInit();
      fixture.detectChanges();
      const slot = fixture.nativeElement.querySelector(
        '[data-testid="integrations-host-exec-slot"]'
      );
      expect(slot).toBeNull();
    });

    it('shows host-exec slot when beta is on', async () => {
      betaEnabled.set(true);
      await component.ngOnInit();
      fixture.detectChanges();
      const slot = fixture.nativeElement.querySelector(
        '[data-testid="integrations-host-exec-slot"]'
      );
      expect(slot).not.toBeNull();
    });

    it('reveals all beta surfaces when beta toggles off → on mid-session', async () => {
      setupWithBetaServices();
      betaEnabled.set(false);
      await component.ngOnInit();
      fixture.detectChanges();
      const namesOff = component.services.map((s) => s.service);
      for (const svc of betaServices) {
        expect(namesOff).not.toContain(svc);
      }
      expect(
        fixture.nativeElement.querySelector('[data-testid="integrations-host-exec-slot"]')
      ).toBeNull();

      betaEnabled.set(true);
      // fakeAsync doesn't integrate with Angular Signals under Vitest — one macrotask lets the effect flush.
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();

      const namesOn = component.services.map((s) => s.service);
      for (const svc of betaServices) {
        expect(namesOn).toContain(svc);
      }
      expect(
        fixture.nativeElement.querySelector('[data-testid="integrations-host-exec-slot"]')
      ).not.toBeNull();
    });
  });

  it('should set error when loadIntegrations fails', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_projects') return { projects: [], active_project: 'test' };
      if (cmd === 'get_integrations') throw new Error('network error');
      return undefined;
    };
    await component.ngOnInit();
    expect(component.error).toBe('network error');
  });

  it('should not load integrations without active project', async () => {
    const projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject = null;
    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    await component.ngOnInit();
    expect(invokeSpy).not.toHaveBeenCalledWith('get_integrations', expect.anything());
  });

  describe('toggleExpand()', () => {
    it('expands a service', () => {
      component.toggleExpand('gitlab');
      expect(component.expandedService).toBe('gitlab');
    });

    it('collapses an already expanded service', () => {
      component.expandedService = 'gitlab';
      component.toggleExpand('gitlab');
      expect(component.expandedService).toBeNull();
    });

    it('switches to a different service', () => {
      component.expandedService = 'gitlab';
      component.toggleExpand('redmine');
      expect(component.expandedService).toBe('redmine');
    });
  });

  describe('toggleService()', () => {
    it('sets enabled and marks needsRestart', async () => {
      await component.ngOnInit();
      const event = { target: { checked: false } } as unknown as Event;
      await component.toggleService(component.services[0], event);
      expect(component.services[0].enabled).toBe(false);
      expect(projectState.needsRestart).toBe(true);
    });

    it('invokes set_integration_enabled', async () => {
      await component.ngOnInit();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      const event = { target: { checked: true } } as unknown as Event;
      await component.toggleService(component.services[0], event);
      expect(invokeSpy).toHaveBeenCalledWith('set_integration_enabled', {
        project: 'test-project',
        service: 'gitlab',
        enabled: true,
      });
    });

    it('reverts checkbox on error', async () => {
      await component.ngOnInit();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_integration_enabled') throw new Error('failed');
        return undefined;
      };
      const target = { checked: true };
      const event = { target } as unknown as Event;
      await component.toggleService(component.services[0], event);
      expect(target.checked).toBe(false);
      expect(component.error).toBe('failed');
    });
  });

  describe('toggleOsService()', () => {
    it('sets enabled and marks needsRestart', async () => {
      await component.ngOnInit();
      const event = { target: { checked: false } } as unknown as Event;
      await component.toggleOsService(component.osIntegrations[0], event);
      expect(component.osIntegrations[0].enabled).toBe(false);
      expect(projectState.needsRestart).toBe(true);
    });

    it('reverts checkbox on error', async () => {
      await component.ngOnInit();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_os_integration_enabled') throw new Error('denied');
        return undefined;
      };
      const target = { checked: false };
      const event = { target } as unknown as Event;
      await component.toggleOsService(component.osIntegrations[0], event);
      expect(target.checked).toBe(true);
      expect(component.error).toBe('denied');
    });

    it('error div has whitespace-pre-line class for multiline display', async () => {
      await component.ngOnInit();
      const permissionError =
        'Reminders access denied: Access was denied\nGrant access in System Settings > Privacy & Security > Reminders';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_os_integration_enabled') throw new Error(permissionError);
        return undefined;
      };
      const target = { checked: true };
      const event = { target } as unknown as Event;
      await component.toggleOsService(component.osIntegrations[0], event);

      expect(component.error).toBe(permissionError);
      expect(target.checked).toBe(false);

      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();

      const errorDiv = fixture.nativeElement.querySelector('[data-testid="integrations-error"]');
      expect(errorDiv).not.toBeNull();
      expect(errorDiv.classList.contains('whitespace-pre-line')).toBe(true);
      expect(errorDiv.textContent).toContain('System Settings');
    });
  });

  describe('onOsToggleClick()', () => {
    it('displays_multi_line_error_with_preserved_newlines', async () => {
      await component.ngOnInit();
      const multiLineError =
        'Calendar access was previously denied. Open Terminal and run:\ntccutil reset Calendar pl.speedwave.desktop\nThen click the toggle again.';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_os_integration_enabled') throw new Error(multiLineError);
        return undefined;
      };
      const os = component.osIntegrations[0];
      const event = { stopPropagation: vi.fn() } as unknown as Event;
      await component.onOsToggleClick(os, event);

      expect(component.error).toBe(multiLineError);

      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();

      const errorDiv = fixture.nativeElement.querySelector('[data-testid="integrations-error"]');
      expect(errorDiv).not.toBeNull();
      expect(errorDiv.classList.contains('whitespace-pre-line')).toBe(true);
    });

    it('displays_silent_reject_recovery_text', async () => {
      await component.ngOnInit();
      const silentRejectError =
        'Calendar permission was silently rejected by macOS. This usually means a signing or entitlement problem — please reinstall Speedwave from a fresh download.';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_os_integration_enabled') throw new Error(silentRejectError);
        return undefined;
      };
      const os = component.osIntegrations[0];
      const event = { stopPropagation: vi.fn() } as unknown as Event;
      await component.onOsToggleClick(os, event);

      expect(component.error).toContain('reinstall Speedwave from a fresh download');
    });

    it('reverts_toggle_state_on_permission_failure', async () => {
      await component.ngOnInit();
      const os = component.osIntegrations[0];
      const previous = os.enabled;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_os_integration_enabled') throw new Error('Permission denied');
        return undefined;
      };
      const event = { stopPropagation: vi.fn() } as unknown as Event;
      await component.onOsToggleClick(os, event);

      expect(os.enabled).toBe(previous);
    });
  });

  describe('handleSaveCredentials()', () => {
    it('invokes save_integration_credentials and reloads', async () => {
      await component.ngOnInit();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.handleSaveCredentials({
        svc: component.services[0],
        credentials: { token: 'glpat-test' },
        mappings: null,
      });
      expect(invokeSpy).toHaveBeenCalledWith('save_integration_credentials', {
        project: 'test-project',
        service: 'gitlab',
        credentials: { token: 'glpat-test' },
      });
      expect(projectState.needsRestart).toBe(true);
    });

    it('saves redmine mappings alongside credentials', async () => {
      await component.ngOnInit();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.handleSaveCredentials({
        svc: component.services[1],
        credentials: { url: 'https://redmine.test' },
        mappings: { tracker: 2, status: 5 },
      });
      expect(invokeSpy).toHaveBeenCalledWith('save_redmine_mappings', {
        project: 'test-project',
        mappings: { tracker: 2, status: 5 },
      });
    });

    it('sets error on failure', async () => {
      await component.ngOnInit();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'save_integration_credentials') throw new Error('save failed');
        return undefined;
      };
      await component.handleSaveCredentials({
        svc: component.services[0],
        credentials: { token: 'glpat-test' },
        mappings: null,
      });
      expect(component.error).toBe('save failed');
    });

    it('auto-enables service after save', async () => {
      await component.ngOnInit();

      const afterSaveIntegrations = cloneMockIntegrations();
      afterSaveIntegrations.services = afterSaveIntegrations.services.map((s) =>
        s.service === 'redmine' ? { ...s, configured: true, enabled: false } : s
      );
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return {
              projects: [{ name: 'test-project', dir: '/tmp/test' }],
              active_project: 'test-project',
            };
          case 'get_integrations':
            return afterSaveIntegrations;
          default:
            return undefined;
        }
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.handleSaveCredentials({
        svc: component.services[1],
        credentials: { api_key: 'secret123' },
        mappings: null,
      });
      expect(invokeSpy).toHaveBeenCalledWith('set_integration_enabled', {
        project: 'test-project',
        service: 'redmine',
        enabled: true,
      });
    });
  });

  describe('handleSaveCredentials() ordering', () => {
    it('calls autoEnableIfConfigured before requestRestart', async () => {
      await component.ngOnInit();
      const callLog: string[] = [];

      const afterSave = cloneMockIntegrations();
      afterSave.services = afterSave.services.map((s) =>
        s.service === 'redmine' ? { ...s, configured: true, enabled: false } : s
      );
      mockTauri.invokeHandler = async (cmd: string) => {
        callLog.push(cmd);
        if (cmd === 'get_integrations') return afterSave;
        return undefined;
      };

      const originalRequestRestart = projectState.requestRestart.bind(projectState);
      vi.spyOn(projectState, 'requestRestart').mockImplementation(() => {
        callLog.push('requestRestart');
        originalRequestRestart();
      });

      await component.handleSaveCredentials({
        svc: component.services[1],
        credentials: { api_key: 'key' },
        mappings: null,
      });

      const enableIdx = callLog.indexOf('set_integration_enabled');
      const restartIdx = callLog.indexOf('requestRestart');
      expect(enableIdx).toBeGreaterThanOrEqual(0);
      expect(restartIdx).toBeGreaterThanOrEqual(0);
      expect(enableIdx).toBeLessThan(restartIdx);
    });

    it('does not call requestRestart when save_integration_credentials fails', async () => {
      await component.ngOnInit();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'save_integration_credentials') throw new Error('save failed');
        return undefined;
      };
      const restartSpy = vi.spyOn(projectState, 'requestRestart');
      await component.handleSaveCredentials({
        svc: component.services[0],
        credentials: { token: 'tok' },
        mappings: null,
      });
      expect(restartSpy).not.toHaveBeenCalled();
    });
  });

  describe('deleteCredentials()', () => {
    it('invokes delete_integration_credentials and marks needsRestart', async () => {
      await component.ngOnInit();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.deleteCredentials(component.services[0]);
      expect(invokeSpy).toHaveBeenCalledWith('delete_integration_credentials', {
        project: 'test-project',
        service: 'gitlab',
      });
      expect(projectState.needsRestart).toBe(true);
    });

    it('sets error on failure', async () => {
      await component.ngOnInit();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'delete_integration_credentials') throw new Error('delete failed');
        return undefined;
      };
      await component.deleteCredentials(component.services[0]);
      expect(component.error).toBe('delete failed');
    });

    it('auto-disables the service', async () => {
      await component.ngOnInit();
      component.services[0].enabled = true;
      component.services[0].configured = true;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.deleteCredentials(component.services[0]);
      expect(invokeSpy).toHaveBeenCalledWith('set_integration_enabled', {
        project: 'test-project',
        service: 'gitlab',
        enabled: false,
      });
    });
  });

  describe('toggleService for unconfigured service', () => {
    it('invokes set_integration_enabled (backend validates configuration)', async () => {
      await component.ngOnInit();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_integration_enabled') throw new Error('Service not configured');
        return undefined;
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      invokeSpy.mockClear();
      const target = { checked: true };
      const event = { target } as unknown as Event;
      await component.toggleService(component.services[1], event);
      // Frontend no longer blocks — it calls the backend; the backend rejects
      expect(invokeSpy).toHaveBeenCalledWith('set_integration_enabled', expect.anything());
      // Checkbox is reverted on error
      expect(target.checked).toBe(false);
      expect(component.error).toBe('Service not configured');
    });
  });

  describe('OS section visibility', () => {
    it('should hide OS section when backend returns empty os array', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return {
              projects: [{ name: 'test-project', dir: '/tmp/test' }],
              active_project: 'test-project',
            };
          case 'get_integrations':
            return { ...cloneMockIntegrations(), os: [] };
          case 'list_available_ides':
            return [];
          case 'get_selected_ide':
            return null;
          default:
            return undefined;
        }
      };
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const osSection = fixture.nativeElement.querySelector('[data-testid="integrations-os"]');
      expect(osSection).toBeNull();
      expect(component.osIntegrations).toHaveLength(0);
    });

    it('should show OS section when backend returns os entries', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const osSection = fixture.nativeElement.querySelector('[data-testid="integrations-os"]');
      expect(osSection).not.toBeNull();
      expect(component.osIntegrations.length).toBeGreaterThan(0);
    });
  });

  describe('project_switch_succeeded event', () => {
    it('reloads active project and integrations on project_switch_succeeded', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await component.ngOnInit();
      expect(component.activeProject).toBe('test-project');

      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return {
              projects: [
                { name: 'test-project', dir: '/tmp/test' },
                { name: 'other-project', dir: '/tmp/other' },
              ],
              active_project: 'other-project',
            };
          case 'get_integrations':
            return { services: [], os: [] };
          case 'list_available_ides':
            return [];
          case 'get_selected_ide':
            return null;
          default:
            return undefined;
        }
      };

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other-project' });
      await fixture.whenStable();
      expect(component.activeProject).toBe('other-project');
      expect(component.services).toHaveLength(0);
    });

    it('cleans up project ready listener on destroy', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await component.ngOnInit();

      // Verify the unsub function exists before destroy
      expect(
        (component as unknown as { unsubProjectSettled: unknown })['unsubProjectSettled']
      ).not.toBeNull();

      component.ngOnDestroy();

      // Verify unsub was called and nulled
      expect(
        (component as unknown as { unsubProjectSettled: unknown })['unsubProjectSettled']
      ).toBeNull();
    });

    it('cancels active OAuth flow on project_switch_succeeded', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await component.ngOnInit();
      component.activeOAuthRequestId = 'test-rid';
      component.oauthStatus = 'polling';
      component.deviceCodeInfo = {
        user_code: 'CODE',
        verification_uri: 'https://example.com',
        expires_in: 900,
        request_id: 'test-rid',
      };

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other-project' });
      await fixture.whenStable();

      expect(invokeSpy).toHaveBeenCalledWith('cancel_sharepoint_oauth');
      expect(component.activeOAuthRequestId).toBeNull();
      expect(component.deviceCodeInfo).toBeNull();
      expect(component.oauthStatus).toBeNull();
    });

    it('cancels starting OAuth flow on project_switch_succeeded', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await component.ngOnInit();
      component.oauthStatus = 'starting';

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other-project' });
      await fixture.whenStable();

      expect(invokeSpy).toHaveBeenCalledWith('cancel_sharepoint_oauth');
      expect(component.oauthStatus).toBeNull();
    });
  });

  it('renders app-ide-bridge sub-component', async () => {
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const ideBridge = fixture.nativeElement.querySelector('app-ide-bridge');
    expect(ideBridge).not.toBeNull();
  });

  describe('terminal-minimal restyle', () => {
    it('renders the header with the view-title page heading', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const title = fixture.nativeElement.querySelector('[data-testid="integrations-title"]');
      expect(title).not.toBeNull();
      expect(title.textContent).toContain('Service integrations');
      expect(title.classList.contains('view-title')).toBe(true);
    });

    it('header right slot only surfaces the project pill (count was removed)', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      // The "X services · Y running" counter was dropped — the integrations
      // table itself already conveys per-row status, so the header counter
      // was redundant noise.
      const count = fixture.nativeElement.querySelector('[data-testid="integrations-count"]');
      expect(count).toBeNull();

      // Project pill is the shared <app-project-pill> component.
      const pill = fixture.nativeElement.querySelector('app-project-pill');
      expect(pill).not.toBeNull();
    });

    it('renders the integrations table with a header row and one row per service', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const wrapper = fixture.nativeElement.querySelector(
        '[data-testid="integrations-table-wrapper"]'
      );
      expect(wrapper).not.toBeNull();
      // Scope the row count to the integrations table — `<app-ide-bridge>`
      // now also renders a tbody, so a global `tbody tr` selector picks up
      // unrelated rows.
      const rows = wrapper.querySelectorAll('tbody tr');
      expect(rows.length).toBe(component.services.length);
    });

    it('row exposes a service name, status pill, mount cell, and toggle', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const row = fixture.nativeElement.querySelector('[data-testid="integrations-row-gitlab"]');
      expect(row).not.toBeNull();
      const status = row.querySelector('[data-testid="integrations-row-status"]');
      expect(status).not.toBeNull();
      const toggle = row.querySelector('[data-testid="integrations-row-toggle-gitlab"]');
      expect(toggle).not.toBeNull();
    });

    it('clicking a row toggle flips the enabled state without expanding', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const before = component.services[0].enabled;
      const svc = component.services[0];
      // Use the parent click handler directly — the JSDOM click() does not
      // bubble through stopPropagation reliably across the @if scope.
      await component.onRowToggle(svc, new MouseEvent('click'));
      expect(svc.enabled).toBe(!before);
      // Row click must NOT expand because onRowToggle calls stopPropagation.
      expect(component.expandedService).toBeNull();
    });

    it('expanding a row reveals the inline configuration block', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      component.toggleExpand('gitlab');
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const expanded = fixture.nativeElement.querySelector(
        '[data-testid="integrations-expanded-gitlab"]'
      );
      expect(expanded).not.toBeNull();
    });

    it('mounts the IDE bridge child component below the table', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const slot = fixture.nativeElement.querySelector(
        '[data-testid="integrations-ide-bridge-slot"]'
      );
      expect(slot).not.toBeNull();
      expect(slot.querySelector('app-ide-bridge')).not.toBeNull();
    });
  });

  // -- OAuth flow tests --

  describe('handleStartOAuth()', () => {
    it('saves non-oauth credentials first, then starts OAuth', async () => {
      await component.ngOnInit();
      const sharepointSvc = component.services.find((s) => s.service === 'sharepoint')!;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_sharepoint_oauth') {
          return {
            user_code: 'CODE',
            verification_uri: 'https://example.com',
            expires_in: 900,
            request_id: 'rid-123',
          };
        }
        if (cmd === 'list_projects') {
          return { projects: [], active_project: 'test-project' };
        }
        if (cmd === 'get_integrations') {
          return cloneMockIntegrations();
        }
        return undefined;
      };

      await component.handleStartOAuth({
        svc: sharepointSvc,
        credentials: {
          client_id: '550e8400-e29b-41d4-a716-446655440000',
          tenant_id: 'common',
          site_id: 'my-site',
        },
      });

      expect(invokeSpy).toHaveBeenCalledWith('save_integration_credentials', {
        project: 'test-project',
        service: 'sharepoint',
        credentials: {
          client_id: '550e8400-e29b-41d4-a716-446655440000',
          tenant_id: 'common',
          site_id: 'my-site',
        },
      });
      expect(invokeSpy).toHaveBeenCalledWith('start_sharepoint_oauth', {
        project: 'test-project',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        tenantId: 'common',
      });
      expect(component.oauthStatus).toBe('polling');
      expect(component.deviceCodeInfo).not.toBeNull();
      expect(component.activeOAuthRequestId).toBe('rid-123');
    });

    it('shows error if client_id is empty', async () => {
      await component.ngOnInit();
      const sharepointSvc = component.services.find((s) => s.service === 'sharepoint')!;

      await component.handleStartOAuth({
        svc: sharepointSvc,
        credentials: { tenant_id: 'common' },
      });

      expect(component.error).toContain('Client ID and Tenant ID are required');
      expect(component.oauthStatus).toBeNull();
    });

    it('shows error if tenant_id is empty', async () => {
      await component.ngOnInit();
      const sharepointSvc = component.services.find((s) => s.service === 'sharepoint')!;

      await component.handleStartOAuth({
        svc: sharepointSvc,
        credentials: { client_id: '550e8400-e29b-41d4-a716-446655440000' },
      });

      expect(component.error).toContain('Client ID and Tenant ID are required');
      expect(component.oauthStatus).toBeNull();
    });

    it('returns immediately if oauthStatus is starting', async () => {
      await component.ngOnInit();
      component.oauthStatus = 'starting';
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      invokeSpy.mockClear();

      await component.handleStartOAuth({
        svc: component.services.find((s) => s.service === 'sharepoint')!,
        credentials: { client_id: 'uuid', tenant_id: 'common' },
      });

      expect(invokeSpy).not.toHaveBeenCalledWith('start_sharepoint_oauth', expect.anything());
    });

    it('returns immediately if oauthStatus is polling', async () => {
      await component.ngOnInit();
      component.oauthStatus = 'polling';
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      invokeSpy.mockClear();

      await component.handleStartOAuth({
        svc: component.services.find((s) => s.service === 'sharepoint')!,
        credentials: { client_id: 'uuid', tenant_id: 'common' },
      });

      expect(invokeSpy).not.toHaveBeenCalledWith('start_sharepoint_oauth', expect.anything());
    });

    it('sets oauthStatus to starting before invoke', async () => {
      await component.ngOnInit();
      const sharepointSvc = component.services.find((s) => s.service === 'sharepoint')!;
      let statusDuringInvoke: string | null = null;

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_sharepoint_oauth') {
          statusDuringInvoke = component.oauthStatus;
          return {
            user_code: 'CODE',
            verification_uri: 'https://example.com',
            expires_in: 900,
            request_id: 'rid',
          };
        }
        return undefined;
      };

      await component.handleStartOAuth({
        svc: sharepointSvc,
        credentials: { client_id: '550e8400-e29b-41d4-a716-446655440000', tenant_id: 'common' },
      });

      // It was 'starting' when save_integration_credentials was called (before start_sharepoint_oauth)
      // but by the time start_sharepoint_oauth runs it's still 'starting'
      expect(statusDuringInvoke).toBe('starting');
    });

    it('captures oauthProjectAtStart', async () => {
      await component.ngOnInit();
      const sharepointSvc = component.services.find((s) => s.service === 'sharepoint')!;

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_sharepoint_oauth') {
          return {
            user_code: 'CODE',
            verification_uri: 'https://example.com',
            expires_in: 900,
            request_id: 'rid',
          };
        }
        return undefined;
      };

      await component.handleStartOAuth({
        svc: sharepointSvc,
        credentials: { client_id: '550e8400-e29b-41d4-a716-446655440000', tenant_id: 'common' },
      });

      // oauthProjectAtStart is private, but we can verify the behavior via project_switched test
      expect(component.activeOAuthRequestId).toBe('rid');
    });
  });

  describe('GitHub OAuth flow', () => {
    // GitHub is in BETA_ONLY_SERVICES (ADR-058). The OAuth refactor doesn't
    // change that — beta gating is an orthogonal product decision. Tests flip
    // beta on so the GitHub row is present in `component.services`.
    beforeEach(() => {
      betaEnabled.set(true);
    });

    it('invokes start_github_oauth with project (no client_id/tenant_id)', async () => {
      await component.ngOnInit();
      const githubSvc = component.services.find((s) => s.service === 'github')!;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_github_oauth') {
          return {
            user_code: 'WDJB-MJHT',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            request_id: 'gh-rid-1',
          };
        }
        if (cmd === 'list_projects') {
          return { projects: [], active_project: 'test-project' };
        }
        if (cmd === 'get_integrations') {
          return cloneMockIntegrations();
        }
        return undefined;
      };

      await component.handleStartOAuth({ svc: githubSvc, credentials: {} });

      // GitHub uses bundled client_id (consts.rs::GITHUB_OAUTH_CLIENT_ID);
      // the Tauri command takes only `project`.
      expect(invokeSpy).toHaveBeenCalledWith('start_github_oauth', {
        project: 'test-project',
      });
      // Crucially, GitHub flow must NOT dispatch to the SharePoint command.
      expect(invokeSpy).not.toHaveBeenCalledWith('start_sharepoint_oauth', expect.anything());
      expect(component.oauthStatus).toBe('polling');
      expect(component.oauthService).toBe('github');
      expect(component.deviceCodeInfo).not.toBeNull();
      expect(component.activeOAuthRequestId).toBe('gh-rid-1');
    });

    it('github_oauth_progress polling event sets device code info', async () => {
      await component.ngOnInit();
      component.activeOAuthRequestId = 'gh-rid-2';
      component.oauthService = 'github';

      mockTauri.dispatchEvent('github_oauth_progress', {
        status: 'polling',
        message: 'Waiting for sign-in',
        request_id: 'gh-rid-2',
      });

      expect(component.oauthStatus).toBe('polling');
      expect(component.oauthStatusMessage).toBe('Waiting for sign-in');
    });

    it('github_oauth_progress success clears device code + resets oauthService', async () => {
      await component.ngOnInit();
      component.activeOAuthRequestId = 'gh-rid-3';
      component.oauthService = 'github';
      component.deviceCodeInfo = {
        user_code: 'X',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        request_id: 'gh-rid-3',
      };

      // Need a polling response for handleStartOAuth-style success path. Here
      // we dispatch directly to the listener registered in ngOnInit.
      mockTauri.dispatchEvent('github_oauth_progress', {
        status: 'success',
        message: 'Authentication successful',
        request_id: 'gh-rid-3',
      });

      // The listener is async — wait one microtask flush for state updates.
      await Promise.resolve();
      await Promise.resolve();

      expect(component.deviceCodeInfo).toBeNull();
      expect(component.activeOAuthRequestId).toBeNull();
      expect(component.oauthService).toBeNull();
    });

    it('github_oauth_progress error clears device code + resets oauthService', async () => {
      await component.ngOnInit();
      component.activeOAuthRequestId = 'gh-rid-4';
      component.oauthService = 'github';
      component.deviceCodeInfo = {
        user_code: 'X',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        request_id: 'gh-rid-4',
      };

      mockTauri.dispatchEvent('github_oauth_progress', {
        status: 'error',
        message: 'Device flow not enabled on Speedwave GitHub OAuth App.',
        request_id: 'gh-rid-4',
      });

      expect(component.oauthStatus).toBe('error');
      expect(component.oauthStatusMessage).toContain('Device flow');
      expect(component.deviceCodeInfo).toBeNull();
      expect(component.activeOAuthRequestId).toBeNull();
      expect(component.oauthService).toBeNull();
    });

    it('second click while polling early-returns for GitHub', async () => {
      await component.ngOnInit();
      const githubSvc = component.services.find((s) => s.service === 'github')!;
      component.oauthStatus = 'polling';
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      invokeSpy.mockClear();

      await component.handleStartOAuth({ svc: githubSvc, credentials: {} });

      expect(invokeSpy).not.toHaveBeenCalledWith('start_github_oauth', expect.anything());
    });

    it('handleCancelOAuth dispatches cancel_github_oauth when oauthService is github', async () => {
      await component.ngOnInit();
      component.activeOAuthRequestId = 'gh-rid-5';
      component.oauthService = 'github';
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await component.handleCancelOAuth();

      expect(invokeSpy).toHaveBeenCalledWith('cancel_github_oauth');
      expect(invokeSpy).not.toHaveBeenCalledWith('cancel_sharepoint_oauth', expect.anything());
      expect(component.activeOAuthRequestId).toBeNull();
      expect(component.oauthService).toBeNull();
    });

    it('github_oauth_progress listener cleanup on destroy', async () => {
      await component.ngOnInit();
      expect(mockTauri.listenHandlers['github_oauth_progress']).toBeDefined();

      component.ngOnDestroy();
      expect(mockTauri.listenHandlers['github_oauth_progress']).toBeUndefined();
    });
  });

  describe('handleCancelOAuth()', () => {
    it('invokes cancel command and clears state', async () => {
      await component.ngOnInit();
      component.activeOAuthRequestId = 'rid';
      component.oauthStatus = 'polling';
      component.deviceCodeInfo = {
        user_code: 'CODE',
        verification_uri: 'https://example.com',
        expires_in: 900,
        request_id: 'rid',
      };

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.handleCancelOAuth();

      expect(invokeSpy).toHaveBeenCalledWith('cancel_sharepoint_oauth');
      expect(component.activeOAuthRequestId).toBeNull();
      expect(component.deviceCodeInfo).toBeNull();
      expect(component.oauthStatus).toBeNull();
      expect(component.oauthStatusMessage).toBe('');
    });
  });

  describe('OAuth progress events', () => {
    it('success event triggers loadIntegrations and auto-enable', async () => {
      await component.ngOnInit();
      component.activeOAuthRequestId = 'rid-success';
      // Set private oauthProjectAtStart to match activeProject
      (component as unknown as { oauthProjectAtStart: string | null }).oauthProjectAtStart =
        'test-project';

      const afterOAuthIntegrations = cloneMockIntegrations();
      afterOAuthIntegrations.services = afterOAuthIntegrations.services.map((s) =>
        s.service === 'sharepoint' ? { ...s, configured: true, enabled: false } : s
      );
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [], active_project: 'test-project' };
          case 'get_integrations':
            return afterOAuthIntegrations;
          default:
            return undefined;
        }
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      mockTauri.dispatchEvent('sharepoint_oauth_progress', {
        status: 'success',
        message: 'Authentication successful',
        request_id: 'rid-success',
      });
      await fixture.whenStable();

      expect(component.oauthStatus).toBe('success');
      expect(component.deviceCodeInfo).toBeNull();
      expect(invokeSpy).toHaveBeenCalledWith('set_integration_enabled', {
        project: 'test-project',
        service: 'sharepoint',
        enabled: true,
      });
    });

    it('ignores events with mismatched request_id', async () => {
      await component.ngOnInit();
      component.activeOAuthRequestId = 'current-rid';

      mockTauri.dispatchEvent('sharepoint_oauth_progress', {
        status: 'success',
        message: 'Auth OK',
        request_id: 'stale-rid',
      });
      await fixture.whenStable();

      // Should NOT update status for stale event
      expect(component.oauthStatus).toBeNull();
    });

    it('error event clears deviceCodeInfo and activeOAuthRequestId', async () => {
      await component.ngOnInit();
      component.activeOAuthRequestId = 'rid-err';
      component.deviceCodeInfo = {
        user_code: 'CODE',
        verification_uri: 'https://example.com',
        expires_in: 900,
        request_id: 'rid-err',
      };

      mockTauri.dispatchEvent('sharepoint_oauth_progress', {
        status: 'error',
        message: 'Authorization was declined',
        request_id: 'rid-err',
      });
      await fixture.whenStable();

      expect(component.oauthStatus).toBe('error');
      expect(component.oauthStatusMessage).toBe('Authorization was declined');
      expect(component.deviceCodeInfo).toBeNull();
      expect(component.activeOAuthRequestId).toBeNull();
    });

    it('expired event clears deviceCodeInfo and activeOAuthRequestId', async () => {
      await component.ngOnInit();
      component.activeOAuthRequestId = 'rid-exp';

      mockTauri.dispatchEvent('sharepoint_oauth_progress', {
        status: 'expired',
        message: 'Device code expired',
        request_id: 'rid-exp',
      });
      await fixture.whenStable();

      expect(component.oauthStatus).toBe('expired');
      expect(component.deviceCodeInfo).toBeNull();
      expect(component.activeOAuthRequestId).toBeNull();
    });

    it('cancelled event clears deviceCodeInfo and activeOAuthRequestId', async () => {
      await component.ngOnInit();
      component.activeOAuthRequestId = 'rid-cancel';

      mockTauri.dispatchEvent('sharepoint_oauth_progress', {
        status: 'cancelled',
        message: 'OAuth flow cancelled',
        request_id: 'rid-cancel',
      });
      await fixture.whenStable();

      expect(component.oauthStatus).toBe('cancelled');
      expect(component.deviceCodeInfo).toBeNull();
      expect(component.activeOAuthRequestId).toBeNull();
    });
  });

  describe('retry after error', () => {
    it('can start new flow after previous failed', async () => {
      await component.ngOnInit();
      const sharepointSvc = component.services.find((s) => s.service === 'sharepoint')!;

      // First flow fails
      component.oauthStatus = 'error';
      component.activeOAuthRequestId = null;
      component.oauthStatus = null; // reset after error

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_sharepoint_oauth') {
          return {
            user_code: 'NEW-CODE',
            verification_uri: 'https://example.com',
            expires_in: 900,
            request_id: 'new-rid',
          };
        }
        return undefined;
      };

      await component.handleStartOAuth({
        svc: sharepointSvc,
        credentials: { client_id: '550e8400-e29b-41d4-a716-446655440000', tenant_id: 'common' },
      });

      expect(component.oauthStatus).toBe('polling');
      expect(component.deviceCodeInfo?.user_code).toBe('NEW-CODE');
    });
  });

  describe('autoEnableIfConfigured shared by save and OAuth', () => {
    it('auto-enable used by handleSaveCredentials', async () => {
      await component.ngOnInit();

      const afterSaveIntegrations = cloneMockIntegrations();
      afterSaveIntegrations.services = afterSaveIntegrations.services.map((s) =>
        s.service === 'sharepoint' ? { ...s, configured: true, enabled: false } : s
      );
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [], active_project: 'test-project' };
          case 'get_integrations':
            return afterSaveIntegrations;
          default:
            return undefined;
        }
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.handleSaveCredentials({
        svc: component.services.find((s) => s.service === 'sharepoint')!,
        credentials: { client_id: 'uuid', tenant_id: 'common', site_id: 'site' },
        mappings: null,
      });
      expect(invokeSpy).toHaveBeenCalledWith('set_integration_enabled', {
        project: 'test-project',
        service: 'sharepoint',
        enabled: true,
      });
    });

    it('does not auto-enable if not configured (e.g. site_id missing)', async () => {
      await component.ngOnInit();

      const afterOAuth = cloneMockIntegrations();
      // sharepoint still NOT configured (site_id missing)
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [], active_project: 'test-project' };
          case 'get_integrations':
            return afterOAuth;
          default:
            return undefined;
        }
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      component.activeOAuthRequestId = 'rid-partial';
      (component as unknown as { oauthProjectAtStart: string | null }).oauthProjectAtStart =
        'test-project';
      mockTauri.dispatchEvent('sharepoint_oauth_progress', {
        status: 'success',
        message: 'Auth OK',
        request_id: 'rid-partial',
      });
      await fixture.whenStable();

      expect(invokeSpy).not.toHaveBeenCalledWith(
        'set_integration_enabled',
        expect.objectContaining({
          service: 'sharepoint',
          enabled: true,
        })
      );
    });
  });

  describe('OAuth listener cleanup', () => {
    it('cleans up OAuth listener on destroy', async () => {
      await component.ngOnInit();
      expect(mockTauri.listenHandlers['sharepoint_oauth_progress']).toBeDefined();

      component.ngOnDestroy();
      expect(mockTauri.listenHandlers['sharepoint_oauth_progress']).toBeUndefined();
    });
  });

  describe('handleStartOAuth stale nonce', () => {
    it('discards stale result if nonce changed during await', async () => {
      await component.ngOnInit();
      const sharepointSvc = component.services.find((s) => s.service === 'sharepoint')!;

      // Simulate cancel during the start_sharepoint_oauth invoke by bumping nonce
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_sharepoint_oauth') {
          // Simulate a cancel happening during the await
          await component.handleCancelOAuth();
          return {
            user_code: 'STALE',
            verification_uri: 'https://example.com',
            expires_in: 900,
            request_id: 'stale-rid',
          };
        }
        return undefined;
      };

      await component.handleStartOAuth({
        svc: sharepointSvc,
        credentials: { client_id: '550e8400-e29b-41d4-a716-446655440000', tenant_id: 'common' },
      });

      // Result should be discarded — nonce changed during await
      expect(component.deviceCodeInfo).toBeNull();
      expect(component.activeOAuthRequestId).toBeNull();
      expect(component.oauthStatus).toBeNull();
    });
  });

  describe('double-click prevention', () => {
    it('second handleStartOAuth call returns early due to guard', async () => {
      await component.ngOnInit();
      const sharepointSvc = component.services.find((s) => s.service === 'sharepoint')!;

      // Start first flow — make it hang so status stays 'starting'
      let resolveFirst: (v: unknown) => void;
      const firstPromise = new Promise((r) => (resolveFirst = r));
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_sharepoint_oauth') {
          return firstPromise;
        }
        return undefined;
      };

      const firstCall = component.handleStartOAuth({
        svc: sharepointSvc,
        credentials: { client_id: '550e8400-e29b-41d4-a716-446655440000', tenant_id: 'common' },
      });

      expect(component.oauthStatus).toBe('starting');

      // Second call while first is in-flight — should return immediately
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      invokeSpy.mockClear();
      await component.handleStartOAuth({
        svc: sharepointSvc,
        credentials: { client_id: '550e8400-e29b-41d4-a716-446655440000', tenant_id: 'common' },
      });

      expect(invokeSpy).not.toHaveBeenCalledWith('start_sharepoint_oauth', expect.anything());

      // Clean up first call
      resolveFirst!({
        user_code: 'CODE',
        verification_uri: 'https://example.com',
        expires_in: 900,
        request_id: 'rid',
      });
      await firstCall;
    });
  });

  describe('cancel button visibility in starting state', () => {
    it('expanding sharepoint while oauthStatus is starting renders the service-card child', async () => {
      await component.ngOnInit();
      component.oauthStatus = 'starting';
      component.toggleExpand('sharepoint');
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();

      const serviceCards = fixture.nativeElement.querySelectorAll('app-service-card');
      expect(component.oauthStatus).toBe('starting');
      expect(serviceCards.length).toBeGreaterThan(0);
    });
  });

  describe('success event after project switch', () => {
    it('aborts auto-enable when project changed between start and success', async () => {
      await component.ngOnInit();
      component.activeOAuthRequestId = 'rid-switch';
      (component as unknown as { oauthProjectAtStart: string | null }).oauthProjectAtStart =
        'original-project';

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      // Project has changed (activeProject is 'test-project', flow started on 'original-project')
      mockTauri.dispatchEvent('sharepoint_oauth_progress', {
        status: 'success',
        message: 'Auth OK',
        request_id: 'rid-switch',
      });
      await fixture.whenStable();

      // Should NOT auto-enable because project changed
      expect(invokeSpy).not.toHaveBeenCalledWith(
        'set_integration_enabled',
        expect.objectContaining({ service: 'sharepoint' })
      );
      // But status should still be updated and flow state cleared
      expect(component.oauthStatus).toBe('success');
      expect(component.deviceCodeInfo).toBeNull();
      expect(component.activeOAuthRequestId).toBeNull();
    });
  });

  describe('validateOsIntegrations() migration banner', () => {
    it('calls validate_os_integrations_on_startup on init', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.ngOnInit();
      await component.runInitialOsValidation();

      expect(invokeSpy).toHaveBeenCalledWith(
        'validate_os_integrations_on_startup',
        expect.objectContaining({ project: 'test-project' })
      );
    });

    it('populates osIntegrationsAutoDisabled from validator response', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'validate_os_integrations_on_startup') {
          return [
            {
              service: 'calendar',
              previous_enabled: true,
              new_enabled: false,
              reason:
                'Calendar access was previously denied. Open Terminal and run:\ntccutil reset Calendar pl.speedwave.desktop.calendar\nThen click the toggle again.',
            },
            {
              service: 'mail',
              previous_enabled: true,
              new_enabled: false,
              reason:
                'Mail access was previously denied. Open Terminal and run:\ntccutil reset AppleEvents pl.speedwave.desktop.mail\nThen click the toggle again.',
            },
          ];
        }
        if (cmd === 'list_projects') {
          return {
            projects: [{ name: 'test-project', dir: '/tmp/test' }],
            active_project: 'test-project',
          };
        }
        if (cmd === 'get_integrations') return cloneMockIntegrations();
        if (cmd === 'list_available_ides') return [];
        if (cmd === 'get_selected_ide') return null;
        return undefined;
      };
      await component.ngOnInit();
      await component.runInitialOsValidation();

      expect(component.osIntegrationsAutoDisabled.length).toBe(2);
      expect(component.osIntegrationsAutoDisabled[0].service).toBe('calendar');
      // Calendar reason must contain the calendar sub-identifier and the Calendar
      // TCC service (not Mail/AppleEvents — that would be a regression).
      expect(component.osIntegrationsAutoDisabled[0].reason).toContain(
        'tccutil reset Calendar pl.speedwave.desktop.calendar'
      );
      expect(component.osIntegrationsAutoDisabled[1].service).toBe('mail');
      // Mail reason must use AppleEvents service (kTCCServiceAppleEvents), not 'Mail'.
      expect(component.osIntegrationsAutoDisabled[1].reason).toContain(
        'tccutil reset AppleEvents pl.speedwave.desktop.mail'
      );
    });

    it('renders banner with one entry per auto-disabled service', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'validate_os_integrations_on_startup') {
          return [
            {
              service: 'calendar',
              previous_enabled: true,
              new_enabled: false,
              reason: 'tccutil reset Calendar pl.speedwave.desktop.calendar',
            },
          ];
        }
        if (cmd === 'list_projects') {
          return {
            projects: [{ name: 'test-project', dir: '/tmp/test' }],
            active_project: 'test-project',
          };
        }
        if (cmd === 'get_integrations') return cloneMockIntegrations();
        if (cmd === 'list_available_ides') return [];
        if (cmd === 'get_selected_ide') return null;
        return undefined;
      };
      await component.ngOnInit();
      await component.runInitialOsValidation();
      fixture.detectChanges();

      const bannerEl = fixture.nativeElement.querySelector(
        '[data-testid="integrations-os-auto-disabled"]'
      );
      expect(bannerEl).toBeTruthy();
      expect(bannerEl.textContent).toContain('calendar');
      expect(bannerEl.textContent).toContain(
        'tccutil reset Calendar pl.speedwave.desktop.calendar'
      );
    });

    it('does not render banner when no integrations were auto-disabled', async () => {
      // Default mock returns empty list — banner must not appear.
      await component.ngOnInit();
      await component.runInitialOsValidation();
      fixture.detectChanges();

      const bannerEl = fixture.nativeElement.querySelector(
        '[data-testid="integrations-os-auto-disabled"]'
      );
      expect(bannerEl).toBeFalsy();
    });

    it('dismissOsIntegrationsAutoDisabled clears the banner', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'validate_os_integrations_on_startup') {
          return [
            {
              service: 'reminders',
              previous_enabled: true,
              new_enabled: false,
              reason: 'tccutil reset Reminders pl.speedwave.desktop.reminders',
            },
          ];
        }
        if (cmd === 'list_projects') {
          return {
            projects: [{ name: 'test-project', dir: '/tmp/test' }],
            active_project: 'test-project',
          };
        }
        if (cmd === 'get_integrations') return cloneMockIntegrations();
        if (cmd === 'list_available_ides') return [];
        if (cmd === 'get_selected_ide') return null;
        return undefined;
      };
      await component.ngOnInit();
      await component.runInitialOsValidation();
      expect(component.osIntegrationsAutoDisabled.length).toBe(1);

      component.dismissOsIntegrationsAutoDisabled();

      expect(component.osIntegrationsAutoDisabled.length).toBe(0);
      fixture.detectChanges();
      const bannerEl = fixture.nativeElement.querySelector(
        '[data-testid="integrations-os-auto-disabled"]'
      );
      expect(bannerEl).toBeFalsy();
    });

    it('handles validator errors non-fatally', async () => {
      // Validator throws → component must continue loading integrations
      // (UI cannot be blocked by a TCC validation failure).
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'validate_os_integrations_on_startup') {
          throw new Error('boom');
        }
        if (cmd === 'list_projects') {
          return {
            projects: [{ name: 'test-project', dir: '/tmp/test' }],
            active_project: 'test-project',
          };
        }
        if (cmd === 'get_integrations') return cloneMockIntegrations();
        if (cmd === 'list_available_ides') return [];
        if (cmd === 'get_selected_ide') return null;
        return undefined;
      };
      await component.ngOnInit();
      await component.runInitialOsValidation();

      expect(component.osIntegrationsAutoDisabled).toEqual([]);
      // Integrations loaded normally
      expect(component.services.length).toBeGreaterThan(0);
      expect(component.error).toBe('');
    });
  });

  describe('LoggerService — TCC validation + toggle observability', () => {
    // These tests guarantee the logs ZIP a user sends with a support ticket
    // contains enough breadcrumbs to reconstruct what happened. If a future
    // PR drops a log line by accident, these tests catch it before merge.

    it('logs info on validateOsIntegrations start', async () => {
      await component.ngOnInit();
      await component.runInitialOsValidation();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('validateOsIntegrations start project=test-project')
      );
    });

    it('logs info "no auto-disabled" when validator returns empty list', async () => {
      // Default mock returns [] from validate_os_integrations_on_startup.
      await component.ngOnInit();
      await component.runInitialOsValidation();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('no auto-disabled services')
      );
      // No warn/error in the happy path
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('logs warn per auto-disabled service with reason text', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'validate_os_integrations_on_startup') {
          return [
            {
              service: 'calendar',
              previous_enabled: true,
              new_enabled: false,
              reason: 'tccutil reset Calendar pl.speedwave.desktop.calendar',
            },
            {
              service: 'mail',
              previous_enabled: true,
              new_enabled: false,
              reason: 'tccutil reset AppleEvents pl.speedwave.desktop.mail',
            },
          ];
        }
        if (cmd === 'list_projects') {
          return {
            projects: [{ name: 'test-project', dir: '/tmp/test' }],
            active_project: 'test-project',
          };
        }
        if (cmd === 'get_integrations') return cloneMockIntegrations();
        if (cmd === 'list_available_ides') return [];
        if (cmd === 'get_selected_ide') return null;
        return undefined;
      };
      await component.ngOnInit();
      await component.runInitialOsValidation();

      // One warn line per auto-disabled service, each carrying the recovery text
      // (this is what makes a logs ZIP self-describing — support reads the warn,
      // sees the exact tccutil command the user should run).
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('os.calendar'));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('tccutil reset Calendar pl.speedwave.desktop.calendar')
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('os.mail'));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('tccutil reset AppleEvents pl.speedwave.desktop.mail')
      );
      // Plus a summary info line
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('auto-disabled 2 service(s)')
      );
    });

    it('logs error when validator throws (non-fatal path)', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'validate_os_integrations_on_startup') {
          throw new Error('boom');
        }
        if (cmd === 'list_projects') {
          return {
            projects: [{ name: 'test-project', dir: '/tmp/test' }],
            active_project: 'test-project',
          };
        }
        if (cmd === 'get_integrations') return cloneMockIntegrations();
        if (cmd === 'list_available_ides') return [];
        if (cmd === 'get_selected_ide') return null;
        return undefined;
      };
      await component.ngOnInit();
      await component.runInitialOsValidation();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validateOsIntegrations failed')
      );
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    it('logs info on os toggle click and persist', async () => {
      await component.ngOnInit();
      await component.runInitialOsValidation();
      const calendarOs = component.osIntegrations.find((o) => o.service === 'reminders');
      if (!calendarOs) {
        throw new Error('test fixture must include an os service');
      }

      const fakeEvent = new Event('click');
      vi.spyOn(fakeEvent, 'stopPropagation');
      mockLogger.info.mockClear(); // ignore validate-time info; assert only toggle-time

      await component.onOsToggleClick(calendarOs, fakeEvent);

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('os toggle clicked'));
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(`service=${calendarOs.service}`)
      );
    });

    it('logs warn on os toggle failure with reverted state and reason', async () => {
      await component.ngOnInit();
      await component.runInitialOsValidation();
      const osSvc = component.osIntegrations[0];

      // Make set_os_integration_enabled throw a TCC-like error
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_os_integration_enabled') {
          throw new Error(
            'Calendar access was previously denied. Open Terminal and run:\ntccutil reset Calendar pl.speedwave.desktop.calendar'
          );
        }
        return undefined;
      };
      const fakeEvent = new Event('click');
      vi.spyOn(fakeEvent, 'stopPropagation');
      mockLogger.warn.mockClear();

      await component.onOsToggleClick(osSvc, fakeEvent);

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('os toggle failed'));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('reason='));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('tccutil reset Calendar pl.speedwave.desktop.calendar')
      );
    });
  });

  // FIX-P1-4: re-consent banner when oauth_action_required === 'scope_mismatch'
  describe('SharePoint re-authorisation banner', () => {
    beforeEach(async () => {
      await component.ngOnInit();
    });

    it('renders the banner when sharepoint is expanded and reports scope_mismatch', async () => {
      const sharepointSvc = component.services.find((s) => s.service === 'sharepoint')!;
      sharepointSvc.configured = true;
      sharepointSvc.oauth_action_required = 'scope_mismatch';

      component.toggleExpand('sharepoint');
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      await fixture.whenStable();

      const banner = fixture.nativeElement.querySelector(
        '[data-testid="integrations-oauth-reauth-banner"]'
      );
      expect(banner).toBeTruthy();
      const button = fixture.nativeElement.querySelector(
        '[data-testid="integrations-oauth-reauth-button"]'
      );
      expect(button).toBeTruthy();
    });

    it('renders the banner even when sharepoint reads as NOT configured (stale providerData)', async () => {
      // Malformed/legacy providerData makes the service read as unconfigured,
      // yet the backend now reports scope_mismatch regardless. The user must
      // still be led to re-authorise — the banner must not hinge on configured.
      const sharepointSvc = component.services.find((s) => s.service === 'sharepoint')!;
      sharepointSvc.configured = false;
      sharepointSvc.oauth_action_required = 'scope_mismatch';

      component.toggleExpand('sharepoint');
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      await fixture.whenStable();

      expect(
        fixture.nativeElement.querySelector('[data-testid="integrations-oauth-reauth-banner"]')
      ).toBeTruthy();
    });

    it('does NOT render the banner when oauth_action_required is undefined', async () => {
      const sharepointSvc = component.services.find((s) => s.service === 'sharepoint')!;
      sharepointSvc.configured = true;
      sharepointSvc.oauth_action_required = undefined;

      component.toggleExpand('sharepoint');
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      await fixture.whenStable();

      expect(
        fixture.nativeElement.querySelector('[data-testid="integrations-oauth-reauth-banner"]')
      ).toBeFalsy();
    });

    it('does NOT render the banner for non-sharepoint services even with the flag set', async () => {
      const gitlabSvc = component.services.find((s) => s.service === 'gitlab')!;
      gitlabSvc.configured = true;
      // Defense in depth — backend never sets this for non-sharepoint, but the
      // template gate must enforce it independently.
      (gitlabSvc as { oauth_action_required?: string }).oauth_action_required = 'scope_mismatch';

      component.toggleExpand('gitlab');
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      await fixture.whenStable();

      expect(
        fixture.nativeElement.querySelector('[data-testid="integrations-oauth-reauth-banner"]')
      ).toBeFalsy();
    });

    it('clicking the re-authorise button invokes handleStartOAuth with the stored current_values', async () => {
      const sharepointSvc = component.services.find((s) => s.service === 'sharepoint')!;
      sharepointSvc.configured = true;
      sharepointSvc.oauth_action_required = 'scope_mismatch';
      sharepointSvc.current_values = {
        client_id: 'stored-client',
        tenant_id: 'stored-tenant',
      };

      const handleStartOAuthSpy = vi.spyOn(component, 'handleStartOAuth').mockResolvedValue();

      component.toggleExpand('sharepoint');
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      await fixture.whenStable();

      const button = fixture.nativeElement.querySelector(
        '[data-testid="integrations-oauth-reauth-button"]'
      ) as HTMLButtonElement | null;
      expect(button).toBeTruthy();
      button!.click();

      expect(handleStartOAuthSpy).toHaveBeenCalledWith({
        svc: sharepointSvc,
        credentials: { client_id: 'stored-client', tenant_id: 'stored-tenant' },
      });
    });
  });
});
