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

  describe('getFieldValue()', () => {
    it('returns edited value when present', () => {
      component.editedValues = { gitlab: { token: 'edited-token' } };
      const svc = MOCK_INTEGRATIONS.services[0];
      expect(component.getFieldValue(svc, 'token')).toBe('edited-token');
    });

    it('returns current_values when no edit', () => {
      const svc = { ...MOCK_INTEGRATIONS.services[0], current_values: { token: 'existing' } };
      expect(component.getFieldValue(svc, 'token')).toBe('existing');
    });

    it('returns empty string when no value anywhere', () => {
      const svc = MOCK_INTEGRATIONS.services[0];
      expect(component.getFieldValue(svc, 'token')).toBe('');
    });
  });

  describe('setFieldValue()', () => {
    it('stores edited value', () => {
      const event = { target: { value: 'new-val' } } as unknown as Event;
      component.setFieldValue('gitlab', 'token', event);
      expect(component.editedValues['gitlab']['token']).toBe('new-val');
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

  describe('saveCredentials()', () => {
    it('invokes save_integration_credentials and reloads', async () => {
      await component.ngOnInit();
      component.editedValues = { gitlab: { token: 'glpat-test' } };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      const event = { preventDefault: vi.fn() } as unknown as Event;
      await component.saveCredentials(component.services[0], event);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(invokeSpy).toHaveBeenCalledWith('save_integration_credentials', {
        project: 'test-project',
        service: 'gitlab',
        credentials: { token: 'glpat-test' },
      });
      expect(component.needsRestart).toBe(true);
      expect(component.editedValues['gitlab']).toEqual({});
    });

    it('does nothing when no credentials entered', async () => {
      await component.ngOnInit();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      invokeSpy.mockClear();
      const event = { preventDefault: vi.fn() } as unknown as Event;
      await component.saveCredentials(component.services[0], event);
      expect(invokeSpy).not.toHaveBeenCalledWith('save_integration_credentials', expect.anything());
    });

    it('saves redmine mappings alongside credentials', async () => {
      await component.ngOnInit();
      component.editedValues = { redmine: { url: 'https://redmine.test' } };
      component.editedMappings = { redmine: { tracker: 2, status: 5 } };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      const event = { preventDefault: vi.fn() } as unknown as Event;
      await component.saveCredentials(component.services[1], event);
      expect(invokeSpy).toHaveBeenCalledWith('save_redmine_mappings', {
        project: 'test-project',
        mappings: { tracker: 2, status: 5 },
      });
    });

    it('sets error on failure', async () => {
      await component.ngOnInit();
      component.editedValues = { gitlab: { token: 'glpat-test' } };
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'save_integration_credentials') throw new Error('save failed');
        return undefined;
      };
      const event = { preventDefault: vi.fn() } as unknown as Event;
      await component.saveCredentials(component.services[0], event);
      expect(component.error).toBe('save failed');
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

  describe('unconfigured toggle blocking', () => {
    it('toggle is disabled when service is not configured', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const redmine = component.services.find((s) => s.service === 'redmine')!;
      expect(redmine.configured).toBe(false);
      const cards = fixture.nativeElement.querySelectorAll('.section:nth-of-type(2) .card');
      const redmineCard = cards[1];
      const toggle = redmineCard.querySelector('.toggle');
      const checkbox = redmineCard.querySelector('input[type="checkbox"]');
      expect(checkbox.disabled).toBe(true);
      expect(toggle.classList.contains('disabled')).toBe(true);
    });

    it('toggle is enabled when service is configured', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const gitlab = component.services.find((s) => s.service === 'gitlab')!;
      expect(gitlab.configured).toBe(true);
      const cards = fixture.nativeElement.querySelectorAll('.section:nth-of-type(2) .card');
      const gitlabCard = cards[0];
      const toggle = gitlabCard.querySelector('.toggle');
      const checkbox = gitlabCard.querySelector('input[type="checkbox"]');
      expect(checkbox.disabled).toBe(false);
      expect(toggle.classList.contains('disabled')).toBe(false);
    });

    it('toggleService is a no-op when not configured', async () => {
      await component.ngOnInit();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      invokeSpy.mockClear();
      const event = { target: { checked: true } } as unknown as Event;
      await component.toggleService(component.services[1], event);
      expect(invokeSpy).not.toHaveBeenCalledWith('set_integration_enabled', expect.anything());
    });

    it('deleteCredentials auto-disables the service', async () => {
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

    it('saveCredentials auto-enables the service', async () => {
      await component.ngOnInit();
      const svc = component.services[1];
      svc.configured = false;
      svc.enabled = false;
      component.editedValues = { redmine: { api_key: 'secret123' } };

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
      const event = { preventDefault: vi.fn() } as unknown as Event;
      await component.saveCredentials(svc, event);
      expect(invokeSpy).toHaveBeenCalledWith('set_integration_enabled', {
        project: 'test-project',
        service: 'redmine',
        enabled: true,
      });
    });

    it('OS toggles are never disabled', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const osCards = fixture.nativeElement.querySelectorAll('.os-card');
      expect(osCards.length).toBeGreaterThan(0);
      for (const card of osCards) {
        const checkbox = card.querySelector('input[type="checkbox"]');
        expect(checkbox.disabled).toBe(false);
      }
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

  describe('mapping helpers', () => {
    it('getMappingEntries returns entries from service mappings', async () => {
      await component.ngOnInit();
      const entries = component.getMappingEntries(component.services[1]);
      expect(entries).toEqual([{ key: 'tracker', value: 1 }]);
    });

    it('getMappingEntries returns edited mappings when present', async () => {
      await component.ngOnInit();
      component.editedMappings = { redmine: { status: 3 } };
      const entries = component.getMappingEntries(component.services[1]);
      expect(entries).toEqual([{ key: 'status', value: 3 }]);
    });

    it('addMapping creates a new entry', async () => {
      await component.ngOnInit();
      component.addMapping('redmine');
      const keys = Object.keys(component.editedMappings['redmine']);
      expect(keys.length).toBeGreaterThan(1);
    });

    it('removeMapping deletes an entry', async () => {
      await component.ngOnInit();
      component.editedMappings = { redmine: { tracker: 1, status: 2 } };
      component.removeMapping('redmine', 'tracker');
      expect(component.editedMappings['redmine']['tracker']).toBeUndefined();
      expect(component.editedMappings['redmine']['status']).toBe(2);
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
      await new Promise((r) => setTimeout(r, 0));
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

  describe('IDE Bridge', () => {
    it('loads available IDEs on init', async () => {
      const mockIdes = [
        { ide_name: 'VS Code', port: 3000, ws_url: 'ws://localhost:3000' },
        { ide_name: 'Cursor', port: 3001, ws_url: 'ws://localhost:3001' },
      ];
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
            return mockIdes;
          case 'get_selected_ide':
            return null;
          default:
            return undefined;
        }
      };
      await component.ngOnInit();
      await new Promise((r) => setTimeout(r, 0));
      expect(component.availableIdes).toEqual(mockIdes);
    });

    it('connectIde invokes select_ide and sets selectedIde', async () => {
      await component.ngOnInit();
      const ide = { ide_name: 'VS Code', port: 3000, ws_url: 'ws://localhost:3000' };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.connectIde(ide);
      expect(invokeSpy).toHaveBeenCalledWith('select_ide', { ideName: 'VS Code', port: 3000 });
      expect(component.selectedIde).toEqual({ ide_name: 'VS Code', port: 3000 });
      expect(component.ideConnecting).toBe(false);
    });

    it('connectIde sets error when port is null', async () => {
      await component.ngOnInit();
      const ide = { ide_name: 'VS Code', port: null, ws_url: null };
      await component.connectIde(ide);
      expect(component.ideError).toBe('VS Code has no port — cannot connect');
      expect(component.selectedIde).toBeNull();
    });

    it('connectIde sets error on invoke failure', async () => {
      await component.ngOnInit();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'select_ide') throw new Error('connection refused');
        return undefined;
      };
      const ide = { ide_name: 'VS Code', port: 3000, ws_url: 'ws://localhost:3000' };
      await component.connectIde(ide);
      expect(component.ideError).toBe('Failed to connect to VS Code: Error: connection refused');
      expect(component.ideConnecting).toBe(false);
    });

    it('loads selected IDE from backend on init', async () => {
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
            return [{ ide_name: 'Cursor', port: 4000, ws_url: 'ws://localhost:4000' }];
          case 'get_selected_ide':
            return { ide_name: 'Cursor', port: 4000 };
          default:
            return undefined;
        }
      };
      await component.ngOnInit();
      expect(component.selectedIde).toEqual({ ide_name: 'Cursor', port: 4000 });
    });

    it('IDE bridge event listener sets lastEvent', async () => {
      await component.ngOnInit();
      mockTauri.dispatchEvent('ide_bridge_event', { kind: 'openFile', detail: '/src/main.rs' });
      expect(component.lastEvent).toBe('openFile: /src/main.rs');
    });

    it('ngOnDestroy clears IDE polling and event listener', async () => {
      await component.ngOnInit();
      expect(mockTauri.listenHandlers['ide_bridge_event']).toBeDefined();

      component.ngOnDestroy();

      expect(mockTauri.listenHandlers['ide_bridge_event']).toBeUndefined();
    });
  });
});
