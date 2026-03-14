import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterModule } from '@angular/router';
import { ShellComponent } from './shell.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';

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

  it('does not show project-switch-overlay by default', () => {
    expect(fixture.nativeElement.querySelector('.project-switch-overlay')).toBeNull();
  });

  it('shows project-switch-overlay when switching is true', () => {
    component.switching = true;
    component['cdr'].markForCheck();
    fixture.detectChanges();
    const overlay = fixture.nativeElement.querySelector('.project-switch-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Switching project...');
  });

  it('hides project-switch-overlay when switching becomes false', () => {
    component.switching = true;
    component['cdr'].markForCheck();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.project-switch-overlay')).not.toBeNull();

    component.switching = false;
    component['cdr'].markForCheck();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.project-switch-overlay')).toBeNull();
  });

  it('shows error banner when projectState has error status', async () => {
    await component.ngOnInit(); // calls projectState.init() internally
    mockTauri.dispatchEvent('project_switch_failed', { project: null, error: 'Switch failed' });
    component['cdr'].markForCheck();
    fixture.detectChanges();

    const banner = fixture.nativeElement.querySelector('.project-switch-error-banner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('Switch failed');
  });

  it('dismisses error banner', async () => {
    await component.ngOnInit(); // calls projectState.init() internally
    mockTauri.dispatchEvent('project_switch_failed', { project: null, error: 'Switch failed' });
    component['cdr'].markForCheck();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.project-switch-error-banner')).not.toBeNull();

    component.dismissError();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.project-switch-error-banner')).toBeNull();
  });

  it('cleans up subscription on destroy', async () => {
    // ngOnInit was already called by fixture.detectChanges() in beforeEach,
    // but projectState.init() is async. Wait for it to settle.
    await projectState.init();
    await fixture.whenStable();

    // Verify the unsub function exists before destroy
    expect((component as unknown as { unsubscribe: unknown })['unsubscribe']).not.toBeNull();

    component.ngOnDestroy();

    // After destroy, dispatching events should not update the component
    mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
    expect(component.switching).toBe(false);
  });
});
