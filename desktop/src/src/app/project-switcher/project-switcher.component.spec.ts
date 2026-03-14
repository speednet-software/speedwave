import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { error as logError } from '@tauri-apps/plugin-log';
import { ProjectSwitcherComponent } from './project-switcher.component';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-log', () => ({ error: vi.fn() }));

describe('ProjectSwitcherComponent', () => {
  let component: ProjectSwitcherComponent;
  let fixture: ComponentFixture<ProjectSwitcherComponent>;
  const mockInvoke = invoke as ReturnType<typeof vi.fn>;
  const mockListen = listen as ReturnType<typeof vi.fn>;
  const mockLogError = logError as ReturnType<typeof vi.fn>;

  /** Stores listen callbacks so tests can dispatch events. */
  let listenHandlers: Record<string, (event: unknown) => void>;
  let unlistenSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
    mockLogError.mockResolvedValue(undefined);
    listenHandlers = {};
    unlistenSpy = vi.fn();
    mockListen.mockImplementation(async (event: string, handler: unknown) => {
      listenHandlers[event] = handler as (event: unknown) => void;
      return () => {
        delete listenHandlers[event];
        unlistenSpy();
      };
    });

    await TestBed.configureTestingModule({
      imports: [ProjectSwitcherComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ProjectSwitcherComponent);
    component = fixture.componentInstance;
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
      mockInvoke.mockResolvedValue({
        projects: [
          { name: 'alpha', dir: '/tmp/alpha' },
          { name: 'beta', dir: '/tmp/beta' },
        ],
        active_project: 'beta',
      });

      await component.ngOnInit();

      expect(mockInvoke).toHaveBeenCalledWith('list_projects');
      expect(component.projects).toEqual([
        { name: 'alpha', dir: '/tmp/alpha' },
        { name: 'beta', dir: '/tmp/beta' },
      ]);
      expect(component.activeProject).toBe('beta');
    });

    it('keeps defaults when invoke fails', async () => {
      mockInvoke.mockRejectedValue(new Error('not in tauri'));

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
    it('invokes switch_project, sets activeProject, and closes dropdown', async () => {
      component.isOpen = true;
      mockInvoke.mockResolvedValue(undefined);

      await component.switchProject('acme');

      expect(mockInvoke).toHaveBeenCalledWith('switch_project', { name: 'acme' });
      expect(component.activeProject).toBe('acme');
      expect(component.isOpen).toBe(false);
    });

    it('logs error via plugin-log on failure', async () => {
      component.isOpen = true;
      mockInvoke.mockRejectedValue(new Error('switch failed'));

      await component.switchProject('bad-project');

      expect(mockLogError).toHaveBeenCalledWith('Failed to switch project: Error: switch failed');
      expect(component.isOpen).toBe(false);
      expect(component.activeProject).toBeNull();
    });
  });

  describe('addProject()', () => {
    it('shows error when name or dir is empty', async () => {
      component.newProjectName = '';
      component.newProjectDir = '';

      await component.addProject();

      expect(component.addError).toBe('Name and path are required');
      expect(mockInvoke).not.toHaveBeenCalledWith('add_project', expect.anything());
    });

    it('calls add_project, resets form, and closes dropdown (event listener handles refresh)', async () => {
      component.showAddForm = true;
      component.isOpen = true;
      component.newProjectName = 'new-proj';
      component.newProjectDir = '/tmp/new-proj';

      mockInvoke.mockResolvedValueOnce(undefined); // add_project

      await component.addProject();

      expect(mockInvoke).toHaveBeenCalledWith('add_project', {
        name: 'new-proj',
        dir: '/tmp/new-proj',
      });
      expect(mockInvoke).not.toHaveBeenCalledWith('list_projects');
      expect(component.showAddForm).toBe(false);
      expect(component.isOpen).toBe(false);
      expect(component.addBusy).toBe(false);
    });

    it('shows error banner on backend failure', async () => {
      component.showAddForm = true;
      component.newProjectName = 'bad';
      component.newProjectDir = '/tmp/bad';

      mockInvoke.mockRejectedValue(new Error('duplicate name'));

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

  describe('project_switched event', () => {
    it('refreshes project list on project_switched', async () => {
      mockInvoke.mockResolvedValue({
        projects: [{ name: 'alpha', dir: '/tmp/alpha' }],
        active_project: 'alpha',
      });

      await component.ngOnInit();
      expect(component.activeProject).toBe('alpha');

      mockInvoke.mockResolvedValue({
        projects: [
          { name: 'alpha', dir: '/tmp/alpha' },
          { name: 'beta', dir: '/tmp/beta' },
        ],
        active_project: 'beta',
      });

      listenHandlers['project_switched']?.({ payload: 'beta' });
      await fixture.whenStable();

      expect(component.projects).toEqual([
        { name: 'alpha', dir: '/tmp/alpha' },
        { name: 'beta', dir: '/tmp/beta' },
      ]);
      expect(component.activeProject).toBe('beta');
    });

    it('cleans up project_switched listener on destroy', async () => {
      mockInvoke.mockResolvedValue({
        projects: [],
        active_project: null,
      });

      await component.ngOnInit();
      expect(listenHandlers['project_switched']).toBeDefined();

      component.ngOnDestroy();
      expect(listenHandlers['project_switched']).toBeUndefined();
      expect(unlistenSpy).toHaveBeenCalled();
    });
  });
});
