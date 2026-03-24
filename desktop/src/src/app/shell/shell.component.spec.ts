import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, RouterModule } from '@angular/router';
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
      if (cmd === 'run_system_check') return undefined;
      if (cmd === 'check_containers_running') return true;
      if (cmd === 'start_containers') return undefined;
      if (cmd === 'get_auth_status')
        return { api_key_configured: false, oauth_authenticated: true };
      return undefined;
    };

    await TestBed.configureTestingModule({
      imports: [
        ShellComponent,
        RouterModule.forRoot([
          { path: 'chat', component: ShellComponent },
          { path: 'settings', component: ShellComponent },
        ]),
      ],
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
    const nav = fixture.nativeElement.querySelector('[data-testid="app-nav"]');
    const links = Array.from(nav.querySelectorAll('a')) as HTMLAnchorElement[];
    const labels = links.map((a) => a.textContent?.trim());
    expect(labels).toEqual(['Chat', 'Integrations', 'Plugins', 'Settings']);
  });

  it('should NOT render a Setup link', () => {
    const nav = fixture.nativeElement.querySelector('[data-testid="app-nav"]');
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
    const overlay = fixture.nativeElement.querySelector('[data-testid="blocking-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Loading...');
  });

  it('shows blocking-overlay with switching message on project switch', async () => {
    await component.ngOnInit();
    mockTauri.dispatchEvent('project_switch_started', { project: 'new' });
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('[data-testid="blocking-overlay"]');
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

    const overlay = fixture.nativeElement.querySelector('[data-testid="blocking-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Rebuilding container images...');
  });

  it('shows checking overlay when containers checking', async () => {
    await component.ngOnInit();
    projectState.status = 'checking';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('[data-testid="blocking-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Checking containers...');
  });

  it('shows starting overlay when containers starting', async () => {
    await component.ngOnInit();
    projectState.status = 'starting';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('[data-testid="blocking-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Starting containers...');
  });

  it('shows error banner with retry on failure', async () => {
    await component.ngOnInit();
    mockTauri.dispatchEvent('project_switch_failed', { project: null, error: 'Switch failed' });
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const banner = fixture.nativeElement.querySelector('[data-testid="blocking-error"]');
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

    expect(fixture.nativeElement.querySelector('[data-testid="blocking-overlay"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="blocking-error"]')).toBeNull();
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

  it('shows fullscreen blocking overlay on check_failed', async () => {
    await component.ngOnInit();
    await fixture.whenStable();
    projectState.status = 'check_failed';
    projectState.error = 'WSL2 is not available';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('[data-testid="blocking-check-failed"]');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('System Check Failed');
    expect(overlay.textContent).toContain('WSL2 is not available');
  });

  it('check_failed overlay shows only Retry button, no Dismiss', async () => {
    await component.ngOnInit();
    await fixture.whenStable();
    projectState.status = 'check_failed';
    projectState.error = 'prereq failure';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('[data-testid="blocking-check-failed"]');
    const buttons = Array.from(overlay.querySelectorAll('button')) as HTMLButtonElement[];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent?.trim()).toBe('Retry');
  });

  it('check_failed Retry button calls ensureContainersRunning', async () => {
    const spy = vi.spyOn(projectState, 'ensureContainersRunning').mockResolvedValue();
    component.retryCheck();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('shows spinner with system check message during system_check', async () => {
    await component.ngOnInit();
    await fixture.whenStable();
    projectState.status = 'system_check';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('[data-testid="blocking-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Running system checks...');
  });

  it('shows auth-required overlay only on /chat', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/chat');
    projectState.status = 'auth_required';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('[data-testid="blocking-auth-required"]');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Authentication Required');
  });

  it('auth-required overlay has only Go to Settings link', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/chat');
    projectState.status = 'auth_required';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="auth-settings-btn"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="auth-authenticate-btn"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="auth-check-btn"]')).toBeNull();
  });

  it('does not show auth-required overlay on /settings', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/settings');
    projectState.status = 'auth_required';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-testid="blocking-auth-required"]')
    ).toBeNull();
  });
});
