import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Router } from '@angular/router';
import { PluginsComponent } from './plugins.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';

// `vi.mock` without a factory routes to `__mocks__/@tauri-apps/plugin-dialog.ts`
// — the same shared `vi.fn()` instance the companion spec at
// `shared/create-project-modal/create-project-modal.component.spec.ts`
// uses. Avoids the hoist race that two factory-style mocks would trigger
// under Angular's `isolate: false` Vitest setup.
vi.mock('@tauri-apps/plugin-dialog');
import { open } from '@tauri-apps/plugin-dialog';
const openMock = vi.mocked(open);

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
  let projectState: ProjectStateService;

  beforeEach(async () => {
    // The Angular `unit-test` builder configures Vitest with
    // `isolate: false` (see @angular/build/.../vitest/executor.js), which
    // means module mocks live across spec files in the same run. Without
    // an explicit reset here, `openMock` retains whatever mockResolvedValue
    // the previous spec configured — most visibly,
    // `create-project-modal.component.spec.ts` resolves `open` to a path
    // string, and the next plugins-spec test that calls `open` without
    // setting its own resolved value gets that stale path back. Reset
    // first thing in every beforeEach to keep specs self-contained.
    openMock.mockReset();

    mockTauri = new MockTauriService();
    setupMockTauri(mockTauri);

    await TestBed.configureTestingModule({
      imports: [PluginsComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }, provideRouter([])],
    }).compileComponents();

    projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject = 'test-project';

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
    const projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject = null;
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
      expect(projectState.needsRestart).toBe(true);
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
      expect(projectState.needsRestart).toBe(true);
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

  describe('handleSaveCredentials() ordering', () => {
    it('calls set_plugin_enabled before requestRestart', async () => {
      await component.ngOnInit();
      const callLog: string[] = [];

      mockTauri.invokeHandler = async (cmd: string) => {
        callLog.push(cmd);
        if (cmd === 'get_plugins')
          return {
            plugins: [
              { ...cloneMockPlugins().plugins[0], configured: true, enabled: false },
              cloneMockPlugins().plugins[1],
            ],
          };
        return undefined;
      };

      const originalRequestRestart = projectState.requestRestart.bind(projectState);
      vi.spyOn(projectState, 'requestRestart').mockImplementation(() => {
        callLog.push('requestRestart');
        originalRequestRestart();
      });

      await component.handleSaveCredentials({
        plugin: component.plugins[0],
        credentials: { api_key: 'secret' },
      });

      const enableIdx = callLog.indexOf('set_plugin_enabled');
      const restartIdx = callLog.indexOf('requestRestart');
      expect(enableIdx).toBeGreaterThanOrEqual(0);
      expect(restartIdx).toBeGreaterThanOrEqual(0);
      expect(enableIdx).toBeLessThan(restartIdx);
    });

    it('does not call requestRestart when save_plugin_credentials fails', async () => {
      await component.ngOnInit();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'save_plugin_credentials') throw new Error('save failed');
        return undefined;
      };
      const restartSpy = vi.spyOn(projectState, 'requestRestart');
      await component.handleSaveCredentials({
        plugin: component.plugins[0],
        credentials: { api_key: 'key' },
      });
      expect(restartSpy).not.toHaveBeenCalled();
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
      expect(projectState.needsRestart).toBe(true);
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
      expect(projectState.needsRestart).toBe(true);
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
      openMock.mockResolvedValue('/tmp/presale-1.0.0.zip');
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
      expect(projectState.needsRestart).toBe(true);
    });

    it('does nothing when dialog is cancelled', async () => {
      await component.ngOnInit();
      openMock.mockResolvedValue(null);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.installPlugin();
      expect(invokeSpy).not.toHaveBeenCalledWith('install_plugin', expect.anything());
      expect(component.installing).toBe(false);
    });

    it('sets error on install failure', async () => {
      await component.ngOnInit();
      openMock.mockResolvedValue('/tmp/bad.zip');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_plugin') throw new Error('signature invalid');
        return undefined;
      };
      await component.installPlugin();
      expect(component.error).toBe('signature invalid');
      expect(component.installing).toBe(false);
    });

    it('sets error when file dialog throws', async () => {
      await component.ngOnInit();
      openMock.mockRejectedValue(new Error('dialog permission denied'));
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.installPlugin();
      expect(component.error).toBe('dialog permission denied');
      expect(invokeSpy).not.toHaveBeenCalledWith('install_plugin', expect.anything());
      expect(component.installing).toBe(false);
    });
  });

  describe('install overlay', () => {
    it('shows overlay during installPlugin() and hides after completion', async () => {
      await component.ngOnInit();
      openMock.mockResolvedValue('/tmp/plugin.zip');

      let resolveFn!: (value: string) => void;
      mockTauri.invokeHandler = (cmd: string) => {
        if (cmd === 'install_plugin') {
          return new Promise<string>((resolve) => {
            resolveFn = resolve;
          });
        }
        if (cmd === 'get_plugins') return Promise.resolve(cloneMockPlugins());
        if (cmd === 'list_projects')
          return Promise.resolve({
            projects: [{ name: 'test-project', dir: '/tmp/test' }],
            active_project: 'test-project',
          });
        return Promise.resolve(undefined);
      };

      const promise = component.installPlugin();
      // Flush microtask for open() to resolve, which sets installing=true
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();

      const overlay = fixture.nativeElement.querySelector(
        '[data-testid="plugins-install-overlay"]'
      );
      expect(overlay).not.toBeNull();
      expect(overlay.textContent).toContain('Installing plugin');

      resolveFn('Plugin installed');
      await promise;
      fixture.detectChanges();

      const overlayAfter = fixture.nativeElement.querySelector(
        '[data-testid="plugins-install-overlay"]'
      );
      expect(overlayAfter).toBeNull();
    });

    it('does not show overlay when not installing', async () => {
      await component.ngOnInit();
      fixture.detectChanges();

      const overlay = fixture.nativeElement.querySelector(
        '[data-testid="plugins-install-overlay"]'
      );
      expect(overlay).toBeNull();
    });
  });

  describe('project_switch_succeeded event', () => {
    it('reloads active project and plugins on project_switch_succeeded', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
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

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other-project' });
      await fixture.whenStable();
      expect(component.activeProject).toBe('other-project');
      expect(component.plugins).toHaveLength(0);
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
      const emptyState = fixture.nativeElement.querySelector('[data-testid="empty-state"]');
      expect(emptyState).not.toBeNull();
      expect(emptyState.textContent).toContain('No plugins installed');
    });
  });

  describe('terminal-minimal table layout', () => {
    it('renders the view-title page heading and project pill in the header', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const title = fixture.nativeElement.querySelector('[data-testid="plugins-title"]');
      expect(title).not.toBeNull();
      expect(title.textContent).toContain('Installed plugins');
      expect(title.classList.contains('view-title')).toBe(true);
      // Project pill is the shared <app-project-pill> component.
      const pill = fixture.nativeElement.querySelector('app-project-pill');
      expect(pill).not.toBeNull();
    });

    it('renders one table row per plugin with name, type pill, version, and signed pill', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const rows = fixture.nativeElement.querySelectorAll('tbody tr');
      expect(rows.length).toBe(component.plugins.length);

      const presaleRow = fixture.nativeElement.querySelector('[data-testid="plugins-row-presale"]');
      expect(presaleRow).not.toBeNull();
      const type = presaleRow.querySelector('[data-testid="plugins-row-type"]');
      expect(type).not.toBeNull();
      expect(type.textContent.trim()).toBe('mcp');
      const ver = presaleRow.querySelector('[data-testid="plugins-row-ver"]');
      expect(ver).not.toBeNull();
      expect(ver.textContent.trim()).toContain('v1.2.0');
      const signed = presaleRow.querySelector('[data-testid="plugins-row-signed"]');
      expect(signed).not.toBeNull();
      expect(signed.textContent).toContain('ed25519');
    });

    it('resource plugins (no service_id) render the neutral resource pill', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const row = fixture.nativeElement.querySelector('[data-testid="plugins-row-my-commands"]');
      expect(row).not.toBeNull();
      const type = row.querySelector('[data-testid="plugins-row-type"]');
      expect(type.textContent.trim()).toBe('resource');
    });

    it('clicking a row navigates to /plugins/<slug>', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const router = TestBed.inject(Router);
      const spy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
      const row = fixture.nativeElement.querySelector('[data-testid="plugins-row-presale"]');
      row.click();
      expect(spy).toHaveBeenCalledWith(['/plugins', 'presale']);
    });

    it('row toggle flips enabled state and stops propagation (no navigation)', async () => {
      await component.ngOnInit();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const router = TestBed.inject(Router);
      const navSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
      const target = component.plugins[0];
      const before = target.enabled;
      await component.onRowToggle(target, new MouseEvent('click'));
      // Hold a direct reference because ngOnInit's project-ready listener
      // can re-fetch and replace the plugins array between the await and
      // the assertion in some Angular zone flushes.
      expect(target.enabled).toBe(!before);
      expect(navSpy).not.toHaveBeenCalled();
    });
  });
});
