import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { invoke } from '@tauri-apps/api/core';
import { error as logError } from '@tauri-apps/plugin-log';
import { ProjectSwitcherComponent } from './project-switcher.component';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-log', () => ({ error: vi.fn() }));

describe('ProjectSwitcherComponent', () => {
  let component: ProjectSwitcherComponent;
  let fixture: ComponentFixture<ProjectSwitcherComponent>;
  const mockInvoke = invoke as ReturnType<typeof vi.fn>;
  const mockLogError = logError as ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
    mockLogError.mockResolvedValue(undefined);

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
});
