import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { RouterModule } from '@angular/router';
import { SetupWizardComponent } from './setup-wizard.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

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
    expect(component.phase).toBe('welcome');
  });

  it('should transition to progress phase on startSetup', async () => {
    const promise = component.startSetup();
    expect(component.phase).toBe('progress');
    await promise;
  });

  it('should pause at project phase (step 3) during auto steps', async () => {
    await component.startSetup();
    expect(component.phase).toBe('project');
    expect(component.steps[0].status).toBe('done');
    expect(component.steps[1].status).toBe('done');
    expect(component.steps[2].status).toBe('done');
    expect(component.steps[3].status).toBe('active');
  });

  it('should call createProject via TauriService', async () => {
    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    await component.startSetup();

    component.projectName = 'test-proj';
    component.projectDir = '/tmp/test';
    await component.createProject();

    expect(invokeSpy).toHaveBeenCalledWith('create_project', {
      name: 'test-proj',
      dir: '/tmp/test',
    });
  });

  it('should navigate with replaceUrl on completion', async () => {
    vi.useFakeTimers();
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    component.projectName = 'test-proj';
    component.projectDir = '/tmp/test';

    await component.startSetup();
    await component.createProject();

    expect(component.phase).toBe('complete');

    vi.advanceTimersByTime(1500);

    expect(navigateSpy).toHaveBeenCalledWith(['/settings'], { replaceUrl: true });
    vi.useRealTimers();
  });

  it('should show error on step failure and allow retry', async () => {
    let callCount = 0;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_platform') return 'macos';
      if (cmd === 'check_runtime') {
        callCount++;
        if (callCount === 1) throw new Error('runtime check failed');
        return 'NotReady';
      }
      return undefined;
    };

    await component.startSetup();
    expect(component.error).toContain('runtime check failed');
    expect(component.steps[0].status).toBe('error');

    // Retry should work
    await component.retryCurrentStep();
    expect(component.error).toBeNull();
    expect(component.steps[0].status).toBe('done');
  });

  it('should show error when createProject fails', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_platform') return 'macos';
      if (cmd === 'create_project') throw new Error('project creation failed');
      if (cmd === 'check_runtime') return 'NotReady';
      return undefined;
    };

    await component.startSetup();
    component.projectName = 'test';
    component.projectDir = '/tmp/test';
    await component.createProject();

    expect(component.error).toContain('project creation failed');
    expect(component.steps[3].status).toBe('error');
  });

  it('should set platform-specific step descriptions for macOS', async () => {
    await fixture.whenStable();
    expect(component.steps[0].description).toBe('Verify Lima / nerdctl');
    expect(component.steps[1].description).toBe('Create and start the Lima VM');
  });

  it('should set platform-specific step descriptions for windows', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_platform') return 'windows';
      if (cmd === 'check_runtime') return 'NotReady';
      return undefined;
    };
    const winFixture = TestBed.createComponent(SetupWizardComponent);
    winFixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    expect(winFixture.componentInstance.steps[0].description).toBe('Verify system requirements');
    expect(winFixture.componentInstance.steps[1].description).toBe('Set up WSL2 distribution');
  });

  it('should set platform-specific step descriptions for linux', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_platform') return 'linux';
      if (cmd === 'check_runtime') return 'NotReady';
      return undefined;
    };
    const linFixture = TestBed.createComponent(SetupWizardComponent);
    linFixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    expect(linFixture.componentInstance.steps[0].description).toBe('Verify nerdctl (rootless)');
    expect(linFixture.componentInstance.steps[1].description).toBe('Set up rootless containerd');
  });

  it('should return to welcome phase on backToWelcome', async () => {
    await component.startSetup();
    component.backToWelcome();
    expect(component.phase).toBe('welcome');
    expect(component.error).toBeNull();
  });
});
