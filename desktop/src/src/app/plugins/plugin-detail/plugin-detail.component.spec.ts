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
      slug: 'example-plugin',
      name: 'Example Plugin CRM',
      service_id: 'example-plugin',
      version: '1.2.0',
      description: 'CRM integration for example-plugin',
      enabled: true,
      configured: true,
      auth_fields: [],
      current_values: {},
      configured_fields: [],
      token_mount: 'ro',
      settings_schema: MOCK_SCHEMA,
      requires_integrations: ['sharepoint'],
      verification_status: 'verified',
      has_host_bridge: false,
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
      configured_fields: [],
      token_mount: 'ro',
      settings_schema: null,
      requires_integrations: [],
      verification_status: 'verified',
      has_host_bridge: false,
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
      configured_fields: [],
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
      configured_fields: [],
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

  function setup(slug = 'example-plugin') {
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

  /**
   * setup() variant whose get_plugins returns the default plugin carrying an
   * `instructions` value (and an optional verification_status override).
   * Collapses the repeated mockTauri + JSON-clone boilerplate the instruction
   * tests would otherwise duplicate.
   * @param instructions - Markdown to put on the plugin's `instructions` field
   * @param verificationStatus - wire `verification_status` (defaults to 'verified')
   * @returns the component + fixture, ready for `initAndDetect`
   */
  function setupWithInstructions(instructions: string, verificationStatus = 'verified') {
    const ctx = setup();
    mockTauri.invokeHandler = (cmd: string) => {
      if (cmd === 'get_plugins') {
        const resp = JSON.parse(JSON.stringify(MOCK_PLUGINS));
        resp.plugins[0].instructions = instructions;
        resp.plugins[0].verification_status = verificationStatus;
        return Promise.resolve(resp);
      }
      return defaultInvokeHandler(cmd);
    };
    return ctx;
  }

  it('should create', () => {
    const { component } = setup();
    expect(component).toBeTruthy();
  });

  it('should load plugin and settings on init', async () => {
    const { component, fixture } = setup();
    await initAndDetect(component, fixture);

    expect(component.plugin).not.toBeNull();
    expect(component.plugin!.slug).toBe('example-plugin');
    expect(component.plugin!.name).toBe('Example Plugin CRM');
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
      slug: 'example-plugin',
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

    const desc = fixture.nativeElement.querySelector('[data-testid="plugin-description"]');
    expect(desc).not.toBeNull();
    expect(desc.textContent).toContain('CRM integration for example-plugin');
  });

  it('renders manifest instructions as Markdown on the dashboard', async () => {
    const { component, fixture } = setupWithInstructions('## Setup\n\nGenerate a **token** first.');
    await initAndDetect(component, fixture);

    const el = fixture.nativeElement.querySelector('[data-testid="plugin-instructions"]');
    expect(el).not.toBeNull();
    // marked turned the markdown into HTML elements (heading + bold).
    expect(el.querySelector('h2')).not.toBeNull();
    expect(el.querySelector('strong')?.textContent).toBe('token');
  });

  it('keeps the instructions collapsed by default for a configured plugin', async () => {
    // Default MOCK_PLUGINS has `configured: true`, so the disclosure is closed
    // — we don't shout setup steps at someone who's already past setup.
    const { component, fixture } = setupWithInstructions('## Setup\n\nDo the thing.');
    await initAndDetect(component, fixture);

    const details = fixture.nativeElement.querySelector(
      '[data-testid="plugin-instructions-details"]'
    ) as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(
      fixture.nativeElement.querySelector('[data-testid="plugin-instructions-toggle"]')
    ).not.toBeNull();
  });

  it('auto-opens the instructions disclosure for an unconfigured plugin (M10)', async () => {
    // First-time user landing on a plugin with credentials still to fill in
    // should see the setup guide immediately, not hunt for it.
    const { component, fixture } = setup();
    mockTauri.invokeHandler = (cmd: string) => {
      if (cmd === 'get_plugins') {
        const resp = JSON.parse(JSON.stringify(MOCK_PLUGINS));
        resp.plugins[0].instructions = '## Setup\n\nGenerate a token.';
        resp.plugins[0].configured = false;
        return Promise.resolve(resp);
      }
      return defaultInvokeHandler(cmd);
    };
    await initAndDetect(component, fixture);

    const details = fixture.nativeElement.querySelector(
      '[data-testid="plugin-instructions-details"]'
    ) as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(true);
  });

  it('surfaces verification_error for an unverified plugin (M11)', async () => {
    const { component, fixture } = setup();
    mockTauri.invokeHandler = (cmd: string) => {
      if (cmd === 'get_plugins') {
        const resp = JSON.parse(JSON.stringify(MOCK_PLUGINS));
        resp.plugins[0].verification_status = 'signature_invalid';
        resp.plugins[0].verification_error = 'SIGNATURE digest mismatch';
        return Promise.resolve(resp);
      }
      return defaultInvokeHandler(cmd);
    };
    await initAndDetect(component, fixture);

    const banner = fixture.nativeElement.querySelector('[data-testid="plugin-verification-error"]');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('signature_invalid');
    expect(banner.textContent).toContain('SIGNATURE digest mismatch');
  });

  it('does NOT render instructions for an unverified plugin (XSS trust boundary)', async () => {
    // Defence-in-depth: even if the backend (buggily) shipped instructions for
    // an unverified plugin, the template guard must withhold the [innerHTML].
    const { component, fixture } = setupWithInstructions(
      '## Evil\n\n<img src=x onerror=alert(1)>',
      'signature_invalid'
    );
    await initAndDetect(component, fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="plugin-instructions"]')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="plugin-instructions-details"]')
    ).toBeNull();
  });

  it('escapes quotes in markdown link href and title (no attribute breakout)', async () => {
    // A manifest author writing `[x](url "It's a \"quote\"")` should not produce
    // structurally malformed HTML where the embedded `"` breaks out of the
    // attribute. esc() collapses `"` → &quot; and `&` → &amp; before
    // interpolating into the template literal.
    const { component, fixture } = setupWithInstructions(
      '[click](http://example.com/?a="b"&c=d "It\'s a \\"quote\\"")'
    );
    await initAndDetect(component, fixture);
    const link = fixture.nativeElement.querySelector(
      '[data-testid="plugin-instructions"] a'
    ) as HTMLAnchorElement;
    expect(link).not.toBeNull();
    // Browser parses the attribute correctly — no extra siblings, no broken markup.
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    // href contains the literal `"` after the browser un-escaped &quot;.
    expect(link.getAttribute('href')).toContain('"b"');
  });

  it('opens markdown links in a new tab with rel="noopener noreferrer"', async () => {
    // Otherwise a click inside the Tauri webview would navigate the SPA away
    // (state loss) and leak `window.opener` to the linked page.
    const { component, fixture } = setupWithInstructions(
      '## Docs\n\nSee [the spec](https://example.com/spec) for details.'
    );
    await initAndDetect(component, fixture);
    const link = fixture.nativeElement.querySelector(
      '[data-testid="plugin-instructions"] a'
    ) as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('target')).toBe('_blank');
    const rel = link.getAttribute('rel') ?? '';
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
  });

  it('sanitises malicious markdown on the verified path (Angular DomSanitizer)', async () => {
    // The unverified-path test above exercises the @if gate, which short-
    // circuits before marked.parse() runs. This one exercises the verified
    // path so the sanitizer actually applies: <script>, <img onerror>, and
    // javascript: link must not produce live HTML that could execute.
    const { component, fixture } = setupWithInstructions(
      '## Setup\n\n' +
        '<script>window.__pwned=true</script>\n\n' +
        '<img src=x onerror="window.__pwned=true">\n\n' +
        '[click](javascript:alert(1))'
    );
    await initAndDetect(component, fixture);

    const el = fixture.nativeElement.querySelector('[data-testid="plugin-instructions"]');
    expect(el).not.toBeNull();
    const html = el.innerHTML.toLowerCase();
    // Angular's DomSanitizer:
    //   - strips <script> entirely,
    //   - drops on* event-handler attributes (onerror, onclick, …),
    //   - rewrites `javascript:` URLs to `unsafe:javascript:` so the browser
    //     refuses to navigate (the literal string survives but is inert).
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toMatch(/href="javascript:/);
    expect(html).toContain('unsafe:javascript:'); // sanitiser actually ran
    // And the host scope was never poisoned.
    expect(
      (window as unknown as { __pwned?: boolean }).__pwned,
      'sanitiser must prevent inline-script execution'
    ).not.toBe(true);
  });

  it('omits the instructions block when the manifest has none', async () => {
    // Default MOCK_PLUGINS has no `instructions` field.
    const { component, fixture } = setup();
    await initAndDetect(component, fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="plugin-instructions"]')).toBeNull();
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

    const versionBadge = fixture.nativeElement.querySelector('[data-testid="version-badge"]');
    expect(versionBadge).not.toBeNull();
    expect(versionBadge.textContent).toContain('v1.2.0');

    const configuredBadge = fixture.nativeElement.querySelector('[data-testid="configured-badge"]');
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

  describe('terminal-minimal tabs + master toggle', () => {
    it('renders three tabs: dashboard / settings / logs', async () => {
      // `tools` tab was removed (YAGNI — backend never exposed per-plugin
      // tool stats, so `exposedTools` was always `[]`).
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);
      expect(fixture.nativeElement.querySelector('[data-testid="tab-bar"]')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="tab-dashboard"]')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="tab-settings"]')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="tab-logs"]')).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="tab-tools"]'),
        'tools tab should be removed'
      ).toBeNull();
    });

    it('selecting the settings tab swaps the active panel', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);
      component.selectTab('settings');
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="settings-content"]')
      ).not.toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="dashboard-content"]')).toBeNull();
    });

    it('logs tab routes to the global Logs view', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);
      component.selectTab('logs');
      fixture.detectChanges();
      const link = fixture.nativeElement.querySelector('[data-testid="logs-link"]');
      expect(link).not.toBeNull();
      link.click();
      expect(mockRouter.navigate).toHaveBeenCalledWith(['/logs']);
    });

    it('renders the dashboard status card', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);
      expect(fixture.nativeElement.querySelector('[data-testid="status-card"]')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="status-detail"]')).not.toBeNull();
    });

    it('header master toggle calls set_plugin_enabled and flips state', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);
      const target = component.plugin!;
      const before = target.enabled;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.onMasterToggle();
      expect(invokeSpy).toHaveBeenCalledWith(
        'set_plugin_enabled',
        expect.objectContaining({ enabled: !before })
      );
      // Hold a direct reference; project-ready listener can replace this.plugin.
      expect(target.enabled).toBe(!before);
    });
  });

  describe('plugin OAuth flow', () => {
    it('handleStartPluginOAuth invokes start_plugin_oauth and tracks request_id', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_plugin_oauth') return { request_id: 'req-1', expires_in: 3600 };
        return undefined;
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.handleStartPluginOAuth();
      expect(invokeSpy).toHaveBeenCalledWith(
        'start_plugin_oauth',
        expect.objectContaining({ slug: component.plugin!.service_id ?? component.plugin!.slug })
      );
      expect(component.oauthStatus).toBe('starting');
    });

    it('surfaces an error when start_plugin_oauth rejects', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_plugin_oauth') throw new Error('not configured yet');
        return undefined;
      };
      await component.handleStartPluginOAuth();
      expect(component.oauthStatus).toBe('error');
      expect(component.oauthStatusMessage).toContain('not configured');
    });

    it('handleCancelPluginOAuth clears flow state', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);
      component.oauthStatus = 'awaiting_redirect';
      component.oauthRedirectUri = 'http://127.0.0.1:5000/callback';
      await component.handleCancelPluginOAuth();
      expect(component.oauthStatus).toBeNull();
      expect(component.oauthRedirectUri).toBeNull();
    });
  });

  describe('danger zone / uninstall', () => {
    it('renders the danger zone on the dashboard tab', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);
      const dangerZone = fixture.nativeElement.querySelector('[data-testid="danger-zone"]');
      expect(dangerZone).not.toBeNull();
      const uninstallBtn = fixture.nativeElement.querySelector('[data-testid="uninstall-btn"]');
      expect(uninstallBtn).not.toBeNull();
    });

    it('clicking "uninstall" reveals the confirm prompt', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="uninstall-btn"]'
      ) as HTMLButtonElement;
      btn.click();
      fixture.detectChanges();

      expect(component.confirmingRemove).toBe(true);
      expect(
        fixture.nativeElement.querySelector('[data-testid="uninstall-confirm-prompt"]')
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="uninstall-confirm-btn"]')
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="uninstall-cancel-btn"]')
      ).not.toBeNull();
    });

    it('clicking "cancel" hides the confirm prompt without invoking remove_plugin', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);

      // Open confirm prompt by clicking the uninstall button (UI-driven path
      // — keeps OnPush change detection consistent with real user interaction).
      const uninstallBtn = fixture.nativeElement.querySelector(
        '[data-testid="uninstall-btn"]'
      ) as HTMLButtonElement;
      uninstallBtn.click();
      fixture.detectChanges();

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      const cancelBtn = fixture.nativeElement.querySelector(
        '[data-testid="uninstall-cancel-btn"]'
      ) as HTMLButtonElement;
      cancelBtn.click();
      fixture.detectChanges();

      expect(component.confirmingRemove).toBe(false);
      expect(invokeSpy).not.toHaveBeenCalledWith('remove_plugin', expect.anything());
    });

    it('clicking "yes, uninstall" invokes remove_plugin with the slug', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      // Drive through the public API (button → confirm → invoke).
      component.confirmingRemove = true;
      await component.onConfirmUninstall();

      expect(invokeSpy).toHaveBeenCalledWith('remove_plugin', { slug: 'example-plugin' });
    });

    it('on success, signals restart and navigates back to /plugins', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);
      const projectState = TestBed.inject(ProjectStateService);
      projectState.needsRestart = false;

      await component.onConfirmUninstall();

      expect(projectState.needsRestart).toBe(true);
      expect(mockRouter.navigate).toHaveBeenCalledWith(['/plugins']);
    });

    it('on error, surfaces the message and resets state', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);
      mockTauri.invokeHandler = (cmd: string) => {
        if (cmd === 'remove_plugin') return Promise.reject(new Error('remove failed'));
        return defaultInvokeHandler(cmd);
      };
      component.confirmingRemove = true;

      await component.onConfirmUninstall();

      expect(component.error).toBe('remove failed');
      expect(component.removing).toBe(false);
      expect(component.confirmingRemove).toBe(false);
      expect(mockRouter.navigate).not.toHaveBeenCalledWith(['/plugins']);
    });

    it('in-flight guard: a second onConfirmUninstall while removing is a no-op', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);
      component.removing = true;

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.onConfirmUninstall();

      expect(invokeSpy).not.toHaveBeenCalledWith('remove_plugin', expect.anything());
    });

    it('disables both buttons via [disabled] while removing is true', async () => {
      const { component, fixture } = setup();
      await initAndDetect(component, fixture);

      // Hold remove_plugin pending so we observe the buttons in their
      // mid-flight (`removing = true`) state before the invoke resolves.
      let resolveFn!: () => void;
      mockTauri.invokeHandler = (cmd: string) => {
        if (cmd === 'remove_plugin') {
          return new Promise<void>((resolve) => {
            resolveFn = resolve;
          });
        }
        return defaultInvokeHandler(cmd);
      };

      // Open the confirm prompt via UI.
      const uninstallBtn = fixture.nativeElement.querySelector(
        '[data-testid="uninstall-btn"]'
      ) as HTMLButtonElement;
      uninstallBtn.click();
      fixture.detectChanges();

      // Kick off uninstall but do not await — we want to observe the UI
      // while the invoke is still pending.
      const promise = component.onConfirmUninstall();
      // Yield once so onConfirmUninstall sets `removing = true` and calls
      // markForCheck before we re-render.
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();

      const confirmBtn = fixture.nativeElement.querySelector(
        '[data-testid="uninstall-confirm-btn"]'
      ) as HTMLButtonElement;
      const cancelBtn = fixture.nativeElement.querySelector(
        '[data-testid="uninstall-cancel-btn"]'
      ) as HTMLButtonElement;
      expect(confirmBtn.disabled).toBe(true);
      expect(cancelBtn.disabled).toBe(true);

      // Resolve so the test does not leak a pending Promise.
      resolveFn();
      await promise;
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Credentials in Settings tab
  // ───────────────────────────────────────────────────────────────────────
  describe('credentials section in Settings tab', () => {
    /**
     * Mock plugin entry with two auth_fields — one required PAT, one
     * optional OAuth token. Mirrors a host-bridged plugin manifest shape.
     */
    const PLUGIN_WITH_AUTH = {
      plugins: [
        {
          slug: 'example-plugin',
          name: 'Example Plugin Bridge',
          service_id: 'example-plugin',
          version: '0.1.1',
          description: 'Example Plugin integration',
          enabled: false,
          configured: false,
          auth_fields: [
            {
              key: 'example_pat',
              label: 'Example Plugin Personal Access Token',
              field_type: 'password',
              placeholder: 'tok_...',
              is_secret: true,
              required: true,
            },
            {
              key: 'example_oauth',
              label: 'Example Plugin OAuth Token',
              field_type: 'password',
              placeholder: 'oauth_...',
              is_secret: true,
              required: false,
            },
          ],
          current_values: {},
          configured_fields: [],
          token_mount: 'ro',
          settings_schema: null,
          requires_integrations: [],
          verification_status: 'verified',
          has_host_bridge: false,
        },
      ],
    };

    function setupWithAuth(slug = 'example-plugin') {
      const mockTauri = new MockTauriService();
      mockTauri.invokeHandler = (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return Promise.resolve({
              projects: [{ name: 'test-project', dir: '/tmp/test' }],
              active_project: 'test-project',
            });
          case 'get_plugins':
            return Promise.resolve(JSON.parse(JSON.stringify(PLUGIN_WITH_AUTH)));
          case 'plugin_load_settings':
            return Promise.resolve({});
          case 'get_integrations':
            return Promise.resolve(JSON.parse(JSON.stringify(MOCK_INTEGRATIONS)));
          default:
            return Promise.resolve(undefined);
        }
      };

      TestBed.configureTestingModule({
        imports: [PluginDetailComponent],
        providers: [
          { provide: TauriService, useValue: mockTauri },
          { provide: ActivatedRoute, useValue: createRouteStub(slug) },
          { provide: Router, useValue: mockRouter },
        ],
      });

      const projectState = TestBed.inject(ProjectStateService);
      projectState.activeProject = 'test-project';

      const fixture = TestBed.createComponent(PluginDetailComponent);
      return { component: fixture.componentInstance, fixture, mockTauri };
    }

    // ── Happy path ────────────────────────────────────────────────────────

    it('renders the credentials section in Settings tab when auth_fields present', async () => {
      const { component, fixture } = setupWithAuth();
      await initAndDetect(component, fixture);
      component.selectTab('settings');
      fixture.detectChanges();

      const section = fixture.nativeElement.querySelector('[data-testid="credentials-section"]');
      expect(section).not.toBeNull();
      const form = fixture.nativeElement.querySelector('[data-testid="plugin-credentials-form"]');
      expect(form).not.toBeNull();
    });

    it('does not render the credentials section when auth_fields is empty', async () => {
      const { component, fixture } = setup(); // uses MOCK_PLUGINS (empty auth_fields)
      await initAndDetect(component, fixture);
      component.selectTab('settings');
      fixture.detectChanges();

      const section = fixture.nativeElement.querySelector('[data-testid="credentials-section"]');
      expect(section).toBeNull();
    });

    it('shows "no credentials or settings" when both auth_fields empty and schema null', async () => {
      const mockTauri = new MockTauriService();
      mockTauri.invokeHandler = (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return Promise.resolve({
              projects: [{ name: 'test-project', dir: '/tmp/test' }],
              active_project: 'test-project',
            });
          case 'get_plugins':
            return Promise.resolve(JSON.parse(JSON.stringify(MOCK_PLUGINS_NO_SP)));
          case 'plugin_load_settings':
            return Promise.resolve({});
          case 'get_integrations':
            return Promise.resolve(JSON.parse(JSON.stringify(MOCK_INTEGRATIONS)));
          default:
            return Promise.resolve(undefined);
        }
      };

      TestBed.configureTestingModule({
        imports: [PluginDetailComponent],
        providers: [
          { provide: TauriService, useValue: mockTauri },
          { provide: ActivatedRoute, useValue: createRouteStub('basic-tool') },
          { provide: Router, useValue: mockRouter },
        ],
      });
      const projectState = TestBed.inject(ProjectStateService);
      projectState.activeProject = 'test-project';

      const fixture = TestBed.createComponent(PluginDetailComponent);
      const component = fixture.componentInstance;
      await initAndDetect(component, fixture);
      component.selectTab('settings');
      fixture.detectChanges();

      const msg = fixture.nativeElement.querySelector('[data-testid="no-settings-msg"]');
      expect(msg).not.toBeNull();
    });

    it('onSaveCredentials invokes save_plugin_credentials with correct args', async () => {
      const { component, fixture, mockTauri } = setupWithAuth();
      await initAndDetect(component, fixture);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await component.onSaveCredentials({
        credentials: { example_pat: 'tok_REAL_TOKEN' },
      });

      expect(invokeSpy).toHaveBeenCalledWith('save_plugin_credentials', {
        project: 'test-project',
        slug: 'example-plugin',
        credentials: { example_pat: 'tok_REAL_TOKEN' },
      });
      expect(component.success).toContain('1 field');
    });

    it('onSaveCredentials with 2 fields shows pluralized success message', async () => {
      const { component, fixture } = setupWithAuth();
      await initAndDetect(component, fixture);

      await component.onSaveCredentials({
        credentials: { example_pat: 'a', example_oauth: 'b' },
      });

      expect(component.success).toContain('2 fields');
    });

    // ── Error paths ───────────────────────────────────────────────────────

    it('onSaveCredentials surfaces Tauri errors in component.error', async () => {
      const { component, fixture, mockTauri } = setupWithAuth();
      await initAndDetect(component, fixture);
      mockTauri.invokeHandler = (cmd: string) => {
        if (cmd === 'save_plugin_credentials') {
          return Promise.reject(new Error('signature verification failed'));
        }
        return Promise.resolve(undefined);
      };

      await component.onSaveCredentials({ credentials: { example_pat: 'x' } });

      expect(component.error).toContain('signature verification failed');
      expect(component.success).toBe('');
    });

    it('onSaveCredentials sets an error (not silent return) when plugin is null', async () => {
      const { component, fixture, mockTauri } = setupWithAuth();
      // Intentionally do NOT init — plugin stays null
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.onSaveCredentials({ credentials: { example_pat: 'x' } });
      expect(invokeSpy).not.toHaveBeenCalled();
      expect(component.error).toContain('No active project');
      expect(fixture).toBeDefined();
    });

    it('save success requests a container restart', async () => {
      const { component, fixture } = setupWithAuth();
      await initAndDetect(component, fixture);
      const projectState = TestBed.inject(ProjectStateService);
      projectState.needsRestart = false;

      await component.onSaveCredentials({ credentials: { example_pat: 'tok_X' } });

      expect(projectState.needsRestart).toBe(true);
    });

    it('save refreshes the plugin entry so the configured badge can flip', async () => {
      // PLUGIN_WITH_AUTH starts configured:false. After a successful save,
      // loadPlugin re-fetches; if the backend now reports configured:true,
      // the component reflects it. We simulate that by switching the
      // get_plugins response post-save.
      const { component, fixture, mockTauri } = setupWithAuth();
      await initAndDetect(component, fixture);
      expect(component.plugin?.configured).toBe(false);

      const configuredVariant = JSON.parse(JSON.stringify(PLUGIN_WITH_AUTH));
      configuredVariant.plugins[0].configured = true;
      mockTauri.invokeHandler = (cmd: string) => {
        if (cmd === 'save_plugin_credentials') return Promise.resolve(undefined);
        if (cmd === 'get_plugins') return Promise.resolve(configuredVariant);
        return Promise.resolve(undefined);
      };

      await component.onSaveCredentials({ credentials: { example_pat: 'tok_X' } });

      expect(component.plugin?.configured).toBe(true);
    });

    it('save success message survives a post-save refresh failure', async () => {
      // Invariant (2) from runPluginMutation: a loadPlugin failure must not
      // clobber the success message — the credentials were already saved.
      const { component, fixture, mockTauri } = setupWithAuth();
      await initAndDetect(component, fixture);
      mockTauri.invokeHandler = (cmd: string) => {
        if (cmd === 'save_plugin_credentials') return Promise.resolve(undefined);
        if (cmd === 'get_plugins') return Promise.reject(new Error('reload failed'));
        return Promise.resolve(undefined);
      };

      await component.onSaveCredentials({ credentials: { example_pat: 'tok_X' } });

      expect(component.success).toContain('Credentials saved');
      expect(component.error).toBe('');
    });

    // ── Reset flow (confirmingReset pattern, no window.confirm) ─────────────

    it('clear event from the form opens the confirm prompt instead of deleting', async () => {
      const { component, fixture, mockTauri } = setupWithAuth();
      await initAndDetect(component, fixture);
      component.selectTab('settings');
      fixture.detectChanges();

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      const resetBtn = fixture.nativeElement.querySelector(
        '[data-testid="reset-credentials-btn"]'
      ) as HTMLButtonElement;
      resetBtn.click();
      fixture.detectChanges();

      // No delete yet — only the confirm prompt is shown.
      expect(component.confirmingReset).toBe(true);
      expect(
        fixture.nativeElement.querySelector('[data-testid="reset-confirm-prompt"]')
      ).not.toBeNull();
      const deleteCall = invokeSpy.mock.calls.find((c) => c[0] === 'delete_plugin_credentials');
      expect(deleteCall).toBeUndefined();
    });

    it('confirm button invokes delete_plugin_credentials', async () => {
      const { component, fixture, mockTauri } = setupWithAuth();
      await initAndDetect(component, fixture);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await component.onResetCredentials();

      expect(invokeSpy).toHaveBeenCalledWith('delete_plugin_credentials', {
        project: 'test-project',
        slug: 'example-plugin',
      });
      expect(component.success).toContain('cleared');
    });

    it('reset clears confirmingReset + resetting flags after success', async () => {
      const { component, fixture } = setupWithAuth();
      await initAndDetect(component, fixture);
      component.confirmingReset = true;

      await component.onResetCredentials();

      expect(component.confirmingReset).toBe(false);
      expect(component.resetting).toBe(false);
    });

    it('reset success requests a container restart', async () => {
      const { component, fixture } = setupWithAuth();
      await initAndDetect(component, fixture);
      const projectState = TestBed.inject(ProjectStateService);
      projectState.needsRestart = false;

      await component.onResetCredentials();

      expect(projectState.needsRestart).toBe(true);
    });

    it('onResetCredentials sets an error (not silent return) when plugin is null', async () => {
      const { component, fixture, mockTauri } = setupWithAuth();
      // Do NOT init — plugin stays null
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.onResetCredentials();
      expect(invokeSpy).not.toHaveBeenCalled();
      expect(component.error).toContain('No active project');
      expect(fixture).toBeDefined();
    });

    it('onResetCredentials surfaces Tauri errors in component.error', async () => {
      const { component, fixture, mockTauri } = setupWithAuth();
      await initAndDetect(component, fixture);
      mockTauri.invokeHandler = (cmd: string) => {
        if (cmd === 'delete_plugin_credentials') {
          return Promise.reject(new Error('IO error: permission denied'));
        }
        return Promise.resolve(undefined);
      };

      await component.onResetCredentials();

      expect(component.error).toContain('permission denied');
    });

    // ── #6: per-field clear ─────────────────────────────────────────────────

    it('onClearField invokes delete_plugin_credential_field with the key', async () => {
      const { component, fixture, mockTauri } = setupWithAuth();
      await initAndDetect(component, fixture);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await component.onClearField('example_pat');

      expect(invokeSpy).toHaveBeenCalledWith('delete_plugin_credential_field', {
        project: 'test-project',
        slug: 'example-plugin',
        key: 'example_pat',
      });
      expect(component.success).toContain('example_pat');
    });

    it('onClearField sets an error (not silent return) when plugin is null', async () => {
      const { component, fixture, mockTauri } = setupWithAuth();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.onClearField('example_pat');
      expect(invokeSpy).not.toHaveBeenCalled();
      expect(component.error).toContain('No active project');
      expect(fixture).toBeDefined();
    });

    it('passes configured_fields to the credentials form so the "set" badge renders', async () => {
      const withConfigured = JSON.parse(JSON.stringify(PLUGIN_WITH_AUTH));
      withConfigured.plugins[0].configured_fields = ['example_pat'];
      const mockTauri = new MockTauriService();
      mockTauri.invokeHandler = (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return Promise.resolve({
              projects: [{ name: 'test-project', dir: '/tmp/test' }],
              active_project: 'test-project',
            });
          case 'get_plugins':
            return Promise.resolve(withConfigured);
          case 'plugin_load_settings':
            return Promise.resolve({});
          case 'get_integrations':
            return Promise.resolve(JSON.parse(JSON.stringify(MOCK_INTEGRATIONS)));
          default:
            return Promise.resolve(undefined);
        }
      };
      TestBed.configureTestingModule({
        imports: [PluginDetailComponent],
        providers: [
          { provide: TauriService, useValue: mockTauri },
          { provide: ActivatedRoute, useValue: createRouteStub('example-plugin') },
          { provide: Router, useValue: mockRouter },
        ],
      });
      const projectState = TestBed.inject(ProjectStateService);
      projectState.activeProject = 'test-project';
      const fixture = TestBed.createComponent(PluginDetailComponent);
      const component = fixture.componentInstance;
      await initAndDetect(component, fixture);
      component.selectTab('settings');
      fixture.detectChanges();

      const badges = fixture.nativeElement.querySelectorAll(
        '[data-testid="cred-configured-badge"]'
      );
      expect(badges.length).toBe(1);
    });

    // ── M3: verification-status guard ───────────────────────────────────────

    it('hides the credentials section when the plugin is not verified', async () => {
      const unverified = JSON.parse(JSON.stringify(PLUGIN_WITH_AUTH));
      unverified.plugins[0].verification_status = 'invalid_signature';
      const mockTauri = new MockTauriService();
      mockTauri.invokeHandler = (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return Promise.resolve({
              projects: [{ name: 'test-project', dir: '/tmp/test' }],
              active_project: 'test-project',
            });
          case 'get_plugins':
            return Promise.resolve(unverified);
          case 'plugin_load_settings':
            return Promise.resolve({});
          case 'get_integrations':
            return Promise.resolve(JSON.parse(JSON.stringify(MOCK_INTEGRATIONS)));
          default:
            return Promise.resolve(undefined);
        }
      };

      TestBed.configureTestingModule({
        imports: [PluginDetailComponent],
        providers: [
          { provide: TauriService, useValue: mockTauri },
          { provide: ActivatedRoute, useValue: createRouteStub('example-plugin') },
          { provide: Router, useValue: mockRouter },
        ],
      });
      const projectState = TestBed.inject(ProjectStateService);
      projectState.activeProject = 'test-project';

      const fixture = TestBed.createComponent(PluginDetailComponent);
      const component = fixture.componentInstance;
      await initAndDetect(component, fixture);
      component.selectTab('settings');
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="credentials-section"]')).toBeNull();
    });
  });
});
