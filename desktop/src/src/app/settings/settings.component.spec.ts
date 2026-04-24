import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterModule } from '@angular/router';
import { SettingsComponent } from './settings.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';

function setupMockTauri(mockTauri: MockTauriService): void {
  mockTauri.invokeHandler = async (cmd: string) => {
    switch (cmd) {
      case 'list_projects':
        return {
          projects: [{ name: 'test-project', dir: '/tmp/test' }],
          active_project: 'test-project',
        };
      case 'get_llm_config':
        return { provider: 'anthropic', model: null, base_url: null, default_base_url: null };
      case 'get_update_settings':
        return { auto_check: true, check_interval_hours: 24 };
      case 'get_log_level':
        return 'info';
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

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    setupMockTauri(mockTauri);

    await TestBed.configureTestingModule({
      imports: [SettingsComponent, RouterModule.forRoot([])],
      providers: [{ provide: TauriService, useValue: mockTauri }],
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
    expect(component.activeProject).toBeNull();
  });

  it('sets activeProject after loadProjectInfo resolves', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    expect(component.activeProject).toBe('test-project');
  });

  it('does not render SystemHealthComponent when activeProject is null', () => {
    fixture.detectChanges();
    const healthEl = fixture.nativeElement.querySelector('app-system-health');
    expect(healthEl).toBeNull();
  });

  it('renders SystemHealthComponent after activeProject is set', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const healthEl = fixture.nativeElement.querySelector('app-system-health');
    expect(healthEl).not.toBeNull();
  });

  it('renders LlmProviderComponent', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const llmEl = fixture.nativeElement.querySelector('app-llm-provider');
    expect(llmEl).not.toBeNull();
  });

  it('renders AuthSectionComponent', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const authEl = fixture.nativeElement.querySelector('app-auth-section');
    expect(authEl).not.toBeNull();
  });

  it('renders AdvancedSectionComponent', () => {
    fixture.detectChanges();
    const advancedEl = fixture.nativeElement.querySelector('app-advanced-section');
    expect(advancedEl).not.toBeNull();
  });

  it('reloads project info on project_switch_succeeded event', async () => {
    const projectState = TestBed.inject(ProjectStateService);
    await projectState.init();
    component.ngOnInit();
    await fixture.whenStable();
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
        case 'get_auth_status':
          return { api_key_configured: false, oauth_authenticated: false };
        default:
          return undefined;
      }
    };

    mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other-project' });
    await fixture.whenStable();
    expect(component.activeProject).toBe('other-project');
  });

  it('cleans up project ready listener on destroy', async () => {
    const projectState = TestBed.inject(ProjectStateService);
    await projectState.init();
    component.ngOnInit();
    await fixture.whenStable();

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

  describe('terminal-minimal restyle', () => {
    it('renders the title with mono 14px per mockup', () => {
      fixture.detectChanges();
      const title = fixture.nativeElement.querySelector('[data-testid="settings-title"]');
      expect(title).not.toBeNull();
      expect(title.textContent).toContain('Settings');
      expect(title.classList.contains('mono')).toBe(true);
    });

    it('section labels use uppercase tracking-widest mono text', () => {
      fixture.detectChanges();
      const heading = fixture.nativeElement.querySelector(
        '[data-testid="settings-section-project-heading"]'
      );
      expect(heading).not.toBeNull();
      expect(heading.classList.contains('uppercase')).toBe(true);
      expect(heading.classList.contains('tracking-widest')).toBe(true);
      // section label uses mono per tokens spec
      expect(heading.classList.contains('mono')).toBe(true);
    });

    it('project section uses ring-1 callout wrapper without inner border-b', () => {
      fixture.detectChanges();
      const section = fixture.nativeElement.querySelector(
        '[data-testid="settings-section-project"]'
      );
      expect(section).not.toBeNull();
      const wrapper = section.querySelector('.ring-1');
      expect(wrapper).not.toBeNull();
      // Must not use border on the rounded ring wrapper
      expect(wrapper.classList.contains('border')).toBe(false);
      // Rows are separated via divide-y — not via border-b inside the wrapper
      const divider = wrapper.querySelector('.divide-y');
      expect(divider).not.toBeNull();
    });
  });
});
