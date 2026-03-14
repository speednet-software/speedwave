import { describe, it, expect, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { PluginDetailComponent } from './plugin-detail.component';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import { JsonSchema } from '../../models/plugin';

const MOCK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    currency: {
      type: 'string',
      enum: ['PLN', 'EUR', 'USD'],
      default: 'PLN',
      description: 'Default currency',
    },
  },
};

const MOCK_PLUGINS = {
  plugins: [
    {
      slug: 'presale',
      name: 'Presale CRM',
      service_id: 'presale',
      version: '1.2.0',
      description: 'CRM integration for presale',
      enabled: true,
      configured: true,
      auth_fields: [],
      current_values: {},
      token_mount: 'ro',
      settings_schema: MOCK_SCHEMA,
      requires_integrations: ['sharepoint'],
    },
  ],
};

const MOCK_PLUGINS_NO_SP = {
  plugins: [
    {
      slug: 'basic-tool',
      name: 'Basic Tool',
      service_id: 'basic-tool',
      version: '1.0.0',
      description: 'No integrations needed',
      enabled: true,
      configured: true,
      auth_fields: [],
      current_values: {},
      token_mount: 'ro',
      settings_schema: null,
      requires_integrations: [],
    },
  ],
};

const MOCK_INTEGRATIONS = {
  services: [
    {
      service: 'sharepoint',
      enabled: false,
      configured: false,
      display_name: 'SharePoint',
      description: 'Microsoft 365',
      auth_fields: [],
      current_values: {},
    },
  ],
  os: [],
};

const MOCK_INTEGRATIONS_CONFIGURED = {
  services: [
    {
      service: 'sharepoint',
      enabled: true,
      configured: true,
      display_name: 'SharePoint',
      description: 'Microsoft 365',
      auth_fields: [],
      current_values: {},
    },
  ],
  os: [],
};

const MOCK_SETTINGS = {
  currency: 'EUR',
};

function defaultInvokeHandler(cmd: string): Promise<unknown> {
  switch (cmd) {
    case 'list_projects':
      return Promise.resolve({
        projects: [{ name: 'test-project', dir: '/tmp/test' }],
        active_project: 'test-project',
      });
    case 'get_plugins':
      return Promise.resolve(JSON.parse(JSON.stringify(MOCK_PLUGINS)));
    case 'plugin_load_settings':
      return Promise.resolve(JSON.parse(JSON.stringify(MOCK_SETTINGS)));
    case 'plugin_save_settings':
      return Promise.resolve(undefined);
    case 'get_integrations':
      return Promise.resolve(JSON.parse(JSON.stringify(MOCK_INTEGRATIONS)));
    default:
      return Promise.resolve(undefined);
  }
}

function createRouteStub(slug: string) {
  return {
    snapshot: {
      paramMap: {
        get: (key: string) => (key === 'slug' ? slug : null),
      },
    },
  };
}

const mockRouter = { navigate: vi.fn() };

async function initAndDetect(
  component: PluginDetailComponent,
  fixture: ComponentFixture<PluginDetailComponent>
): Promise<void> {
  await component.ngOnInit();
  fixture.changeDetectorRef.markForCheck();
  fixture.detectChanges();
}

