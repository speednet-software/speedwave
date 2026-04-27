import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, RouterModule } from '@angular/router';
import { ShellComponent } from './shell.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { UiStateService } from '../services/ui-state.service';
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
          { path: 'integrations', component: ShellComponent },
          { path: 'plugins', component: ShellComponent },
          { path: 'settings', component: ShellComponent },
          { path: 'logs', component: ShellComponent },
        ]),
      ],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(ShellComponent);
    component = fixture.componentInstance;
    projectState = TestBed.inject(ProjectStateService);
    // Reset shared UI state so ⌘B keybinding tests start from a clean slate.
    const ui = TestBed.inject(UiStateService);
    ui.closeSidebar();
    ui.closeMemory();
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
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

  it('does not show blocking overlay when auth_required', async () => {
    await component.ngOnInit();
    projectState.status = 'auth_required';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="blocking-overlay"]')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="blocking-auth-required"]')
    ).toBeNull();
  });

  it('hides Chat nav link when status is auth_required', async () => {
    await component.ngOnInit();
    projectState.status = 'auth_required';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const nav = fixture.nativeElement.querySelector('[data-testid="nav-rail"]');
    const links = Array.from(nav.querySelectorAll('a[data-testid^="nav-"]')) as HTMLAnchorElement[];
    const ids = links.map((a) => a.getAttribute('data-testid'));
    expect(ids).toEqual(['nav-integrations', 'nav-plugins', 'nav-settings', 'nav-logs']);
    expect(ids).not.toContain('nav-chat');
  });

  it('shows Chat nav link when status is ready', async () => {
    await component.ngOnInit();
    await fixture.whenStable();
    projectState.status = 'ready';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const nav = fixture.nativeElement.querySelector('[data-testid="nav-rail"]');
    const links = Array.from(nav.querySelectorAll('a[data-testid^="nav-"]')) as HTMLAnchorElement[];
    const ids = links.map((a) => a.getAttribute('data-testid'));
    expect(ids).toEqual([
      'nav-chat',
      'nav-integrations',
      'nav-plugins',
      'nav-settings',
      'nav-logs',
    ]);
  });

  it('shows Chat nav link when status is error', async () => {
    await component.ngOnInit();
    await fixture.whenStable();
    projectState.status = 'error';
    projectState.error = 'something failed';
    component['cdr'].markForCheck();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="nav-chat"]')).not.toBeNull();
  });

  describe('restart overlay', () => {
    beforeEach(async () => {
      await component.ngOnInit();
      await fixture.whenStable();
      projectState.status = 'ready';
      component['cdr'].markForCheck();
      fixture.detectChanges();
    });

    it('shows overlay when needsRestart is true and status is ready', () => {
      projectState.needsRestart = true;
      component['cdr'].markForCheck();
      fixture.detectChanges();

      const overlay = fixture.nativeElement.querySelector('[data-testid="restart-overlay"]');
      expect(overlay).not.toBeNull();
      // Terminal-minimal restart overlay copy.
      expect(overlay.textContent).toContain('restart required');
      expect(overlay.textContent).toContain('Container config changed');
    });

    it('hides overlay when needsRestart is false', () => {
      projectState.needsRestart = false;
      component['cdr'].markForCheck();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="restart-overlay"]')).toBeNull();
    });

    it('hides overlay during blocking states', () => {
      projectState.needsRestart = true;
      for (const status of [
        'loading',
        'switching',
        'rebuilding',
        'check_failed',
        'system_check',
        'checking',
        'starting',
      ] as const) {
        projectState.status = status;
        component['cdr'].markForCheck();
        fixture.detectChanges();

        expect(
          fixture.nativeElement.querySelector('[data-testid="restart-overlay"]'),
          `overlay should be hidden for status=${status}`
        ).toBeNull();
      }
    });

    it('hides overlay when status is auth_required', () => {
      projectState.needsRestart = true;
      projectState.status = 'auth_required';
      component['cdr'].markForCheck();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="restart-overlay"]')).toBeNull();
    });

    it('hides overlay when status is error', () => {
      projectState.needsRestart = true;
      projectState.status = 'error';
      component['cdr'].markForCheck();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="restart-overlay"]')).toBeNull();
    });

    it('Restart Now button calls projectState.restartContainers', () => {
      projectState.needsRestart = true;
      component['cdr'].markForCheck();
      fixture.detectChanges();

      const spy = vi.spyOn(projectState, 'restartContainers').mockResolvedValue();
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="restart-now-btn"]'
      ) as HTMLButtonElement;
      btn.click();

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('Later button calls projectState.dismissRestart', () => {
      projectState.needsRestart = true;
      component['cdr'].markForCheck();
      fixture.detectChanges();

      const spy = vi.spyOn(projectState, 'dismissRestart');
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="restart-later-btn"]'
      ) as HTMLButtonElement;
      btn.click();

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('shows spinner during restarting', () => {
      projectState.needsRestart = true;
      projectState.restarting = true;
      component['cdr'].markForCheck();
      fixture.detectChanges();

      const overlay = fixture.nativeElement.querySelector('[data-testid="restart-overlay"]');
      expect(overlay).not.toBeNull();
      expect(overlay.textContent).toContain('Restarting containers...');
      expect(overlay.textContent).toContain('This may take a minute');
      expect(overlay.textContent).not.toContain('restart required');
      expect(fixture.nativeElement.querySelector('[data-testid="restart-now-btn"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="restart-later-btn"]')).toBeNull();
    });

    it('shows error when restartError is set', () => {
      projectState.needsRestart = true;
      projectState.restartError = 'compose failed';
      component['cdr'].markForCheck();
      fixture.detectChanges();

      const errorEl = fixture.nativeElement.querySelector('[data-testid="restart-error"]');
      expect(errorEl).not.toBeNull();
      expect(errorEl.textContent).toContain('compose failed');
    });

    it('Restart Now is visible when restartError is set for retry', () => {
      projectState.needsRestart = true;
      projectState.restartError = 'compose failed';
      component['cdr'].markForCheck();
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('[data-testid="restart-now-btn"]');
      expect(btn).not.toBeNull();

      const spy = vi.spyOn(projectState, 'restartContainers').mockResolvedValue();
      btn.click();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('overlay persists across route changes', async () => {
      projectState.needsRestart = true;
      component['cdr'].markForCheck();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="restart-overlay"]')).not.toBeNull();

      const router = TestBed.inject(Router);
      await router.navigate(['/settings']);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="restart-overlay"]')).not.toBeNull();
    });
  });

  describe('Cmd+B / Ctrl+B keyboard shortcut', () => {
    it('toggles the conversations sidebar on Cmd+B', () => {
      const ui = TestBed.inject(UiStateService);
      expect(ui.sidebarOpen()).toBe(false);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true }));

      expect(ui.sidebarOpen()).toBe(true);
    });

    it('toggles the conversations sidebar on Ctrl+B', () => {
      const ui = TestBed.inject(UiStateService);
      expect(ui.sidebarOpen()).toBe(false);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', ctrlKey: true }));

      expect(ui.sidebarOpen()).toBe(true);
    });

    it('flips the sidebar back closed on a second Cmd+B', () => {
      const ui = TestBed.inject(UiStateService);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true }));

      expect(ui.sidebarOpen()).toBe(false);
    });

    it('ignores plain `b` keypress without modifier', () => {
      const ui = TestBed.inject(UiStateService);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
      expect(ui.sidebarOpen()).toBe(false);
    });

    it('ignores Cmd+other keys', () => {
      const ui = TestBed.inject(UiStateService);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true }));
      expect(ui.sidebarOpen()).toBe(false);
    });

    it('does not fire after the component is destroyed', () => {
      const ui = TestBed.inject(UiStateService);
      fixture.destroy();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true }));
      expect(ui.sidebarOpen()).toBe(false);
    });
  });
});
