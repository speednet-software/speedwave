import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { RouterModule } from '@angular/router';
import { SetupWizardComponent } from './setup-wizard.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

describe('SetupWizardComponent', () => {
  let component: SetupWizardComponent;
  let fixture: ComponentFixture<SetupWizardComponent>;
  let mockTauri: MockTauriService;
  let router: Router;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_platform':
          return 'macos';
        case 'check_runtime':
          return 'NotReady';
        case 'init_vm':
        case 'build_images':
        case 'start_containers':
        case 'link_cli':
        case 'create_project':
          return undefined;
        case 'list_projects':
          return { projects: [], active_project: null };
        default:
          return undefined;
      }
    };

    await TestBed.configureTestingModule({
      imports: [SetupWizardComponent, RouterModule.forRoot([])],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(SetupWizardComponent);
    component = fixture.componentInstance;
    router = TestBed.inject(Router);
    fixture.detectChanges();
  });

  it('should create in welcome phase', () => {
    expect(component).toBeTruthy();
    expect(component.phase()).toBe('welcome');
  });

  // Inline currentColor SVG — not a CSS-mask span (breaks under tauri://localhost) nor a static image.
  it('renders the Speedwave logo as an inline theme-adaptive SVG mark', () => {
    const logo = fixture.nativeElement.querySelector(
      'app-logo[role="img"][aria-label="Speedwave"]'
    );
    expect(logo).not.toBeNull();
    expect(logo.querySelector('svg path[fill="currentColor"]')).not.toBeNull();
    expect(logo.getAttribute('style') ?? '').not.toContain('mask');
    expect(fixture.nativeElement.querySelector('img[src*="speedwave-mark-white"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[style*="speedwave-mark-white.svg"]')).toBeNull();
  });

  it('should transition to progress phase on startSetup', async () => {
    const promise = component.startSetup();
    expect(component.phase()).toBe('progress');
    await promise;
  });

  it('should pause at project phase (step 3) during auto steps', async () => {
    await component.startSetup();
    expect(component.phase()).toBe('project');
    expect(component.steps[0].status).toBe('done');
    expect(component.steps[1].status).toBe('done');
    expect(component.steps[2].status).toBe('done');
    expect(component.steps[3].status).toBe('active');
  });

  it('continues the pipeline after the modal reports a created project', async () => {
    await component.startSetup();
    expect(component.phase()).toBe('project');

    await component.onProjectCreated({ name: 'test-proj', dir: '/tmp/test' });

    expect(component.projectName()).toBe('test-proj');
    expect(component.projectDir()).toBe('/tmp/test');
    expect(component.steps[3].status).toBe('done');
  });

  it('defers start_containers — a fresh project has no LLM provider yet', async () => {
    const invokeSpy = vi.spyOn(mockTauri, 'invoke');

    await component.startSetup();
    await component.onProjectCreated({ name: 'test-proj', dir: '/tmp/test' });

    expect(invokeSpy).not.toHaveBeenCalledWith('start_containers', expect.anything());
    expect(component.steps[4].status).toBe('done');
    expect(component.steps[4].detail).toBe('Deferred until a provider is chosen');
  });

  it('should navigate with replaceUrl on completion', async () => {
    vi.useFakeTimers();
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    await component.startSetup();
    await component.onProjectCreated({ name: 'test-proj', dir: '/tmp/test' });

    expect(component.phase()).toBe('complete');

    vi.advanceTimersByTime(1500);

    expect(navigateSpy).toHaveBeenCalledWith(['/settings'], { replaceUrl: true });
    vi.useRealTimers();
  });

  it('should show error on step failure and allow retry', async () => {
    let callCount = 0;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_platform') return 'macos';
      if (cmd === 'list_projects') return { projects: [], active_project: null };
      if (cmd === 'check_runtime') {
        callCount++;
        if (callCount === 1) throw new Error('runtime check failed');
        return 'NotReady';
      }
      return undefined;
    };

    await component.startSetup();
    expect(component.error()).toContain('runtime check failed');
    expect(component.steps[0].status).toBe('error');

    // Retry should work
    await component.retryCurrentStep();
    expect(component.error()).toBeNull();
    expect(component.steps[0].status).toBe('done');
  });

  it('should set platform-specific step descriptions for macOS', async () => {
    await fixture.whenStable();
    expect(component.steps[0].description).toBe('Verify Lima / nerdctl');
    expect(component.steps[1].description).toBe('Create and start the Lima VM');
  });

  it('should set platform-specific step descriptions for windows', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_platform') return 'windows';
      if (cmd === 'list_projects') return { projects: [], active_project: null };
      if (cmd === 'check_runtime') return 'NotReady';
      return undefined;
    };
    const winFixture = TestBed.createComponent(SetupWizardComponent);
    winFixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    expect(winFixture.componentInstance.steps[0].description).toBe('Verify system requirements');
    expect(winFixture.componentInstance.steps[1].description).toBe('Set up WSL2 distribution');
  });

  it('should return to welcome phase on backToWelcome', async () => {
    await component.startSetup();
    component.backToWelcome();
    expect(component.phase()).toBe('welcome');
    expect(component.error()).toBeNull();
  });

  it('should skip project creation step when project already exists', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_platform':
          return 'macos';
        case 'check_runtime':
          return 'Ready';
        case 'list_projects':
          return {
            projects: [{ name: 'existing-project', dir: '/tmp/existing' }],
            active_project: 'existing-project',
          };
        case 'build_images':
        case 'start_containers':
        case 'link_cli':
          return undefined;
        default:
          return undefined;
      }
    };

    await component.startSetup();
    await fixture.whenStable();

    expect(component.steps[3].status).toBe('done');
    expect(component.projectName()).toBe('existing-project');
  });

  it('should prefer active_project over first project in list', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_platform':
          return 'macos';
        case 'check_runtime':
          return 'Ready';
        case 'list_projects':
          return {
            projects: [
              { name: 'first-project', dir: '/tmp/first' },
              { name: 'active-one', dir: '/tmp/active' },
            ],
            active_project: 'active-one',
          };
        case 'build_images':
        case 'start_containers':
        case 'link_cli':
          return undefined;
        default:
          return undefined;
      }
    };

    await component.startSetup();
    await fixture.whenStable();

    expect(component.steps[3].status).toBe('done');
    expect(component.projectName()).toBe('active-one');
  });

  it('should fall back to first project when active_project is stale', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_platform':
          return 'macos';
        case 'check_runtime':
          return 'Ready';
        case 'list_projects':
          return {
            projects: [{ name: 'only-project', dir: '/tmp/x' }],
            active_project: 'deleted-project',
          };
        case 'build_images':
        case 'start_containers':
        case 'link_cli':
          return undefined;
        default:
          return undefined;
      }
    };

    await component.startSetup();
    await fixture.whenStable();

    expect(component.steps[3].status).toBe('done');
    expect(component.projectName()).toBe('only-project');
  });

  it('should set detail text on skipped project step', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_platform':
          return 'macos';
        case 'check_runtime':
          return 'Ready';
        case 'list_projects':
          return {
            projects: [{ name: 'my-project', dir: '/tmp/p' }],
            active_project: 'my-project',
          };
        case 'build_images':
        case 'start_containers':
        case 'link_cli':
          return undefined;
        default:
          return undefined;
      }
    };

    await component.startSetup();
    await fixture.whenStable();

    expect(component.steps[3].status).toBe('done');
    expect(component.steps[3].detail).toBe('Using existing project: my-project');
  });

  describe('terminal-minimal overlay shape', () => {
    it('renders the welcome headline + subtitle + description', () => {
      expect(fixture.nativeElement.querySelector('[data-testid="setup-headline"]')).not.toBeNull();
      const subtitle = fixture.nativeElement.querySelector('[data-testid="setup-subtitle"]');
      expect(subtitle).not.toBeNull();
      expect(subtitle.textContent).toContain('first-run setup');
      const desc = fixture.nativeElement.querySelector('[data-testid="setup-description"]');
      expect(desc).not.toBeNull();
      expect(desc.textContent).toContain('Nothing leaves your machine');
    });

    it('renders a step row per pipeline entry with the correct data-status', async () => {
      await component.startSetup();
      await fixture.whenStable();
      fixture.detectChanges();
      const rows = fixture.nativeElement.querySelectorAll('[data-testid="setup-step"]');
      expect(rows.length).toBe(component.steps.length);
      for (let i = 0; i < rows.length; i++) {
        expect(rows[i].getAttribute('data-status')).toBe(component.steps[i].status);
      }
    });

    it('renders the footer summary with step N of M', async () => {
      await component.startSetup();
      await fixture.whenStable();
      fixture.detectChanges();
      const summary = fixture.nativeElement.querySelector('[data-testid="setup-progress-summary"]');
      expect(summary).not.toBeNull();
      expect(summary.textContent).toMatch(/step \d+ of \d+/);
    });

    it('etaTotalSeconds recomputes when a step transitions to done', async () => {
      const before = component.etaTotalSeconds();
      await component.startSetup();
      await fixture.whenStable();
      const after = component.etaTotalSeconds();
      // ETA is monotonically non-increasing as steps complete.
      expect(after !== null && before !== null && after <= before).toBe(true);
    });
  });
});
