import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { RedmineClient, ProjectScopeError } from './client.js';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

describe('RedmineClient plugin host', () => {
  let http: { get: any; post: any; put: any; delete: any; interceptors: any };

  const clientFor = (project_id?: string) =>
    new RedmineClient(
      { url: 'https://redmine.example.com', apiKey: 'k' },
      project_id ? { host_url: 'x', project_id } : null
    );

  beforeEach(() => {
    http = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      interceptors: { response: { use: vi.fn() } },
    };
    mockedAxios.create = vi.fn().mockReturnValue(http);
  });

  it('forwards requests and returns the response bodies', async () => {
    const host = clientFor().pluginHost();
    http.get.mockResolvedValue({ data: { a: 1 } });
    http.post.mockResolvedValue({ data: { b: 2 } });
    http.put.mockResolvedValue({ data: { c: 3 } });
    http.delete.mockResolvedValue({ data: '' });

    expect(await host.get('/x.json', { q: 1 })).toEqual({ a: 1 });
    expect(http.get).toHaveBeenCalledWith('/x.json', { params: { q: 1 } });
    expect(await host.post('/x.json', { p: 1 })).toEqual({ b: 2 });
    expect(http.post).toHaveBeenCalledWith('/x.json', { p: 1 });
    expect(await host.put('/x.json', { p: 2 })).toEqual({ c: 3 });
    expect(http.put).toHaveBeenCalledWith('/x.json', { p: 2 });
    expect(await host.delete('/x.json')).toBeUndefined();
    expect(http.delete).toHaveBeenCalledWith('/x.json');
  });

  it('exposes the configured project scope', () => {
    expect(clientFor('proj').pluginHost().getProjectScope()).toBe('proj');
    expect(clientFor().pluginHost().getProjectScope()).toBeNull();
  });

  describe('ensureProjectInScope', () => {
    it('accepts any project when unscoped', async () => {
      await expect(clientFor().pluginHost().ensureProjectInScope('any')).resolves.toBeUndefined();
      expect(http.get).not.toHaveBeenCalled();
    });

    it('accepts the configured identifier without a request', async () => {
      await clientFor('proj').pluginHost().ensureProjectInScope('proj');
      expect(http.get).not.toHaveBeenCalled();
    });

    it('accepts the numeric ID of the configured project', async () => {
      http.get.mockResolvedValue({ data: { project: { id: 7 } } });
      await expect(clientFor('proj').pluginHost().ensureProjectInScope(7)).resolves.toBeUndefined();
    });

    it('rejects another project', async () => {
      http.get.mockResolvedValue({ data: { project: { id: 7 } } });
      await expect(clientFor('proj').pluginHost().ensureProjectInScope(8)).rejects.toBeInstanceOf(
        ProjectScopeError
      );
    });
  });

  describe('ensureIssueInScope', () => {
    it('checks the issue only when scoped', async () => {
      await clientFor().pluginHost().ensureIssueInScope(5);
      expect(http.get).not.toHaveBeenCalled();

      http.get.mockImplementation(async (path: string) => ({
        data: path.startsWith('/projects/')
          ? { project: { id: 7 } }
          : { issue: { id: 5, project: { id: 7 } } },
      }));
      await clientFor('proj').pluginHost().ensureIssueInScope(5);
      expect(http.get).toHaveBeenCalledWith('/issues/5.json', expect.anything());
    });
  });
});
