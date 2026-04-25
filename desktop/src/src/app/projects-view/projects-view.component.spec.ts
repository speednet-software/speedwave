import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ProjectsViewComponent } from './projects-view.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';

interface ProjectListReply {
  projects: { name: string; dir: string }[];
  active_project: string | null;
}

function mockProjectList(active: string | null = 'speedwave'): ProjectListReply {
  return {
    projects: [
      { name: 'speedwave', dir: '/Users/dev/speedwave' },
      { name: 'plugins', dir: '/Users/dev/speedwave-plugins' },
      { name: 'backend', dir: '/Users/dev/backend' },
    ],
    active_project: active,
  };
}

describe('ProjectsViewComponent', () => {
  let component: ProjectsViewComponent;
  let fixture: ComponentFixture<ProjectsViewComponent>;
  let mockTauri: MockTauriService;
  let projectState: ProjectStateService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_projects') return mockProjectList();
      if (cmd === 'switch_project') return undefined;
      return undefined;
    };

    await TestBed.configureTestingModule({
      imports: [ProjectsViewComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    projectState = TestBed.inject(ProjectStateService);
    fixture = TestBed.createComponent(ProjectsViewComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    component.ngOnDestroy();
  });

  it('creates the component', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('renders the project list after init', async () => {
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('[data-testid^="projects-card-"]');
    expect(rows.length).toBe(3);
  });

  it('shows the empty placeholder when list is empty', async () => {
    mockTauri.invokeHandler = async () => ({ projects: [], active_project: null });
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="projects-empty"]')).not.toBeNull();
  });

  it('marks the active project with data-active and current badge', async () => {
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const activeCard = fixture.nativeElement.querySelector(
      '[data-testid="projects-card-speedwave"]'
    );
    expect(activeCard.getAttribute('data-active')).toBe('true');
    expect(activeCard.className).toContain('ring-[var(--accent-dim)]');

    const badge = activeCard.querySelector('[data-testid="projects-current-badge"]');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain('current');
  });

  it('does not mark inactive projects with the current badge', async () => {
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const inactive = fixture.nativeElement.querySelector('[data-testid="projects-card-plugins"]');
    expect(inactive.getAttribute('data-active')).toBeNull();
    expect(inactive.querySelector('[data-testid="projects-current-badge"]')).toBeNull();
  });

  it('switch button calls switch_project via ProjectStateService', async () => {
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    const btn = fixture.nativeElement.querySelector('[data-testid="projects-switch-plugins"]');
    expect(btn).not.toBeNull();
    btn.click();
    await fixture.whenStable();

    expect(invokeSpy).toHaveBeenCalledWith('switch_project', { name: 'plugins' });
  });

  it('disables the switch button on the currently active project', async () => {
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const activeBtn = fixture.nativeElement.querySelector(
      '[data-testid="projects-switch-speedwave"]'
    );
    expect(activeBtn.disabled).toBe(true);
    expect(activeBtn.textContent.trim()).toContain('active');
  });

  it('shows "switching…" label while a switch is in progress', async () => {
    // Hang the switch call to keep state in "switching"
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_projects') return mockProjectList();
      if (cmd === 'switch_project') return new Promise(() => undefined);
      return undefined;
    };

    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="projects-switch-plugins"]');
    btn.click();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const label = btn.textContent.trim();
    expect(label).toContain('switching');
  });

  it('surfaces switch errors in the error banner', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_projects') return mockProjectList();
      if (cmd === 'switch_project') throw new Error('container busy');
      return undefined;
    };

    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="projects-switch-plugins"]');
    btn.click();
    await fixture.whenStable();

    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const err = fixture.nativeElement.querySelector('[data-testid="projects-error"]');
    expect(err).not.toBeNull();
    expect(err.textContent).toContain('container busy');
  });

  it('surfaces list_projects errors in the error banner', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_projects') throw new Error('cannot read config');
      return undefined;
    };
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const err = fixture.nativeElement.querySelector('[data-testid="projects-error"]');
    expect(err).not.toBeNull();
    expect(err.textContent).toContain('cannot read config');
  });

  it('reloads the list on project-settled events', async () => {
    await component.ngOnInit();

    // Flip the mock to return a different active project on the next call
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_projects') return mockProjectList('plugins');
      return undefined;
    };
    // Simulate a project-settled callback firing
    (projectState as unknown as { settledListeners: Array<() => void> }).settledListeners.forEach(
      (cb) => cb()
    );
    await fixture.whenStable();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const activeCard = fixture.nativeElement.querySelector('[data-testid="projects-card-plugins"]');
    expect(activeCard.getAttribute('data-active')).toBe('true');
  });

  it('cleans up the settled listener on destroy', async () => {
    await component.ngOnInit();
    expect((component as unknown as { unsubSettled: unknown })['unsubSettled']).not.toBeNull();
    component.ngOnDestroy();
    expect((component as unknown as { unsubSettled: unknown })['unsubSettled']).toBeNull();
  });

  it('renders project paths as clickable monospace text', async () => {
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const path = fixture.nativeElement.querySelector('[data-testid="projects-path-speedwave"]');
    expect(path).not.toBeNull();
    expect(path.textContent).toContain('/Users/dev/speedwave');
    expect(path.classList.contains('mono')).toBe(true);
  });
});
