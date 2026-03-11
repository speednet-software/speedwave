import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterModule } from '@angular/router';
import { SettingsComponent } from './settings.component';
import { TauriService } from '../services/tauri.service';
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
        return { provider: 'anthropic', model: null, base_url: null, api_key_env: null };
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

  it('renders AuthSectionComponent', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const authEl = fixture.nativeElement.querySelector('app-auth-section');
    expect(authEl).not.toBeNull();
  });

  it('reloads project info on project_switched event', async () => {
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

    mockTauri.dispatchEvent('project_switched', 'other-project');
    await fixture.whenStable();
    expect(component.activeProject).toBe('other-project');
  });

  it('cleans up event listener on destroy', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    expect(mockTauri.listenHandlers['project_switched']).toBeDefined();

    component.ngOnDestroy();
    expect(mockTauri.listenHandlers['project_switched']).toBeUndefined();
  });
});
