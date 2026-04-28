import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ProjectSwitcherComponent } from './project-switcher.component';
import { LoggerService } from '../services/logger.service';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { UiStateService } from '../services/ui-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('ProjectSwitcherComponent', () => {
  let component: ProjectSwitcherComponent;
  let fixture: ComponentFixture<ProjectSwitcherComponent>;
  let mockTauri: MockTauriService;
  let projectState: ProjectStateService;
  let ui: UiStateService;
  let mockLogError: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLogError = vi.fn();
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_projects':
          return { projects: [], active_project: null };
        default:
          return undefined;
      }
    };

    await TestBed.configureTestingModule({
      imports: [ProjectSwitcherComponent],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: { error: mockLogError } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ProjectSwitcherComponent);
    component = fixture.componentInstance;
    projectState = TestBed.inject(ProjectStateService);
    ui = TestBed.inject(UiStateService);
    // Reset shared UI state between tests so each starts closed.
    ui.closeProjectSwitcher();
  });

  it('has correct initial state', () => {
    expect(component.projects).toEqual([]);
    expect(component.activeProject).toBeNull();
    expect(component.showAddForm()).toBe(false);
    expect(component.filter()).toBe('');
  });

  describe('visibility binding (UiStateService.projectSwitcherOpen)', () => {
    it('does not render the dropdown when projectSwitcherOpen() is false', () => {
      fixture.detectChanges();
      const dropdown = fixture.nativeElement.querySelector(
        '[data-testid="project-switcher-dropdown"]'
      );
      expect(dropdown).toBeNull();
    });

    it('renders the dropdown when projectSwitcherOpen() is true', () => {
      ui.toggleProjectSwitcher();
      fixture.detectChanges();
      const dropdown = fixture.nativeElement.querySelector(
        '[data-testid="project-switcher-dropdown"]'
      );
      expect(dropdown).not.toBeNull();
    });

    it('hides the dropdown again when closed via UiStateService', () => {
      ui.toggleProjectSwitcher();
      fixture.detectChanges();
      ui.closeProjectSwitcher();
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="project-switcher-dropdown"]')
      ).toBeNull();
    });
  });

  describe('ngOnInit()', () => {
    it('loads projects and sets active project', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_projects')
          return {
            projects: [
              { name: 'alpha', dir: '/tmp/alpha' },
              { name: 'beta', dir: '/tmp/beta' },
            ],
            active_project: 'beta',
          };
        return undefined;
      };

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.ngOnInit();

      expect(invokeSpy).toHaveBeenCalledWith('list_projects');
      expect(component.projects).toEqual([
        { name: 'alpha', dir: '/tmp/alpha' },
        { name: 'beta', dir: '/tmp/beta' },
      ]);
      expect(component.activeProject).toBe('beta');
    });

    it('keeps defaults when invoke fails', async () => {
      mockTauri.invokeHandler = async () => {
        throw new Error('not in tauri');
      };

      await component.ngOnInit();

      expect(component.projects).toEqual([]);
      expect(component.activeProject).toBeNull();
    });
  });

  describe('switchProject()', () => {
    it('invokes switch_project via ProjectStateService and closes dropdown', async () => {
      ui.toggleProjectSwitcher();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await component.switchProject('acme');

      expect(invokeSpy).toHaveBeenCalledWith('switch_project', { name: 'acme' });
      expect(ui.projectSwitcherOpen()).toBe(false);
    });

    it('logs error via plugin-log on failure', async () => {
      ui.toggleProjectSwitcher();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'switch_project') throw new Error('switch failed');
        return undefined;
      };

      await component.switchProject('bad-project');

      expect(mockLogError).toHaveBeenCalledWith('Failed to switch project: Error: switch failed');
      expect(ui.projectSwitcherOpen()).toBe(false);
    });
  });

  describe('add-project modal lifecycle', () => {
    // The actual create / error-handling logic lives in CreateProjectModalComponent
    // and is exercised by its own spec; here we only assert that the switcher
    // opens, closes, and reacts to the `created` event correctly.

    it('openAddForm() makes the modal visible', () => {
      component.openAddForm();
      expect(component.showAddForm()).toBe(true);
    });

    it('closeAddForm() hides the modal without touching the dropdown', () => {
      ui.toggleProjectSwitcher();
      component.openAddForm();
      component.closeAddForm();
      expect(component.showAddForm()).toBe(false);
      expect(ui.projectSwitcherOpen()).toBe(true);
    });

    it('onProjectAdded() closes both the modal and the switcher dropdown', () => {
      ui.toggleProjectSwitcher();
      component.openAddForm();
      component.onProjectAdded();
      expect(component.showAddForm()).toBe(false);
      expect(ui.projectSwitcherOpen()).toBe(false);
    });
  });

  describe('search filter', () => {
    beforeEach(async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_projects')
          return {
            projects: [
              { name: 'speedwave', dir: '/tmp/sw' },
              { name: 'speedwave-plugins', dir: '/tmp/sw-plugins' },
              { name: 'speednet-backend', dir: '/tmp/sn-backend' },
              { name: 'experiments', dir: '/tmp/exp' },
            ],
            active_project: 'speedwave',
          };
        return undefined;
      };
      await component.ngOnInit();
    });

    it('returns all projects when filter is empty', () => {
      expect(component.visibleProjects().length).toBe(4);
    });

    it('narrows the list by case-insensitive substring match', () => {
      component.filter.set('PLUGIN');
      const visible = component.visibleProjects();
      expect(visible.length).toBe(1);
      expect(visible[0].project.name).toBe('speedwave-plugins');
    });

    it('returns an empty list when nothing matches', () => {
      component.filter.set('zzz');
      expect(component.visibleProjects()).toEqual([]);
    });

    it('marks the active project with isActive=true and current pill', () => {
      ui.toggleProjectSwitcher();
      fixture.detectChanges();
      const visible = component.visibleProjects();
      const active = visible.find((v) => v.isActive);
      expect(active?.project.name).toBe('speedwave');
      const pill = fixture.nativeElement.querySelector(
        '[data-testid="project-switcher-item-speedwave"]'
      );
      expect(pill).not.toBeNull();
      expect(pill.textContent).toContain('current');
    });

    it('renders shortcut hint for non-active project rows', () => {
      ui.toggleProjectSwitcher();
      fixture.detectChanges();
      // Second project (index 1) gets ⌘2 hint per mockup.
      const row = fixture.nativeElement.querySelector(
        '[data-testid="project-switcher-item-speedwave-plugins"]'
      );
      expect(row).not.toBeNull();
      expect(row.textContent).toContain('⌘2');
    });

    it('shows the empty placeholder when filter has no matches', () => {
      ui.toggleProjectSwitcher();
      component.filter.set('nope');
      fixture.detectChanges();
      const empty = fixture.nativeElement.querySelector('[data-testid="project-switcher-empty"]');
      expect(empty).not.toBeNull();
      expect(empty.textContent).toContain('no projects match');
    });
  });

  describe('search input behavior', () => {
    it('updates the filter signal from the input event', () => {
      ui.toggleProjectSwitcher();
      fixture.detectChanges();
      const input = fixture.nativeElement.querySelector(
        '[data-testid="project-switcher-search"]'
      ) as HTMLInputElement;
      input.value = 'edge';
      input.dispatchEvent(new Event('input'));
      expect(component.filter()).toBe('edge');
    });
  });

  describe('project_switch_succeeded event', () => {
    it('refreshes project list on project_switch_succeeded', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_projects')
          return {
            projects: [{ name: 'alpha', dir: '/tmp/alpha' }],
            active_project: 'alpha',
          };
        return undefined;
      };

      await projectState.init();
      await component.ngOnInit();
      expect(component.activeProject).toBe('alpha');

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_projects')
          return {
            projects: [
              { name: 'alpha', dir: '/tmp/alpha' },
              { name: 'beta', dir: '/tmp/beta' },
            ],
            active_project: 'beta',
          };
        return undefined;
      };

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'beta' });
      await fixture.whenStable();

      expect(component.projects).toEqual([
        { name: 'alpha', dir: '/tmp/alpha' },
        { name: 'beta', dir: '/tmp/beta' },
      ]);
      expect(component.activeProject).toBe('beta');
    });

    it('cleans up project settled listener on destroy', async () => {
      await projectState.init();
      await component.ngOnInit();

      // Verify the unsub function exists before destroy
      expect(
        (component as unknown as { unsubProjectSettled: unknown })['unsubProjectSettled']
      ).not.toBeNull();

      component.ngOnDestroy();

      // Verify unsub was called and nulled
      expect(
        (component as unknown as { unsubProjectSettled: unknown })['unsubProjectSettled']
      ).toBeNull();
    });
  });
});
