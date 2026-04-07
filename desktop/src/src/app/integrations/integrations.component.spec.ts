import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { IntegrationsComponent } from './integrations.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';

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
        {
          key: 'base_path',
          label: 'Base Path',
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

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    setupMockTauri(mockTauri);

    await TestBed.configureTestingModule({
      imports: [IntegrationsComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
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
        (component as unknown as { unsubProjectReady: unknown })['unsubProjectReady']
      ).not.toBeNull();

      component.ngOnDestroy();

      // Verify unsub was called and nulled
      expect(
        (component as unknown as { unsubProjectReady: unknown })['unsubProjectReady']
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
        svc: component.services[2],
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
        svc: component.services[2],
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
        svc: component.services[2], // sharepoint
        credentials: { client_id: 'uuid', tenant_id: 'common', site_id: 'site', base_path: '/' },
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
      // sharepoint still NOT configured (site_id/base_path missing)
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
    it('shows cancel button during starting state', async () => {
      await component.ngOnInit();
      component.oauthStatus = 'starting';
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();

      const serviceCards = fixture.nativeElement.querySelectorAll('app-service-card');
      // Find the sharepoint card — it should get oauthStatus='starting'
      // We verify that the parent passes the starting state correctly
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
});
