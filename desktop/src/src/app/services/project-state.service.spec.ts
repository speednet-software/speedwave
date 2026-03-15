import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ProjectStateService } from './project-state.service';
import { TauriService } from './tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('ProjectStateService', () => {
  let service: ProjectStateService;
  let mockTauri: MockTauriService;

  beforeEach(() => {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_projects':
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        default:
          return undefined;
      }
    };

    TestBed.configureTestingModule({
      providers: [ProjectStateService, { provide: TauriService, useValue: mockTauri }],
    });
    service = TestBed.inject(ProjectStateService);
  });

  describe('init', () => {
    it('loads active project and sets status to ready', async () => {
      await service.init();

      expect(service.activeProject).toBe('test');
      expect(service.status).toBe('ready');
    });

    it('is idempotent — second call is no-op', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      await service.init();
      const firstCount = spy.mock.calls.length;
      await service.init();
      expect(spy.mock.calls.length).toBe(firstCount);
    });

    it('stays loading when Tauri is not available', async () => {
      mockTauri.invokeHandler = async () => {
        throw new Error('not in Tauri');
      };

      await service.init();

      expect(service.status).toBe('loading');
    });

    it('registers listeners even when invoke fails', async () => {
      mockTauri.invokeHandler = async () => {
        throw new Error('not in Tauri');
      };

      await service.init();

      // Listeners should still work
      mockTauri.dispatchEvent('project_switch_started', { project: 'new' });
      expect(service.status).toBe('switching');
    });
  });

  describe('event handling', () => {
    beforeEach(async () => {
      await service.init();
    });

    it('project_switch_started sets switching state', () => {
      mockTauri.dispatchEvent('project_switch_started', { project: 'new-project' });

      expect(service.status).toBe('switching');
      expect(service.targetProject).toBe('new-project');
      expect(service.error).toBe('');
    });

    it('project_switch_succeeded sets ready state', () => {
      mockTauri.dispatchEvent('project_switch_started', { project: 'new-project' });
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'new-project' });

      expect(service.status).toBe('ready');
      expect(service.activeProject).toBe('new-project');
      expect(service.targetProject).toBeNull();
      expect(service.error).toBe('');
    });

    it('project_switch_failed sets error state with rollback', () => {
      mockTauri.dispatchEvent('project_switch_started', { project: 'new-project' });
      mockTauri.dispatchEvent('project_switch_failed', {
        project: 'old-project',
        error: 'container crash',
      });

      expect(service.status).toBe('error');
      expect(service.activeProject).toBe('old-project');
      expect(service.targetProject).toBeNull();
      expect(service.error).toBe('container crash');
    });

    it('project_switch_failed handles null rollback project', () => {
      mockTauri.dispatchEvent('project_switch_failed', {
        project: null,
        error: 'no previous project',
      });

      expect(service.status).toBe('error');
      expect(service.activeProject).toBeNull();
    });
  });

  describe('onChange', () => {
    it('notifies on every state transition', async () => {
      await service.init();
      const cb = vi.fn();
      service.onChange(cb);

      mockTauri.dispatchEvent('project_switch_started', { project: 'p' });
      expect(cb).toHaveBeenCalledTimes(1);

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'p' });
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it('returns working unsubscribe function', async () => {
      await service.init();
      const cb = vi.fn();
      const unsub = service.onChange(cb);
      unsub();

      mockTauri.dispatchEvent('project_switch_started', { project: 'p' });
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('onProjectReady', () => {
    it('fires only on succeeded, not on started or failed', async () => {
      await service.init();
      const cb = vi.fn();
      service.onProjectReady(cb);

      mockTauri.dispatchEvent('project_switch_started', { project: 'p' });
      expect(cb).not.toHaveBeenCalled();

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'p' });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('returns working unsubscribe', async () => {
      await service.init();
      const cb = vi.fn();
      const unsub = service.onProjectReady(cb);
      unsub();

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'p' });
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('onProjectFailed', () => {
    it('fires with error string on failure', async () => {
      await service.init();
      const cb = vi.fn();
      service.onProjectFailed(cb);

      mockTauri.dispatchEvent('project_switch_failed', {
        project: 'old',
        error: 'boom',
      });
      expect(cb).toHaveBeenCalledWith('boom');
    });
  });

  describe('onProjectSettled', () => {
    it('fires on both succeeded and failed', async () => {
      await service.init();
      const cb = vi.fn();
      service.onProjectSettled(cb);

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'p' });
      expect(cb).toHaveBeenCalledTimes(1);

      mockTauri.dispatchEvent('project_switch_failed', {
        project: 'p',
        error: 'fail',
      });
      expect(cb).toHaveBeenCalledTimes(2);
    });
  });

  describe('switchProject', () => {
    it('invokes the backend switch_project command', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      await service.switchProject('alpha');
      expect(spy).toHaveBeenCalledWith('switch_project', { name: 'alpha' });
    });
  });

  describe('addProject', () => {
    it('invokes the backend add_project command', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      await service.addProject('beta', '/tmp/beta');
      expect(spy).toHaveBeenCalledWith('add_project', { name: 'beta', dir: '/tmp/beta' });
    });
  });
});
