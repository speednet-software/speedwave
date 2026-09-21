import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, RouterModule } from '@angular/router';
import { SettingsComponent } from './settings.component';
import { LlmProviderComponent } from './llm-provider/llm-provider.component';
import { TauriService } from '../services/tauri.service';
import { BetaService } from '../services/beta.service';
import { ProjectStateService } from '../services/project-state.service';
import { ThemeService, THEME_IDS, THEME_MODES } from '../services/theme.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { SettingsDirtyService } from './settings-dirty.service';

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

  describe('unsaved-changes modal (SPEED-637)', () => {
    afterEach(() => {
      TestBed.inject(SettingsDirtyService).resolvePrompt('stay');
    });

    it('renders the modal with the dirty section names while a prompt is open', async () => {
      const registry = TestBed.inject(SettingsDirtyService);
      registry.register({ name: 'Telemetry', isDirty: signal(true), save: async () => {} });
      component.ngOnInit();
      await fixture.whenStable();
      const pending = registry.confirmLeave();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const modal = document.querySelector('[data-testid="settings-unsaved-modal"]');
      expect(modal).not.toBeNull();
      expect(document.querySelector('[data-testid="modal-body"]')?.textContent).toContain(
        'Telemetry'
      );
      (document.querySelector('[data-testid="unsaved-stay-btn"]') as HTMLElement).click();
      await expect(pending).resolves.toBe('stay');
    });

    it('the three buttons resolve save / discard / stay', async () => {
      const registry = TestBed.inject(SettingsDirtyService);
      registry.register({ name: 'Security', isDirty: signal(true), save: async () => {} });
      component.ngOnInit();
      await fixture.whenStable();
      const pending = registry.confirmLeave();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      (document.querySelector('[data-testid="unsaved-save-btn"]') as HTMLElement).click();
      await expect(pending).resolves.toBe('save');
      const pending2 = registry.confirmLeave();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      (document.querySelector('[data-testid="unsaved-discard-btn"]') as HTMLElement).click();
      await expect(pending2).resolves.toBe('discard');
    });

    it('factory reset suppresses the next leave prompt', () => {
      const registry = TestBed.inject(SettingsDirtyService);
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      component.onResetCompleted();
      expect(registry.consumeSuppression()).toBe(true);
      expect(navigate).toHaveBeenCalledWith(['/setup'], { replaceUrl: true });
    });
  });
});
