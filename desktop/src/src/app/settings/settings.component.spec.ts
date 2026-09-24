import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { RouterModule } from '@angular/router';
import { SettingsComponent } from './settings.component';
import { LlmProviderComponent } from './llm-provider/llm-provider.component';
import { SecuritySectionComponent } from './security-section/security-section.component';
import { TauriService } from '../services/tauri.service';
import { BetaService } from '../services/beta.service';
import { ProjectStateService } from '../services/project-state.service';
import { ThemeService, THEME_IDS, THEME_MODES } from '../services/theme.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { createDeferred } from '../testing/deferred';

function setupMockTauri(mockTauri: MockTauriService): void {
  mockTauri.invokeHandler = async (cmd: string) => {
    switch (cmd) {
      case 'get_llm_config':
        return { provider: 'anthropic', model: null, base_url: null, default_base_url: null };
      case 'get_update_settings':
        return { auto_check: true, check_interval_hours: 24 };
      case 'get_platform':
        return 'darwin';
      case 'get_auth_status':
        return { api_key_configured: false, oauth_authenticated: false };
      default:
        return undefined;
    }
  };
}

describe('SettingsComponent', () => {
  let component: SettingsComponent;
  let fixture: ComponentFixture<SettingsComponent>;
  let mockTauri: MockTauriService;
  const betaEnabled = signal(true);

  beforeEach(async () => {
    betaEnabled.set(true);
    mockTauri = new MockTauriService();
    setupMockTauri(mockTauri);

    await TestBed.configureTestingModule({
      imports: [SettingsComponent, RouterModule.forRoot([])],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: BetaService, useValue: { enabled: betaEnabled.asReadonly() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SettingsComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    component.ngOnDestroy();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('activeProject starts as null', () => {
    expect(component.activeProject()).toBeNull();
  });

  it('activeProject reflects the project state service signal', () => {
    const projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject.set('test-project');
    expect(component.activeProject()).toBe('test-project');
  });

  it('renders the system-health link in the header (mockup-aligned)', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const link = fixture.nativeElement.querySelector('[data-testid="settings-system-health-link"]');
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('/logs');
    expect(link.textContent).toContain('system health');
  });

  it('does not embed a system-health view inline (moved to /logs)', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const healthEl = fixture.nativeElement.querySelector('app-system-health');
    expect(healthEl).toBeNull();
  });

  it('renders LlmProviderComponent', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const llmEl = fixture.nativeElement.querySelector('app-llm-provider');
    expect(llmEl).not.toBeNull();
  });

  it('renders AdvancedSectionComponent', () => {
    fixture.detectChanges();
    const advancedEl = fixture.nativeElement.querySelector('app-advanced-section');
    expect(advancedEl).not.toBeNull();
  });

  it('renders TranscriptionSectionComponent when beta is enabled', () => {
    fixture.detectChanges();
    const el = fixture.nativeElement.querySelector('app-transcription-section');
    expect(el).not.toBeNull();
  });

  it('hides TranscriptionSectionComponent when beta is disabled', () => {
    betaEnabled.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-transcription-section')).toBeNull();
  });

  it('renders TelemetrySectionComponent when beta is enabled', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-telemetry-section')).not.toBeNull();
  });

  it('hides TelemetrySectionComponent when beta is disabled', () => {
    betaEnabled.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-telemetry-section')).toBeNull();
  });

  it('smooth-scrolls a section into view for a matching URL fragment', () => {
    fixture.detectChanges();
    const section = fixture.nativeElement.querySelector('#section-transcription') as Element;
    expect(section).not.toBeNull();
    const spy = vi.fn();
    (section as unknown as { scrollIntoView: () => void }).scrollIntoView = spy;
    (component as unknown as { scrollToFragment(id: string): void }).scrollToFragment(
      'section-transcription'
    );
    expect(spy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('ignores a null/empty fragment without scrolling', () => {
    fixture.detectChanges();
    const scroll = (component as unknown as { scrollToFragment(id: string | null): void })
      .scrollToFragment;
    expect(() => scroll.call(component, null)).not.toThrow();
  });

  it('schedules a retry when the target section is missing, then clears it on destroy', () => {
    vi.useFakeTimers();
    try {
      fixture.detectChanges();
      const inner = component as unknown as {
        scrollToFragment(id: string | null): void;
        scrollTimer: ReturnType<typeof setTimeout> | null;
      };
      inner.scrollToFragment('section-does-not-exist');
      expect(inner.scrollTimer).not.toBeNull();
      component.ngOnDestroy();
      expect(inner.scrollTimer).toBeNull();
      expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a prior retry timer when scrollToFragment is re-entered', () => {
    vi.useFakeTimers();
    try {
      fixture.detectChanges();
      const inner = component as unknown as {
        scrollToFragment(id: string | null): void;
        scrollTimer: ReturnType<typeof setTimeout> | null;
      };
      inner.scrollToFragment('missing-one');
      const first = inner.scrollTimer;
      expect(first).not.toBeNull();
      inner.scrollToFragment('missing-two');
      expect(inner.scrollTimer).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('switching to a project that settles in auth_required updates the child project input', () => {
    const projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject.set('test-project');
    fixture.detectChanges();

    projectState.activeProject.set('other-project');
    projectState.status.set('auth_required');
    fixture.detectChanges();

    const llmProvider = fixture.debugElement.query(By.directive(LlmProviderComponent));
    expect(llmProvider.componentInstance.activeProject()).toBe('other-project');
  });

  describe('project-scoped sections across a project switch', () => {
    const configs: Record<string, unknown> = {
      'no-llm': {
        provider: 'anthropic',
        model: null,
        base_url: null,
        default_base_url: null,
        providers: [],
      },
      'with-openrouter': {
        provider: 'anthropic',
        model: 'openai/gpt-4o-mini',
        base_url: null,
        default_base_url: null,
        providers: [
          {
            id: 'openrouter',
            kind: 'open_router',
            model: 'openai/gpt-4o-mini',
            has_api_key: true,
            context_tokens: 128000,
          },
        ],
        active: { provider_id: 'openrouter', model: 'openai/gpt-4o-mini' },
      },
    };
    const emptyPolicy = {
      enabled_policies: [],
      forced_policies: [],
      effective_rules: [],
      custom_policies: [],
    };
    let backendProject = 'no-llm';
    let configLoads: string[] = [];
    let policyLoads: string[] = [];
    let authCalls: string[] = [];
    let authStatus: (project: string) => Promise<unknown>;
    let updateLlmConfig: (update: Record<string, unknown>) => Promise<unknown>;
    let updateSecurityPolicy: (project: unknown) => Promise<unknown>;
    let restartLlmProxy: () => Promise<unknown>;

    function refuseUnlessActive(project: unknown): void {
      if (project != null && project !== backendProject) {
        throw new Error(
          `the active project is now '${backendProject}', not '${String(project)}'; nothing was saved`
        );
      }
    }

    beforeEach(() => {
      backendProject = 'no-llm';
      configLoads = [];
      policyLoads = [];
      authCalls = [];
      authStatus = async () => ({ api_key_configured: false, oauth_authenticated: false });
      updateLlmConfig = async (update) => refuseUnlessActive(update['project']);
      updateSecurityPolicy = async (project) => refuseUnlessActive(project);
      restartLlmProxy = async () => undefined;
      const base = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        switch (cmd) {
          case 'get_llm_config': {
            const project = String(args?.['project'] ?? backendProject);
            configLoads.push(project);
            return configs[project];
          }
          case 'get_security_policy':
            policyLoads.push(String(args?.['project'] ?? backendProject));
            return emptyPolicy;
          case 'list_pii_rules':
          case 'list_security_policy_templates':
            return [];
          case 'discover_llm_models':
            return { models: [{ id: 'openai/gpt-4o-mini', context_length: 128000 }] };
          case 'get_auth_status':
            authCalls.push(String(args?.['project']));
            return authStatus(String(args?.['project']));
          case 'update_llm_config':
            return updateLlmConfig(args?.['update'] as Record<string, unknown>);
          case 'update_security_policy':
            return updateSecurityPolicy(args?.['project']);
          case 'restart_llm_proxy':
            return restartLlmProxy();
          default:
            return base(cmd, args);
        }
      };
    });

    async function settle(on: ComponentFixture<SettingsComponent> = fixture): Promise<void> {
      on.detectChanges();
      await on.whenStable();
      await new Promise((resolve) => setTimeout(resolve));
    }

    async function listenToSwitches(): Promise<void> {
      await (
        TestBed.inject(ProjectStateService) as unknown as { setupListeners(): Promise<void> }
      ).setupListeners();
    }

    function startSwitch(to: string): void {
      backendProject = to;
      mockTauri.dispatchEvent('project_switch_started', { project: to });
    }

    function failSwitchBackTo(project: string): void {
      backendProject = project;
      mockTauri.dispatchEvent('project_switch_failed', { project, error: 'switch failed' });
    }

    async function showProject(project: string): Promise<LlmProviderComponent> {
      backendProject = project;
      TestBed.inject(ProjectStateService).activeProject.set(project);
      await settle();
      return llmForm();
    }

    function llmForm(on: ComponentFixture<SettingsComponent> = fixture): LlmProviderComponent {
      return on.debugElement.query(By.directive(LlmProviderComponent))
        .componentInstance as LlmProviderComponent;
    }

    function securitySection(): SecuritySectionComponent {
      return fixture.debugElement.query(By.directive(SecuritySectionComponent))
        .componentInstance as SecuritySectionComponent;
    }

    it('loads the provider form of the project a switch lands on, keeping nothing from the one it left', async () => {
      const before = await showProject('no-llm');
      before.onExtraKeyInput(before.extraProviders()[0], 'sk-or-typed-for-the-project-left');

      const after = await showProject('with-openrouter');

      expect(after).not.toBe(before);
      expect(configLoads).toEqual(['no-llm', 'with-openrouter']);
      const openrouter = after.extraProviders().find((p) => p.id === 'openrouter');
      expect(openrouter?.model).toBe('openai/gpt-4o-mini');
      expect(openrouter?.hasKey).toBe(true);
      expect(openrouter?.contextTokens).toBe(128000);
      expect(openrouter?.keyInput).toBe('');
      expect(openrouter?.keyTouched).toBe(false);
    });

    it('keeps the form and its unsaved input through a switch that fails back to the same project', async () => {
      await listenToSwitches();
      const projectState = TestBed.inject(ProjectStateService);
      const before = await showProject('with-openrouter');
      before.onExtraKeyInput(before.extraProviders()[0], 'sk-or-still-editing');

      startSwitch('no-llm');
      await settle();
      expect(projectState.status()).toBe('switching');
      failSwitchBackTo('with-openrouter');
      await settle();

      expect(projectState.status()).toBe('error');
      expect(projectState.activeProject()).toBe('with-openrouter');
      expect(llmForm()).toBe(before);
      expect(before.extraProviders()[0].keyInput).toBe('sk-or-still-editing');
      expect(configLoads).toEqual(['with-openrouter']);
    });

    it("loads a form opened during a switch for the project the app still shows, so a failed switch saves that project's providers", async () => {
      await listenToSwitches();
      await showProject('with-openrouter');
      startSwitch('no-llm');
      const reopened = TestBed.createComponent(SettingsComponent);
      await settle(reopened);
      failSwitchBackTo('with-openrouter');
      await settle(reopened);
      expect(configLoads).toEqual(['with-openrouter', 'with-openrouter']);
      const sent: Record<string, unknown>[] = [];
      updateLlmConfig = async (update) => {
        refuseUnlessActive(update['project']);
        sent.push(update);
      };

      await llmForm(reopened).saveConfig();

      expect(sent.map((u) => u['project'])).toEqual(['with-openrouter']);
      const saved = sent[0]['providers'] as { id: string; model: string | null }[];
      expect(saved.find((p) => p.id === 'openrouter')?.model).toBe('openai/gpt-4o-mini');
      reopened.destroy();
    });

    it('applies a sign-in status that lands after Settings is left while the app stays on its project', async () => {
      const late = { api_key_configured: true, oauth_authenticated: true };
      const status = createDeferred();
      authStatus = () => status.promise.then(() => late);
      const applied = vi.spyOn(TestBed.inject(ProjectStateService), 'applyAuthStatus');
      await showProject('no-llm');

      fixture.destroy();
      status.resolve();
      await new Promise((resolve) => setTimeout(resolve));

      expect(authCalls).toEqual(['no-llm']);
      expect(applied).toHaveBeenCalledWith(late);
    });

    it('drops a sign-in status for the project a switch left', async () => {
      const left = { api_key_configured: true, oauth_authenticated: true };
      const status = createDeferred();
      authStatus = (project) =>
        project === 'no-llm'
          ? status.promise.then(() => left)
          : Promise.resolve({ api_key_configured: false, oauth_authenticated: false });
      const applied = vi.spyOn(TestBed.inject(ProjectStateService), 'applyAuthStatus');

      await showProject('no-llm');
      await showProject('with-openrouter');
      status.resolve();
      await settle();

      expect(authCalls).toEqual(['no-llm', 'with-openrouter']);
      expect(applied).not.toHaveBeenCalledWith(left);
    });

    it('shows that a save started before a switch saved nothing', async () => {
      await listenToSwitches();
      const sent: unknown[] = [];
      updateLlmConfig = async (update) => {
        sent.push(update['project']);
        refuseUnlessActive(update['project']);
      };
      const form = await showProject('with-openrouter');

      startSwitch('no-llm');
      await form.saveConfig();
      await settle();

      expect(sent).toEqual(['with-openrouter']);
      expect(component.error).toContain('nothing was saved');
    });

    it('still requests the restart of a save that lands after Settings is left', async () => {
      const save = createDeferred();
      updateLlmConfig = () => save.promise;
      const restart = vi.spyOn(TestBed.inject(ProjectStateService), 'requestRestart');
      const warn = vi.spyOn(console, 'warn');
      const form = await showProject('with-openrouter');

      const saving = form.saveConfig();
      await settle();
      fixture.destroy();
      save.resolve();
      await saving;

      expect(restart).toHaveBeenCalledTimes(1);
      expect(
        warn.mock.calls.filter((args) => args.some((a) => String(a).includes('NG0953')))
      ).toEqual([]);
    });

    it('requests no restart for a save that lands after a switch replaced its form', async () => {
      const save = createDeferred();
      updateLlmConfig = () => save.promise;
      const restart = vi.spyOn(TestBed.inject(ProjectStateService), 'requestRestart');
      const before = await showProject('with-openrouter');

      const saving = before.saveConfig();
      await settle();
      await showProject('no-llm');
      save.resolve();
      await saving;

      expect(restart).not.toHaveBeenCalled();
    });

    it('keeps the restart of a save that lands while a switch runs for a switch that fails back', async () => {
      await listenToSwitches();
      const save = createDeferred();
      updateLlmConfig = () => save.promise;
      const projectState = TestBed.inject(ProjectStateService);
      const restart = vi.spyOn(projectState, 'requestRestart');
      const owed = vi.spyOn(projectState, 'requestRestartFor');
      const form = await showProject('with-openrouter');

      const saving = form.saveConfig();
      await settle();
      startSwitch('no-llm');
      save.resolve();
      await saving;

      expect(restart).not.toHaveBeenCalled();
      expect(owed).toHaveBeenCalledWith('with-openrouter');
    });

    it('requests no restart when the proxy restart fails after a switch started', async () => {
      await listenToSwitches();
      const projectState = TestBed.inject(ProjectStateService);
      const restart = vi.spyOn(projectState, 'requestRestart');
      let proxyRestarts = 0;
      restartLlmProxy = async () => {
        proxyRestarts++;
        startSwitch('no-llm');
        throw new Error('proxy restart failed');
      };
      const form = await showProject('with-openrouter');
      projectState.status.set('ready');

      await form.saveConfig();

      expect(proxyRestarts).toBe(1);
      expect(restart).not.toHaveBeenCalled();
    });

    it('recreates the security section for the project a switch lands on', async () => {
      await showProject('no-llm');
      const before = securitySection();

      await showProject('with-openrouter');

      expect(securitySection()).not.toBe(before);
      expect(policyLoads).toEqual(['no-llm', 'with-openrouter']);
    });

    it('requests no restart for a security save that lands after a switch', async () => {
      const save = createDeferred();
      const sent: unknown[] = [];
      updateSecurityPolicy = (project) => {
        sent.push(project);
        return save.promise;
      };
      const restart = vi.spyOn(TestBed.inject(ProjectStateService), 'requestRestart');
      await showProject('with-openrouter');

      const saving = securitySection().save();
      await settle();
      await showProject('no-llm');
      save.resolve();
      await saving;

      expect(sent).toEqual(['with-openrouter']);
      expect(restart).not.toHaveBeenCalled();
    });

    it('still requests the restart of a security save that lands after Settings is left', async () => {
      const save = createDeferred();
      updateSecurityPolicy = () => save.promise;
      const restart = vi.spyOn(TestBed.inject(ProjectStateService), 'requestRestart');
      await showProject('with-openrouter');

      const saving = securitySection().save();
      await settle();
      fixture.destroy();
      save.resolve();
      await saving;

      expect(restart).toHaveBeenCalledTimes(1);
    });

    it('recreates the forms without the dev-mode warning about a re-created collection', async () => {
      const warn = vi.spyOn(console, 'warn');
      await showProject('no-llm');
      await showProject('with-openrouter');

      const recreationWarnings = warn.mock.calls.filter((args) =>
        args.some((a) => String(a).includes('NG0956'))
      );
      expect(recreationWarnings).toEqual([]);
    });
  });

  describe('terminal-minimal restyle', () => {
    it('renders the title in the 44px header band as a view-title', () => {
      fixture.detectChanges();
      const title = fixture.nativeElement.querySelector('[data-testid="settings-title"]');
      expect(title).not.toBeNull();
      expect(title.textContent).toContain('Settings');
      expect(title.classList.contains('view-title')).toBe(true);
    });

    it('renders the shared project pill in the header right slot', () => {
      fixture.detectChanges();
      const pill = fixture.nativeElement.querySelector('app-project-pill');
      expect(pill).not.toBeNull();
    });

    it('does not render the legacy Project info section (project info now lives in the project-pill tooltip)', () => {
      fixture.detectChanges();
      const section = fixture.nativeElement.querySelector(
        '[data-testid="settings-section-project"]'
      );
      expect(section).toBeNull();
    });
  });

  describe('Appearance section', () => {
    beforeEach(() => {
      const theme = TestBed.inject(ThemeService);
      theme.setTheme('crimson');
    });

    it('renders one .theme-card button per registered ThemeService theme', () => {
      fixture.detectChanges();
      const section = fixture.nativeElement.querySelector(
        '[data-testid="settings-section-appearance"]'
      );
      expect(section).not.toBeNull();
      const cards = section.querySelectorAll('button[data-theme-btn]');
      expect(cards.length).toBe(THEME_IDS.length);
      const ids = Array.from(cards).map((b) => (b as HTMLElement).getAttribute('data-theme-btn'));
      expect(ids).toEqual([...THEME_IDS]);
    });

    it('marks the card whose id matches ThemeService.theme() as active', () => {
      const theme = TestBed.inject(ThemeService);
      theme.setTheme('iris');
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const active = fixture.nativeElement.querySelector(
        'button[data-theme-btn="iris"]'
      ) as HTMLButtonElement;
      const inactive = fixture.nativeElement.querySelector(
        'button[data-theme-btn="mint"]'
      ) as HTMLButtonElement;
      expect(active.classList.contains('active')).toBe(true);
      expect(inactive.classList.contains('active')).toBe(false);
      expect(active.getAttribute('aria-pressed')).toBe('true');
      expect(inactive.getAttribute('aria-pressed')).toBe('false');
    });

    it('clicking a card calls ThemeService.setTheme(id)', () => {
      const theme = TestBed.inject(ThemeService);
      fixture.detectChanges();
      const cyanBtn = fixture.nativeElement.querySelector(
        'button[data-theme-btn="cyan"]'
      ) as HTMLButtonElement;
      cyanBtn.click();
      expect(theme.theme()).toBe('cyan');
    });

    it('renders the heading and accent-color label', () => {
      fixture.detectChanges();
      const section = fixture.nativeElement.querySelector(
        '[data-testid="settings-section-appearance"]'
      );
      expect(section.textContent).toContain('Appearance');
      expect(section.textContent).toContain('accent color');
    });

    it('does not toggle theme when the same card is clicked twice (no-op)', () => {
      const theme = TestBed.inject(ThemeService);
      theme.setTheme('ember');
      fixture.detectChanges();
      const emberBtn = fixture.nativeElement.querySelector(
        'button[data-theme-btn="ember"]'
      ) as HTMLButtonElement;
      emberBtn.click();
      expect(theme.theme()).toBe('ember');
    });

    it('renders one MODE button per ThemeMode', () => {
      fixture.detectChanges();
      const section = fixture.nativeElement.querySelector(
        '[data-testid="settings-section-appearance"]'
      );
      const buttons = section.querySelectorAll('button[data-mode-btn]');
      expect(buttons.length).toBe(THEME_MODES.length);
      const ids = Array.from(buttons).map((b) => (b as HTMLElement).getAttribute('data-mode-btn'));
      expect(ids).toEqual([...THEME_MODES]);
    });

    it('marks the MODE button matching ThemeService.mode() as active', () => {
      const theme = TestBed.inject(ThemeService);
      theme.setMode('light');
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const active = fixture.nativeElement.querySelector(
        'button[data-mode-btn="light"]'
      ) as HTMLButtonElement;
      const inactive = fixture.nativeElement.querySelector(
        'button[data-mode-btn="dark"]'
      ) as HTMLButtonElement;
      expect(active.getAttribute('aria-pressed')).toBe('true');
      expect(inactive.getAttribute('aria-pressed')).toBe('false');
      theme.setMode('dark');
    });

    it('clicking a MODE button calls ThemeService.setMode(id)', () => {
      const theme = TestBed.inject(ThemeService);
      fixture.detectChanges();
      const lightBtn = fixture.nativeElement.querySelector(
        'button[data-mode-btn="light"]'
      ) as HTMLButtonElement;
      lightBtn.click();
      expect(theme.mode()).toBe('light');
      theme.setMode('dark');
    });

    it('renders the MODE label above the accent grid', () => {
      fixture.detectChanges();
      const section: HTMLElement = fixture.nativeElement.querySelector(
        '[data-testid="settings-section-appearance"]'
      );
      expect(section.textContent?.toLowerCase()).toContain('mode');
      expect(section.textContent).not.toContain('Backgrounds stay dark');
    });
  });
});
