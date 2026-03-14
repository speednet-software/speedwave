import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ProjectSwitcherComponent } from './project-switcher.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';

vi.mock('@tauri-apps/plugin-log', () => ({ error: vi.fn().mockResolvedValue(undefined) }));
import { error as logError } from '@tauri-apps/plugin-log';

describe('ProjectSwitcherComponent', () => {
  let component: ProjectSwitcherComponent;
  let fixture: ComponentFixture<ProjectSwitcherComponent>;
  let mockTauri: MockTauriService;
  let projectState: ProjectStateService;
  const mockLogError = logError as ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
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
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(ProjectSwitcherComponent);
    component = fixture.componentInstance;
    projectState = TestBed.inject(ProjectStateService);
  });

  it('has correct initial state', () => {
    expect(component.projects).toEqual([]);
    expect(component.activeProject).toBeNull();
    expect(component.isOpen).toBe(false);
    expect(component.showAddForm).toBe(false);
    expect(component.newProjectName).toBe('');
    expect(component.newProjectDir).toBe('');
    expect(component.addBusy).toBe(false);
    expect(component.addError).toBeNull();
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

  describe('toggleDropdown()', () => {
    it('toggles isOpen from false to true', () => {
      component.isOpen = false;
      component.toggleDropdown();
      expect(component.isOpen).toBe(true);
    });

    it('toggles isOpen from true to false', () => {
      component.isOpen = true;
      component.toggleDropdown();
      expect(component.isOpen).toBe(false);
    });

    it('resets add form when closing dropdown', () => {
      component.isOpen = true;
      component.showAddForm = true;
      component.newProjectName = 'test';
      component.toggleDropdown();
      expect(component.isOpen).toBe(false);
      expect(component.showAddForm).toBe(false);
      expect(component.newProjectName).toBe('');
    });
  });

  describe('switchProject()', () => {
    it('invokes switch_project via ProjectStateService and closes dropdown', async () => {
      component.isOpen = true;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await component.switchProject('acme');

      expect(invokeSpy).toHaveBeenCalledWith('switch_project', { name: 'acme' });
      expect(component.isOpen).toBe(false);
    });

    it('logs error via plugin-log on failure', async () => {
      component.isOpen = true;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'switch_project') throw new Error('switch failed');
        return undefined;
      };

      await component.switchProject('bad-project');

      expect(mockLogError).toHaveBeenCalledWith('Failed to switch project: Error: switch failed');
      expect(component.isOpen).toBe(false);
    });
  });

  describe('addProject()', () => {
    it('shows error when name or dir is empty', async () => {
      component.newProjectName = '';
      component.newProjectDir = '';

      await component.addProject();

      expect(component.addError).toBe('Name and path are required');
    });

    it('calls add_project via ProjectStateService, resets form, and closes dropdown', async () => {
      component.showAddForm = true;
      component.isOpen = true;
      component.newProjectName = 'new-proj';
      component.newProjectDir = '/tmp/new-proj';

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await component.addProject();

      expect(invokeSpy).toHaveBeenCalledWith('add_project', {
        name: 'new-proj',
        dir: '/tmp/new-proj',
      });
      expect(component.showAddForm).toBe(false);
      expect(component.isOpen).toBe(false);
      expect(component.addBusy).toBe(false);
    });

    it('shows error banner on backend failure', async () => {
      component.showAddForm = true;
      component.newProjectName = 'bad';
      component.newProjectDir = '/tmp/bad';

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'add_project') throw new Error('duplicate name');
        return undefined;
      };

      await component.addProject();

      expect(component.addError).toBe('Error: duplicate name');
      expect(component.addBusy).toBe(false);
      expect(component.showAddForm).toBe(true);
      expect(mockLogError).toHaveBeenCalledWith('Failed to add project: Error: duplicate name');
    });
  });

  describe('cancelAdd()', () => {
    it('resets the add form', () => {
      component.showAddForm = true;
      component.newProjectName = 'test';
      component.newProjectDir = '/tmp/test';
      component.addError = 'some error';

      component.cancelAdd();

      expect(component.showAddForm).toBe(false);
      expect(component.newProjectName).toBe('');
      expect(component.newProjectDir).toBe('');
      expect(component.addError).toBeNull();
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
