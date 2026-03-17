import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterModule } from '@angular/router';
import { ShellComponent } from './shell.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { MockTauriService, MOCK_BUNDLE_RECONCILE_DONE } from '../testing/mock-tauri.service';

describe('ShellComponent', () => {
  let component: ShellComponent;
  let fixture: ComponentFixture<ShellComponent>;
  let mockTauri: MockTauriService;
  let projectState: ProjectStateService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_projects')
        return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
      if (cmd === 'get_bundle_reconcile_state') return MOCK_BUNDLE_RECONCILE_DONE;
      if (cmd === 'check_containers_running') return true;
      if (cmd === 'start_containers') return undefined;
      return undefined;
    };

    await TestBed.configureTestingModule({
      imports: [ShellComponent, RouterModule.forRoot([])],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(ShellComponent);
    component = fixture.componentInstance;
    projectState = TestBed.inject(ProjectStateService);
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should render nav with Chat, Integrations, Plugins, Settings', () => {
    const nav = fixture.nativeElement.querySelector('.app-nav');
    const links = Array.from(nav.querySelectorAll('a')) as HTMLAnchorElement[];
    const labels = links.map((a) => a.textContent?.trim());
    expect(labels).toEqual(['Chat', 'Integrations', 'Plugins', 'Settings']);
  });

  it('should NOT render a Setup link', () => {
    const nav = fixture.nativeElement.querySelector('.app-nav');
    const links = Array.from(nav.querySelectorAll('a')) as HTMLAnchorElement[];
    const labels = links.map((a) => a.textContent?.trim());
    expect(labels).not.toContain('Setup');
  });

  it('should render update-notification', () => {
    const el = fixture.nativeElement.querySelector('app-update-notification');
    expect(el).toBeTruthy();
  });

  it('should render project-switcher', () => {
    const el = fixture.nativeElement.querySelector('app-project-switcher');
    expect(el).toBeTruthy();
  });

  it('should render router-outlet', () => {
    const el = fixture.nativeElement.querySelector('router-outlet');
    expect(el).toBeTruthy();
  });

  it('shows loading overlay by default', () => {
    const overlay = fixture.nativeElement.querySelector('.blocking-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Loading...');
  });

  it('shows blocking-overlay with switching message on project switch', async () => {
    await component.ngOnInit();
    mockTauri.dispatchEvent('project_switch_started', { project: 'new' });
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('.blocking-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Switching project...');
  });

  it('shows rebuilding overlay when reconcile in progress', async () => {
    await component.ngOnInit();
    await fixture.whenStable();
    // Force rebuilding status
    projectState.status = 'rebuilding';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('.blocking-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Rebuilding container images...');
  });

  it('shows checking overlay when containers checking', async () => {
    await component.ngOnInit();
    projectState.status = 'checking';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('.blocking-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Checking containers...');
  });

  it('shows starting overlay when containers starting', async () => {
    await component.ngOnInit();
    projectState.status = 'starting';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('.blocking-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Starting containers...');
  });

  it('shows error banner with retry on failure', async () => {
    await component.ngOnInit();
    mockTauri.dispatchEvent('project_switch_failed', { project: null, error: 'Switch failed' });
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const banner = fixture.nativeElement.querySelector('.blocking-error-banner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('Switch failed');
    expect(banner.querySelector('button')).not.toBeNull();
  });

  it('hides overlay when ready', async () => {
    await component.ngOnInit();
    await fixture.whenStable();
    projectState.status = 'ready';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.blocking-overlay')).toBeNull();
    expect(fixture.nativeElement.querySelector('.blocking-error-banner')).toBeNull();
  });

  it('cleans up subscription on destroy', async () => {
    await projectState.init();
    await fixture.whenStable();

    expect((component as unknown as { unsubscribe: unknown })['unsubscribe']).not.toBeNull();

    component.ngOnDestroy();

    mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
    // After destroy, component should not update (no crash)
    expect(component).toBeTruthy();
  });

  it('dismiss calls projectState.dismissError', async () => {
    const spy = vi.spyOn(projectState, 'dismissError').mockResolvedValue();
    await component.dismiss();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('retry calls ensureContainersRunning', async () => {
    const spy = vi.spyOn(projectState, 'ensureContainersRunning').mockResolvedValue();
    component.retry();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
