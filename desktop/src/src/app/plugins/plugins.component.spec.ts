import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Router } from '@angular/router';
import { PluginsComponent } from './plugins.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));
import { open } from '@tauri-apps/plugin-dialog';

const MOCK_PLUGINS = {
  plugins: [
    {
      slug: 'presale',
      name: 'Presale CRM',
      service_id: 'presale',
      version: '1.2.0',
      description: 'CRM integration',
      enabled: true,
      configured: true,
      auth_fields: [
        {
          key: 'api_key',
          label: 'API Key',
          field_type: 'password',
          placeholder: 'Enter key',
          is_secret: true,
        },
      ],
      current_values: {},
      token_mount: 'ro',
      settings_schema: null,
      requires_integrations: [],
    },
    {
      slug: 'my-commands',
      name: 'Custom Commands',
      service_id: null,
      version: '0.1.0',
      description: 'Extra commands',
      enabled: false,
      configured: true,
      auth_fields: [],
      current_values: {},
      token_mount: 'ro',
      settings_schema: null,
      requires_integrations: [],
    },
  ],
};

function cloneMockPlugins(): typeof MOCK_PLUGINS {
  return JSON.parse(JSON.stringify(MOCK_PLUGINS));
}

function setupMockTauri(mockTauri: MockTauriService): void {
  mockTauri.invokeHandler = async (cmd: string) => {
    switch (cmd) {
      case 'list_projects':
        return {
          projects: [{ name: 'test-project', dir: '/tmp/test' }],
          active_project: 'test-project',
        };
      case 'get_plugins':
        return cloneMockPlugins();
      default:
        return undefined;
    }
  };
}

