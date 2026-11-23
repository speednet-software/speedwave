import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import { ProjectScopeError, type PluginHost } from '../../client.js';
import { AgileApi, AGILE_UNAVAILABLE_MESSAGE } from './api.js';

const httpError = (status: number, data: unknown = {}) =>
  new AxiosError('failed', String(status), undefined, undefined, {
    status,
    data,
    statusText: '',
    headers: {},
    config: {} as never,
  });

describe('AgileApi', () => {
  let host: { [K in keyof PluginHost]: ReturnType<typeof vi.fn> };
  let api: AgileApi;

  beforeEach(() => {
    host = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getProjectScope: vi.fn().mockReturnValue(null),
      ensureProjectInScope: vi.fn().mockResolvedValue(undefined),
      ensureIssueInScope: vi.fn().mockResolvedValue(undefined),
    };
    api = new AgileApi(host as unknown as PluginHost);
  });

  describe('resolveProject', () => {
    it('uses the given project after the scope check', async () => {
      expect(await api.resolveProject('p')).toBe('p');
      expect(host.ensureProjectInScope).toHaveBeenCalledWith('p');
    });

    it('defaults to the configured project', async () => {
      host.getProjectScope.mockReturnValue('scoped');
      expect(await api.resolveProject()).toBe('scoped');
    });

    it('returns null when no project is given or configured', async () => {
      expect(await api.resolveProject()).toBeNull();
      expect(host.ensureProjectInScope).not.toHaveBeenCalled();
    });

    it('lets the scope error through', async () => {
      host.ensureProjectInScope.mockRejectedValue(new ProjectScopeError('a', 'b'));
      await expect(api.resolveProject('b')).rejects.toBeInstanceOf(ProjectScopeError);
    });
  });

  describe('listSprints', () => {
    it('sends the filters and sends include_shared as 1', async () => {
      host.get.mockResolvedValue({ sprints: [{ id: 1, status: 'open' }], total_count: 1 });

      const result = await api.listSprints('my project', {
        status: 'open',
        include_shared: true,
        limit: 5,
      });

      expect(host.get).toHaveBeenCalledWith('/projects/my%20project/agile_sprints.json', {
        status: 'open',
        limit: 5,
        include_shared: 1,
      });
      expect(result.sprints).toEqual([{ id: 1, status: 'open' }]);
      expect(result.limit).toBe(5);
    });

    it('omits include_shared when false', async () => {
      host.get.mockResolvedValue({});
      await api.listSprints('p', { include_shared: false });
      expect(host.get).toHaveBeenCalledWith('/projects/p/agile_sprints.json', {});
    });
  });

  describe('getSprint', () => {
    it('adds include=issues on request', async () => {
      host.get.mockResolvedValue({ id: 3, issues: [{ id: 1 }] });
      const sprint = await api.getSprint('p', 3, true);
      expect(host.get).toHaveBeenCalledWith('/projects/p/agile_sprints/3.json', {
        include: 'issues',
      });
      expect(sprint.issues).toEqual([{ id: 1 }]);
    });

    it('sends no params without issues', async () => {
      host.get.mockResolvedValue({ id: 3 });
      await api.getSprint('p', 3, false);
      expect(host.get).toHaveBeenCalledWith('/projects/p/agile_sprints/3.json', undefined);
    });
  });

  describe('createSprint', () => {
    it('sends status and sharing as integer codes', async () => {
      host.post.mockResolvedValue({ id: 7, name: 'S', status: 'active', sharing: 'tree' });

      const sprint = await api.createSprint('p', {
        name: 'S',
        start_date: '2026-12-01',
        end_date: '2026-12-14',
        status: 'active',
        sharing: 'tree',
      });

      expect(host.post).toHaveBeenCalledWith('/projects/p/agile_sprints.json', {
        agile_sprint: {
          name: 'S',
          start_date: '2026-12-01',
          end_date: '2026-12-14',
          status: 1,
          sharing: 3,
        },
      });
      expect(sprint).toEqual({ id: 7, name: 'S', status: 'active', sharing: 'tree' });
    });

    it('sends neither status nor sharing when not given', async () => {
      host.post.mockResolvedValue({ id: 7 });
      await api.createSprint('p', { name: 'S' });
      expect(host.post).toHaveBeenCalledWith('/projects/p/agile_sprints.json', {
        agile_sprint: { name: 'S' },
      });
    });

    it('sends status 0 for open', async () => {
      host.post.mockResolvedValue({ id: 7 });
      await api.createSprint('p', { name: 'S', status: 'open', sharing: 'none' });
      expect(host.post.mock.calls[0][1]).toEqual({
        agile_sprint: { name: 'S', status: 0, sharing: 0 },
      });
    });
  });

  describe('updateSprint', () => {
    it('writes with codes and returns the sprint read back', async () => {
      host.put.mockResolvedValue('');
      host.get.mockResolvedValue({ id: 3, name: 'New', status: 'closed' });

      const sprint = await api.updateSprint('p', 3, { name: 'New', status: 'closed' });

      expect(host.put).toHaveBeenCalledWith('/projects/p/agile_sprints/3.json', {
        agile_sprint: { name: 'New', status: 2 },
      });
      expect(host.get).toHaveBeenCalledWith('/projects/p/agile_sprints/3.json', undefined);
      expect(sprint).toEqual({ id: 3, name: 'New', status: 'closed' });
    });

    it('refuses an update with no fields and sends nothing', async () => {
      await expect(api.updateSprint('p', 3, {})).rejects.toThrow('Nothing to update on sprint 3');
      expect(host.put).not.toHaveBeenCalled();
    });
  });

  it('deletes a sprint', async () => {
    await api.deleteSprint('p', 3);
    expect(host.delete).toHaveBeenCalledWith('/projects/p/agile_sprints/3.json');
  });

  describe('issue agile data', () => {
    it('reads after the issue scope check', async () => {
      host.get.mockResolvedValue({ agile_data: { agile_sprint_id: 3, story_points: 5 } });

      const data = await api.getIssueAgileData(580);

      expect(host.ensureIssueInScope).toHaveBeenCalledWith(580);
      expect(host.get).toHaveBeenCalledWith('/issues/580/agile_data.json');
      expect(data).toEqual({ agile_sprint_id: 3, story_points: 5, position: null, color: null });
    });

    it('writes both fields and returns the state read back, not the request', async () => {
      host.put.mockResolvedValue('');
      host.get.mockResolvedValue({ agile_sprint_id: 3, story_points: null });

      const data = await api.setIssueAgileData(580, { agile_sprint_id: 3, story_points: 5 });

      expect(host.put).toHaveBeenCalledWith('/issues/580.json', {
        issue: { agile_data_attributes: { agile_sprint_id: 3, story_points: 5 } },
      });
      expect(data.story_points).toBeNull();
    });

    it('sends null to unlink a sprint and omits story points', async () => {
      host.put.mockResolvedValue('');
      host.get.mockResolvedValue({});
      await api.setIssueAgileData(580, { agile_sprint_id: null });
      expect(host.put.mock.calls[0][1]).toEqual({
        issue: { agile_data_attributes: { agile_sprint_id: null } },
      });
    });

    it('sends story points alone', async () => {
      host.put.mockResolvedValue('');
      host.get.mockResolvedValue({});
      await api.setIssueAgileData(580, { story_points: 2 });
      expect(host.put.mock.calls[0][1]).toEqual({
        issue: { agile_data_attributes: { story_points: 2 } },
      });
    });

    it('writes nothing when the issue is out of scope', async () => {
      host.ensureIssueInScope.mockRejectedValue(new ProjectScopeError('a'));
      await expect(api.setIssueAgileData(580, { story_points: 2 })).rejects.toBeInstanceOf(
        ProjectScopeError
      );
      expect(host.put).not.toHaveBeenCalled();
    });
  });

  describe('errors', () => {
    it.each([403, 404])('turns %i from an agile endpoint into one message', async (status) => {
      host.get.mockRejectedValue(httpError(status));
      await expect(api.listSprints('p', {})).rejects.toThrow(AGILE_UNAVAILABLE_MESSAGE);
      host.put.mockRejectedValue(httpError(status));
      await expect(api.setIssueAgileData(1, { story_points: 1 })).rejects.toThrow(
        AGILE_UNAVAILABLE_MESSAGE
      );
      host.delete.mockRejectedValue(httpError(status));
      await expect(api.deleteSprint('p', 1)).rejects.toThrow(AGILE_UNAVAILABLE_MESSAGE);
    });

    it('passes a 422 through unchanged for the Redmine message', async () => {
      const error = httpError(422, { errors: ['Dates overlap'] });
      host.post.mockRejectedValue(error);
      await expect(api.createSprint('p', { name: 'S' })).rejects.toBe(error);
    });

    it('passes a non-HTTP error through', async () => {
      const error = new Error('boom');
      host.get.mockRejectedValue(error);
      await expect(api.getSprint('p', 1, false)).rejects.toBe(error);
    });

    it('does not turn a scope-check failure into the plugin message', async () => {
      host.ensureIssueInScope.mockRejectedValue(httpError(404));
      await expect(api.getIssueAgileData(1)).rejects.toMatchObject({ response: { status: 404 } });
    });
  });
});