describe('PluginDetailComponent', () => {
  let mockTauri: MockTauriService;

  function setup(slug = 'presale') {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = defaultInvokeHandler;
    mockRouter.navigate = vi.fn();

    TestBed.configureTestingModule({
      imports: [PluginDetailComponent],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: ActivatedRoute, useValue: createRouteStub(slug) },
        { provide: Router, useValue: mockRouter },
      ],
    });

    // Set activeProject on the SSOT so loadActiveProject() picks it up
    const projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject = 'test-project';

    const fixture = TestBed.createComponent(PluginDetailComponent);
    return { component: fixture.componentInstance, fixture };
  }

  it('should create', () => {
    const { component } = setup();
    expect(component).toBeTruthy();
  });

  it('should load plugin and settings on init', async () => {
    const { component, fixture } = setup();
    await initAndDetect(component, fixture);

    expect(component.plugin).not.toBeNull();
    expect(component.plugin!.slug).toBe('presale');
    expect(component.plugin!.name).toBe('Presale CRM');
    expect(component.settings).toEqual(MOCK_SETTINGS);
  });

  it('should show plugin not found when slug does not match', async () => {
    const { component, fixture } = setup('nonexistent');
    await initAndDetect(component, fixture);

    expect(component.plugin).toBeNull();
    const notFound = fixture.nativeElement.querySelector('[data-testid="plugin-not-found"]');
    expect(notFound).not.toBeNull();
  });

  it('should default to dashboard tab', async () => {
    const { component, fixture } = setup();
    await initAndDetect(component, fixture);

    expect(component.activeTab).toBe('dashboard');
    const dashboardContent = fixture.nativeElement.querySelector(
      '[data-testid="dashboard-content"]'
    );
    expect(dashboardContent).not.toBeNull();
  });

  it('should switch to settings tab', async () => {
    const { component, fixture } = setup();
    await initAndDetect(component, fixture);

    const settingsTab = fixture.nativeElement.querySelector('[data-testid="tab-settings"]');
    settingsTab.click();
    fixture.detectChanges();

    expect(component.activeTab).toBe('settings');
    const settingsContent = fixture.nativeElement.querySelector('[data-testid="settings-content"]');
    expect(settingsContent).not.toBeNull();
  });

  it('should switch back to dashboard tab', async () => {
    const { component, fixture } = setup();
    await initAndDetect(component, fixture);
    component.activeTab = 'settings';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const dashboardTab = fixture.nativeElement.querySelector('[data-testid="tab-dashboard"]');
    dashboardTab.click();
    fixture.detectChanges();

    expect(component.activeTab).toBe('dashboard');
  });

  it('should save settings and show success message', async () => {
    const { component, fixture } = setup();
    await initAndDetect(component, fixture);

    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    await component.onSaveSettings({ currency: 'USD' });
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    expect(invokeSpy).toHaveBeenCalledWith('plugin_save_settings', {
      project: 'test-project',
      slug: 'presale',
      settings: { currency: 'USD' },
    });
    expect(component.success).toBe('Settings saved');
    expect(component.settings).toEqual({ currency: 'USD' });
  });

  it('should show error on save failure', async () => {
    const { component, fixture } = setup();
    await initAndDetect(component, fixture);

    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'plugin_save_settings') throw new Error('save failed');
      return undefined;
    };
    await component.onSaveSettings({ currency: 'USD' });

    expect(component.error).toBe('save failed');
  });

  it('should navigate back to plugins list', async () => {
    const { component, fixture } = setup();
    await initAndDetect(component, fixture);

    const backLink = fixture.nativeElement.querySelector('[data-testid="back-link"]');
    backLink.click();
    expect(mockRouter.navigate).toHaveBeenCalledWith(['/plugins']);
  });

  it('should display plugin description on dashboard tab', async () => {
    const { component, fixture } = setup();
    await initAndDetect(component, fixture);

    const desc = fixture.nativeElement.querySelector('.plugin-description');
    expect(desc).not.toBeNull();
    expect(desc.textContent).toContain('CRM integration for presale');
  });

  it('should show error when get_plugins fails', async () => {
    const { component, fixture } = setup();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_projects')
        return {
          projects: [{ name: 'test-project', dir: '/tmp/test' }],
          active_project: 'test-project',
        };
      if (cmd === 'get_plugins') throw new Error('load failed');
      if (cmd === 'plugin_load_settings') return {};
      return undefined;
    };
    await initAndDetect(component, fixture);

    expect(component.error).toBe('load failed');
  });

  it('should render version badge and configured badge', async () => {
    const { component, fixture } = setup();
    await initAndDetect(component, fixture);

    const versionBadge = fixture.nativeElement.querySelector('.version-badge');
    expect(versionBadge).not.toBeNull();
    expect(versionBadge.textContent).toContain('v1.2.0');

    const configuredBadge = fixture.nativeElement.querySelector('.badge.configured');
    expect(configuredBadge).not.toBeNull();
  });

  // -- Integration status tests --

  it('should show missing integration when not configured', async () => {
    const { component, fixture } = setup();
    await initAndDetect(component, fixture);

    expect(component.missingIntegrations).toEqual(['sharepoint']);
    const status = fixture.nativeElement.querySelector(
      '[data-testid="integration-status-sharepoint"]'
    );
    expect(status).not.toBeNull();
    expect(status.textContent).toContain('Not configured');
  });

  it('should show configured integration', async () => {
    const { component, fixture } = setup();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_integrations')
        return JSON.parse(JSON.stringify(MOCK_INTEGRATIONS_CONFIGURED));
      return defaultInvokeHandler(cmd);
    };
    await initAndDetect(component, fixture);

    expect(component.missingIntegrations).toEqual([]);
    const status = fixture.nativeElement.querySelector(
      '[data-testid="integration-status-sharepoint"]'
    );
    expect(status).not.toBeNull();
    expect(status.textContent).toContain('Connected');
  });

  it('should show Go to Integrations button when integrations missing', async () => {
    const { component, fixture } = setup();
    await initAndDetect(component, fixture);

    const btn = fixture.nativeElement.querySelector('[data-testid="btn-go-integrations"]');
    expect(btn).not.toBeNull();
  });

  it('should navigate to integrations on Go to Integrations click', async () => {
    const { component, fixture } = setup();
    await initAndDetect(component, fixture);

    const btn = fixture.nativeElement.querySelector('[data-testid="btn-go-integrations"]');
    btn.click();
    expect(mockRouter.navigate).toHaveBeenCalledWith(['/integrations']);
  });

  it('should not show Go to Integrations when all integrations configured', async () => {
    const { component, fixture } = setup();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_integrations')
        return JSON.parse(JSON.stringify(MOCK_INTEGRATIONS_CONFIGURED));
      return defaultInvokeHandler(cmd);
    };
    await initAndDetect(component, fixture);

    const btn = fixture.nativeElement.querySelector('[data-testid="btn-go-integrations"]');
    expect(btn).toBeNull();
  });

  it('should not show integration section for plugins without requires_integrations', async () => {
    const { component, fixture } = setup('basic-tool');
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_projects')
        return {
          projects: [{ name: 'test-project', dir: '/tmp/test' }],
          active_project: 'test-project',
        };
      if (cmd === 'get_plugins') return JSON.parse(JSON.stringify(MOCK_PLUGINS_NO_SP));
      if (cmd === 'plugin_load_settings') return {};
      return defaultInvokeHandler(cmd);
    };
    await initAndDetect(component, fixture);

    const requirements = fixture.nativeElement.querySelector(
      '[data-testid="integration-requirements"]'
    );
    expect(requirements).toBeNull();
    const placeholder = fixture.nativeElement.querySelector('.dashboard-placeholder');
    expect(placeholder).not.toBeNull();
  });

  it('should clean up project ready listener on destroy', async () => {
    const { component } = setup();
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