describe('PluginsComponent', () => {
  let component: PluginsComponent;
  let fixture: ComponentFixture<PluginsComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    setupMockTauri(mockTauri);

    await TestBed.configureTestingModule({
      imports: [PluginsComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }, provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(PluginsComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    component.ngOnDestroy();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should load active project and plugins on init', async () => {
    await component.ngOnInit();
    expect(component.activeProject).toBe('test-project');
    expect(component.plugins).toHaveLength(2);
  });

  it('should set error when loadPlugins fails', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_projects') return { projects: [], active_project: 'test' };
      if (cmd === 'get_plugins') throw new Error('network error');
      return undefined;
    };
    await component.ngOnInit();
    expect(component.error).toBe('network error');
  });

  it('should not load plugins without active project', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_projects') return { projects: [], active_project: null };
      return undefined;
    };
    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    await component.ngOnInit();
    expect(invokeSpy).not.toHaveBeenCalledWith('get_plugins', expect.anything());
  });

  describe('toggleExpand()', () => {
    it('expands a plugin', () => {
      component.toggleExpand('presale');
      expect(component.expandedPlugin).toBe('presale');
    });

    it('collapses an already expanded plugin', () => {
      component.expandedPlugin = 'presale';
      component.toggleExpand('presale');
      expect(component.expandedPlugin).toBeNull();
    });

    it('switches to a different plugin', () => {
      component.expandedPlugin = 'presale';
      component.toggleExpand('my-commands');
      expect(component.expandedPlugin).toBe('my-commands');
    });
  });

  describe('handleTogglePlugin()', () => {
    it('sets enabled and marks needsRestart', async () => {
      await component.ngOnInit();
      const event = { target: { checked: false } } as unknown as Event;
      await component.handleTogglePlugin({ plugin: component.plugins[0], event });
      expect(component.plugins[0].enabled).toBe(false);
      expect(component.needsRestart).toBe(true);
    });

    it('invokes set_plugin_enabled', async () => {
      await component.ngOnInit();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      const event = { target: { checked: true } } as unknown as Event;
      await component.handleTogglePlugin({ plugin: component.plugins[0], event });
      expect(invokeSpy).toHaveBeenCalledWith('set_plugin_enabled', {
        project: 'test-project',
        serviceId: 'presale',
        enabled: true,
      });
    });

    it('uses slug as serviceId for plugin without service_id', async () => {
      await component.ngOnInit();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      const event = { target: { checked: true } } as unknown as Event;
      // plugins[1] is my-commands with service_id: null
      await component.handleTogglePlugin({ plugin: component.plugins[1], event });
      expect(invokeSpy).toHaveBeenCalledWith('set_plugin_enabled', {
        project: 'test-project',
        serviceId: 'my-commands',
        enabled: true,
      });
    });

    it('reverts checkbox on error', async () => {
      await component.ngOnInit();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_plugin_enabled') throw new Error('failed');
        return undefined;
      };
      const target = { checked: true };
      const event = { target } as unknown as Event;
      await component.handleTogglePlugin({ plugin: component.plugins[0], event });
      expect(target.checked).toBe(false);
      expect(component.error).toBe('failed');
    });
  });

  describe('handleSaveCredentials()', () => {
    it('invokes save_plugin_credentials and reloads', async () => {
      await component.ngOnInit();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.handleSaveCredentials({
        plugin: component.plugins[0],
        credentials: { api_key: 'secret-123' },
      });
      expect(invokeSpy).toHaveBeenCalledWith('save_plugin_credentials', {
        project: 'test-project',
        slug: 'presale',
        credentials: { api_key: 'secret-123' },
      });
      expect(component.needsRestart).toBe(true);
    });

    it('auto-enables plugin after save when configured and not enabled', async () => {
      await component.ngOnInit();
      // Mock: after save, get_plugins returns plugin as configured but not enabled
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_projects')
          return {
            projects: [{ name: 'test-project', dir: '/tmp/test' }],
            active_project: 'test-project',
          };
        if (cmd === 'get_plugins')
          return {
            plugins: [
              {
                ...cloneMockPlugins().plugins[0],
                configured: true,
                enabled: false,
              },
              cloneMockPlugins().plugins[1],
            ],
          };
        return undefined;
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.handleSaveCredentials({
        plugin: component.plugins[0],
        credentials: { api_key: 'secret-123' },
      });
      expect(invokeSpy).toHaveBeenCalledWith('set_plugin_enabled', {
        project: 'test-project',
        serviceId: 'presale',
        enabled: true,
      });
    });

    it('sets error on failure', async () => {
      await component.ngOnInit();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'save_plugin_credentials') throw new Error('save failed');
        return undefined;
      };
      await component.handleSaveCredentials({
        plugin: component.plugins[0],
        credentials: { api_key: 'secret-123' },
      });
      expect(component.error).toBe('save failed');
    });
  });

  describe('handleDeleteCredentials()', () => {
    it('invokes delete_plugin_credentials and marks needsRestart', async () => {
      await component.ngOnInit();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.handleDeleteCredentials(component.plugins[0]);
      expect(invokeSpy).toHaveBeenCalledWith('delete_plugin_credentials', {
        project: 'test-project',
        slug: 'presale',
      });
      expect(component.needsRestart).toBe(true);
    });

    it('sets error on failure', async () => {
      await component.ngOnInit();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'delete_plugin_credentials') throw new Error('delete failed');
        return undefined;
      };
      await component.handleDeleteCredentials(component.plugins[0]);
      expect(component.error).toBe('delete failed');
    });
  });

  describe('handleRemovePlugin()', () => {
    it('invokes remove_plugin and shows success', async () => {
      await component.ngOnInit();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.handleRemovePlugin(component.plugins[0]);
      expect(invokeSpy).toHaveBeenCalledWith('remove_plugin', { slug: 'presale' });
      expect(component.success).toContain('Presale CRM');
      expect(component.needsRestart).toBe(true);
    });

    it('sets error on failure', async () => {
      await component.ngOnInit();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'remove_plugin') throw new Error('remove failed');
        return undefined;
      };
      await component.handleRemovePlugin(component.plugins[0]);
      expect(component.error).toBe('remove failed');
    });
  });

  describe('installPlugin()', () => {
    it('calls open dialog and installs on selection', async () => {
      await component.ngOnInit();
      vi.mocked(open).mockResolvedValue('/tmp/presale-1.0.0.zip');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_plugin') return 'Plugin installed';
        if (cmd === 'list_projects')
          return {
            projects: [{ name: 'test-project', dir: '/tmp/test' }],
            active_project: 'test-project',
          };
        if (cmd === 'get_plugins') return cloneMockPlugins();
        return undefined;
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.installPlugin();
      expect(invokeSpy).toHaveBeenCalledWith('install_plugin', {
        zipPath: '/tmp/presale-1.0.0.zip',
      });
      expect(component.success).toBe('Plugin installed');
      expect(component.needsRestart).toBe(true);
    });

    it('does nothing when dialog is cancelled', async () => {
      await component.ngOnInit();
      vi.mocked(open).mockResolvedValue(null);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.installPlugin();
      expect(invokeSpy).not.toHaveBeenCalledWith('install_plugin', expect.anything());
      expect(component.installing).toBe(false);
    });

    it('sets error on install failure', async () => {
      await component.ngOnInit();
      vi.mocked(open).mockResolvedValue('/tmp/bad.zip');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_plugin') throw new Error('signature invalid');
        return undefined;
      };
      await component.installPlugin();
      expect(component.error).toBe('signature invalid');
      expect(component.installing).toBe(false);
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

  describe('project_switched event', () => {
    it('reloads active project and plugins on project_switched', async () => {
      await component.ngOnInit();
      expect(component.activeProject).toBe('test-project');

      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return {
              projects: [{ name: 'other-project', dir: '/tmp/other' }],
              active_project: 'other-project',
            };
          case 'get_plugins':
            return { plugins: [] };
          default:
            return undefined;
        }
      };

      mockTauri.dispatchEvent('project_switched', 'other-project');
      await fixture.whenStable();
      expect(component.activeProject).toBe('other-project');
      expect(component.plugins).toHaveLength(0);
    });

    it('cleans up project_switched listener on destroy', async () => {
      await component.ngOnInit();
      expect(mockTauri.listenHandlers['project_switched']).toBeDefined();

      component.ngOnDestroy();
      expect(mockTauri.listenHandlers['project_switched']).toBeUndefined();
    });
  });

  describe('navigateToPlugin()', () => {
    it('navigates to plugin detail route', () => {
      const router = TestBed.inject(Router);
      const spy = vi.spyOn(router, 'navigate');
      component.navigateToPlugin('presale');
      expect(spy).toHaveBeenCalledWith(['/plugins', 'presale']);
    });
  });

  describe('empty state', () => {
    it('shows empty state when no plugins installed', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return {
              projects: [{ name: 'test-project', dir: '/tmp/test' }],
              active_project: 'test-project',
            };
          case 'get_plugins':
            return { plugins: [] };
          default:
            return undefined;
        }
      };
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const emptyState = fixture.nativeElement.querySelector('.empty-state');
      expect(emptyState).not.toBeNull();
      expect(emptyState.textContent).toContain('No plugins installed');
    });
  });
});
