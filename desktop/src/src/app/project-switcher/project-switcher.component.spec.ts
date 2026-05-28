import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ProjectSwitcherComponent, cleanRemoveErrorMessage } from './project-switcher.component';
import { LoggerService } from '../services/logger.service';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { UiStateService } from '../services/ui-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

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
    expect(component.projects()).toEqual([]);
    expect(component.activeProject()).toBeNull();
    expect(component.showAddForm()).toBe(false);
    expect(component.pendingDeleteName()).toBeNull();
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
      expect(component.projects()).toEqual([
        { name: 'alpha', dir: '/tmp/alpha' },
        { name: 'beta', dir: '/tmp/beta' },
      ]);
      expect(component.activeProject()).toBe('beta');
    });

    it('keeps defaults when invoke fails', async () => {
      mockTauri.invokeHandler = async () => {
        throw new Error('not in tauri');
      };

      await component.ngOnInit();

      expect(component.projects()).toEqual([]);
      expect(component.activeProject()).toBeNull();
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

    it('openAddForm() makes the modal visible and closes the dropdown', () => {
      ui.toggleProjectSwitcher();
      expect(ui.projectSwitcherOpen()).toBe(true);
      component.openAddForm();
      expect(component.showAddForm()).toBe(true);
      expect(ui.projectSwitcherOpen()).toBe(false);
    });

    it('closeAddForm() hides the modal and leaves the dropdown closed', () => {
      ui.toggleProjectSwitcher();
      component.openAddForm();
      component.closeAddForm();
      expect(component.showAddForm()).toBe(false);
      expect(ui.projectSwitcherOpen()).toBe(false);
    });

    it('onProjectAdded() closes both the modal and the switcher dropdown', () => {
      ui.toggleProjectSwitcher();
      component.openAddForm();
      component.onProjectAdded();
      expect(component.showAddForm()).toBe(false);
      expect(ui.projectSwitcherOpen()).toBe(false);
    });
  });

  describe('project list rendering', () => {
    beforeEach(async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_projects')
          return {
            projects: [
              { name: 'speedwave', dir: '/tmp/sw' },
              { name: 'speedwave-plugins', dir: '/tmp/sw-plugins' },
              { name: 'experiments', dir: '/tmp/exp' },
            ],
            active_project: 'speedwave',
          };
        return undefined;
      };
      await component.ngOnInit();
    });

    it('returns every project unfiltered', () => {
      expect(component.visibleProjects().length).toBe(3);
    });

    it('marks the active project with isActive=true and disables its row', () => {
      ui.toggleProjectSwitcher();
      fixture.detectChanges();
      const active = component.visibleProjects().find((v) => v.isActive);
      expect(active?.project.name).toBe('speedwave');
      const row = fixture.nativeElement.querySelector(
        '[data-testid="project-switcher-item-speedwave"]'
      ) as HTMLButtonElement;
      expect(row).not.toBeNull();
      expect(row.disabled).toBe(true);
    });

    it('marks the active row with aria-current="true" on the focusable button and an sr-only label', () => {
      ui.toggleProjectSwitcher();
      fixture.detectChanges();
      const row = fixture.nativeElement.querySelector(
        '[data-testid="project-switcher-item-speedwave"]'
      ) as HTMLButtonElement;
      expect(row.getAttribute('aria-current')).toBe('true');
      const srOnly = row.querySelector('.sr-only');
      expect(srOnly?.textContent).toContain('current project');
      const inactive = fixture.nativeElement.querySelector(
        '[data-testid="project-switcher-item-speedwave-plugins"]'
      ) as HTMLButtonElement;
      expect(inactive.getAttribute('aria-current')).toBeNull();
    });

    it('renders the info glyph for every project row', () => {
      ui.toggleProjectSwitcher();
      fixture.detectChanges();
      const activeInfo = fixture.nativeElement.querySelector(
        '[data-testid="project-switcher-item-info-speedwave"]'
      );
      expect(activeInfo).not.toBeNull();
      const inactiveInfo = fixture.nativeElement.querySelector(
        '[data-testid="project-switcher-item-info-speedwave-plugins"]'
      );
      expect(inactiveInfo).not.toBeNull();
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
      expect(component.activeProject()).toBe('alpha');

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

      expect(component.projects()).toEqual([
        { name: 'alpha', dir: '/tmp/alpha' },
        { name: 'beta', dir: '/tmp/beta' },
      ]);
      expect(component.activeProject()).toBe('beta');
    });

    it('cleans up project settled listener on destroy', async () => {
      await projectState.init();
      await component.ngOnInit();
      expect(
        (component as unknown as { unsubProjectSettled: unknown })['unsubProjectSettled']
      ).not.toBeNull();
      component.ngOnDestroy();
      expect(
        (component as unknown as { unsubProjectSettled: unknown })['unsubProjectSettled']
      ).toBeNull();
    });
  });

  describe('remove project', () => {
    beforeEach(async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_projects')
          return {
            projects: [
              { name: 'alpha', dir: '/tmp/alpha' },
              { name: 'beta', dir: '/tmp/beta' },
            ],
            active_project: 'alpha',
          };
        return undefined;
      };
      await projectState.init();
      await component.ngOnInit();
      ui.toggleProjectSwitcher();
      fixture.detectChanges();
    });

    it('requestRemove() swaps the row into the confirm prompt', () => {
      component.requestRemove('beta');
      fixture.detectChanges();
      expect(component.pendingDeleteName()).toBe('beta');
      expect(
        fixture.nativeElement.querySelector('[data-testid="project-switcher-confirm-beta"]')
      ).not.toBeNull();
    });

    it('cancelRemove() restores the row without invoking the backend', () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      component.requestRemove('beta');
      component.cancelRemove();
      fixture.detectChanges();
      expect(component.pendingDeleteName()).toBeNull();
      expect(invokeSpy).not.toHaveBeenCalledWith('remove_project', expect.anything());
    });

    it('confirmRemove() invokes remove_project and clears the pending state', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      component.requestRemove('beta');
      await component.confirmRemove('beta');
      expect(invokeSpy).toHaveBeenCalledWith('remove_project', { name: 'beta' });
      expect(component.pendingDeleteName()).toBeNull();
    });

    it('surfaces backend error inline and strips the runtime sentinel prefix', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'remove_project')
          throw new Error(
            "active_project_removal: Cannot remove the active project 'beta'. Switch first."
          );
        if (cmd === 'list_projects')
          return {
            projects: [
              { name: 'alpha', dir: '/tmp/alpha' },
              { name: 'beta', dir: '/tmp/beta' },
            ],
            active_project: 'alpha',
          };
        return undefined;
      };
      await component.confirmRemove('beta');
      fixture.detectChanges();
      expect(component.removeError()).toEqual({
        msg: "Cannot remove the active project 'beta'. Switch first.",
        project: 'beta',
      });
      const inline = fixture.nativeElement.querySelector(
        '[data-testid="project-switcher-remove-error-beta"]'
      );
      expect(inline).not.toBeNull();
      expect(mockLogError).toHaveBeenCalled();
    });

    it('clears pendingDeleteName and removeError when the dropdown closes', () => {
      component.requestRemove('beta');
      component.removeError.set({ msg: 'boom', project: 'beta' });
      ui.closeProjectSwitcher();
      fixture.detectChanges();
      expect(component.pendingDeleteName()).toBeNull();
      expect(component.removeError()).toBeNull();
    });

    it('clears pendingDeleteName when the pending project disappears from the list', async () => {
      component.requestRemove('beta');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_projects')
          return {
            projects: [{ name: 'alpha', dir: '/tmp/alpha' }],
            active_project: 'alpha',
          };
        return undefined;
      };
      const refreshed = await mockTauri.invoke<{
        projects: { name: string; dir: string }[];
        active_project: string;
      }>('list_projects');
      component.projects.set(refreshed.projects);
      fixture.detectChanges();
      expect(component.pendingDeleteName()).toBeNull();
    });

    it('does not render trash button or confirm UI on the active row', () => {
      const activeTrash = fixture.nativeElement.querySelector(
        '[data-testid="project-switcher-remove-alpha"]'
      );
      expect(activeTrash).toBeNull();
      const inactiveTrash = fixture.nativeElement.querySelector(
        '[data-testid="project-switcher-remove-beta"]'
      );
      expect(inactiveTrash).not.toBeNull();
    });
  });
});

describe('cleanRemoveErrorMessage', () => {
  it('strips the sentinel prefix', () => {
    expect(
      cleanRemoveErrorMessage("active_project_removal: Cannot remove the active project 'beta'.")
    ).toBe("Cannot remove the active project 'beta'.");
  });

  it('returns the message unchanged when no sentinel prefix is present', () => {
    expect(cleanRemoveErrorMessage('Some other backend failure')).toBe(
      'Some other backend failure'
    );
    expect(cleanRemoveErrorMessage('')).toBe('');
  });
});
