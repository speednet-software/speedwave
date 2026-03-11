import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { IntegrationsComponent } from './integrations.component';
import { TauriService } from '../services/tauri.service';
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
        { key: 'token', label: 'Token', field_type: 'password', placeholder: 'glpat-...' },
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
        { key: 'url', label: 'URL', field_type: 'url', placeholder: 'https://...' },
        { key: 'api_key', label: 'API Key', field_type: 'password', placeholder: '' },
      ],
      current_values: {},
      mappings: { tracker: 1 },
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

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    setupMockTauri(mockTauri);

    await TestBed.configureTestingModule({
      imports: [IntegrationsComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

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
    expect(component.services).toHaveLength(2);
    expect(component.osIntegrations).toHaveLength(1);
  });

  it('should filter out hidden services (slack, sharepoint)', async () => {
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
              {
                service: 'sharepoint',
                enabled: false,
                configured: false,
                display_name: 'SharePoint',
                description: 'Documents',
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
    expect(serviceNames).not.toContain('sharepoint');
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
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_projects') return { projects: [], active_project: null };
      return undefined;
    };
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
      expect(component.needsRestart).toBe(true);
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
      expect(component.needsRestart).toBe(true);
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
  });

  describe('handleSaveCredentials()', () => {
    it('invokes save_integration_credentials and reloads', async () => {
      await component.ngOnInit();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.handleSaveCredentials({
        svc: component.services[0],
        credentials: { token: 'glpat-test' },
      });
      expect(invokeSpy).toHaveBeenCalledWith('save_integration_credentials', {
        project: 'test-project',
        service: 'gitlab',
        credentials: { token: 'glpat-test' },
      });
      expect(component.needsRestart).toBe(true);
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
      });
      expect(component.error).toBe('save failed');
    });

    it('auto-enables service after save', async () => {
      await component.ngOnInit();

      const afterSaveIntegrations = {
        ...MOCK_INTEGRATIONS,
        services: MOCK_INTEGRATIONS.services.map((s) =>
          s.service === 'redmine' ? { ...s, configured: true, enabled: false } : s
        ),
      };
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
      });
      expect(invokeSpy).toHaveBeenCalledWith('set_integration_enabled', {
        project: 'test-project',
        service: 'redmine',
        enabled: true,
      });
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
      expect(component.needsRestart).toBe(true);
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

  describe('restartContainers()', () => {
    it('invokes restart_integration_containers and clears needsRestart', async () => {
      await component.ngOnInit();
      component.needsRestart = true;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.restartContainers();
      expect(invokeSpy).toHaveBeenCalledWith('restart_integration_containers', {
        project: 'test-project',
      });
      expect(component.needsRestart).toBe(false);
      expect(component.restarting).toBe(false);
    });

    it('sets restarting during operation', async () => {
      await component.ngOnInit();
      let resolveFn!: () => void;
      mockTauri.invokeHandler = (cmd: string) =>
        new Promise<void>((resolve) => {
          if (cmd === 'restart_integration_containers') resolveFn = resolve;
          else resolve();
        });
      const promise = component.restartContainers();
      expect(component.restarting).toBe(true);
      resolveFn();
      await promise;
      expect(component.restarting).toBe(false);
    });

    it('sets error on failure', async () => {
      await component.ngOnInit();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'restart_integration_containers') throw new Error('restart failed');
        return undefined;
      };
      await component.restartContainers();
      expect(component.error).toBe('restart failed');
      expect(component.restarting).toBe(false);
    });
  });

  describe('toggleService is a no-op when not configured', () => {
    it('does not invoke set_integration_enabled', async () => {
      await component.ngOnInit();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      invokeSpy.mockClear();
      const event = { target: { checked: true } } as unknown as Event;
      await component.toggleService(component.services[1], event);
      expect(invokeSpy).not.toHaveBeenCalledWith('set_integration_enabled', expect.anything());
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

  describe('project_switched event', () => {
    it('reloads active project and integrations on project_switched', async () => {
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

      mockTauri.dispatchEvent('project_switched', 'other-project');
      await fixture.whenStable();
      expect(component.activeProject).toBe('other-project');
      expect(component.services).toHaveLength(0);
    });

    it('cleans up project_switched listener on destroy', async () => {
      await component.ngOnInit();
      expect(mockTauri.listenHandlers['project_switched']).toBeDefined();

      component.ngOnDestroy();
      expect(mockTauri.listenHandlers['project_switched']).toBeUndefined();
    });
  });

  it('renders app-ide-bridge sub-component', async () => {
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const ideBridge = fixture.nativeElement.querySelector('app-ide-bridge');
    expect(ideBridge).not.toBeNull();
  });
});
