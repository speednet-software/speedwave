import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import { notConfiguredMessage, type ToolsCallResult } from '@speedwave/mcp-shared';
import { ProjectScopeError, type PluginHost } from '../../client.js';
import { createToolDefinitions } from '../../tools/index.js';
import { expectEmittedKeysDeclared } from '../../tools/test-helpers.js';
import { createAgileTools } from './tools.js';
import { AGILE_UNAVAILABLE_MESSAGE } from './api.js';

const textOf = (result: ToolsCallResult): string => (result.content[0] as { text: string }).text;

const AGILE_NAMES = [
  'listAgileSprints',
  'getAgileSprint',
  'getIssueAgileData',
  'setIssueAgileData',
  'createAgileSprint',
  'updateAgileSprint',
  'deleteAgileSprint',
];

describe('agile tools', () => {
  let host: { [K in keyof PluginHost]: ReturnType<typeof vi.fn> };
  let tools: ReturnType<typeof createAgileTools>;

  const tool = (name: string) => tools.find((t) => t.tool.name === name)!;
  const call = (name: string, params: Record<string, unknown>) => tool(name).handler(params);

  beforeEach(() => {
    host = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getProjectScope: vi.fn().mockReturnValue('scoped'),
      ensureProjectInScope: vi.fn().mockResolvedValue(undefined),
      ensureIssueInScope: vi.fn().mockResolvedValue(undefined),
    };
    tools = createAgileTools({ pluginHost: () => host as unknown as PluginHost });
  });

  it('defines the seven tools', () => {
    expect(tools.map((t) => t.tool.name)).toEqual(AGILE_NAMES);
  });

  it('returns the unconfigured error from every tool without a client', async () => {
    for (const def of createAgileTools(null)) {
      expect(textOf(await def.handler({}))).toBe(`Error: ${notConfiguredMessage('Redmine')}`);
    }
  });

  it('is part of the aggregated tool list', () => {
    const names = createToolDefinitions(null).map((d) => d.tool.name);
    expect(names).toEqual(expect.arrayContaining(AGILE_NAMES));
  });

  it('listAgileSprints defaults to the configured project and declares its output', async () => {
    host.get.mockResolvedValue({
      sprints: [{ id: 1, name: 'a', status: 'open', sharing: 'none' }],
    });

    const def = tool('listAgileSprints');
    const emitted = expectEmittedKeysDeclared(def.tool, await def.handler({ status: 'open' }));

    expect(host.get).toHaveBeenCalledWith('/projects/scoped/agile_sprints.json', {
      status: 'open',
    });
    expect(emitted.total_count).toBe(1);
  });

  it('listAgileSprints passes a named project through the scope check', async () => {
    host.get.mockResolvedValue({});
    await call('listAgileSprints', { project_id: 'other', include_shared: true });
    expect(host.ensureProjectInScope).toHaveBeenCalledWith('other');
    expect(host.get).toHaveBeenCalledWith('/projects/other/agile_sprints.json', {
      include_shared: 1,
    });
  });

  it('asks for project_id when none is configured or given', async () => {
    host.getProjectScope.mockReturnValue(null);
    const result = await call('listAgileSprints', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No default project is configured');
    expect(host.get).not.toHaveBeenCalled();
  });

  it('reports a project outside the scope as a scope error', async () => {
    host.ensureProjectInScope.mockRejectedValue(new ProjectScopeError('scoped', 'other'));
    const result = await call('getAgileSprint', { project_id: 'other', sprint_id: 1 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Project scope violation');
    expect(host.get).not.toHaveBeenCalled();
  });

  it('getAgileSprint returns totals and issues', async () => {
    host.get.mockResolvedValue({ id: 1, name: 'a', story_points: 8, issues: [{ id: 5 }] });
    const def = tool('getAgileSprint');
    const emitted = expectEmittedKeysDeclared(
      def.tool,
      await def.handler({ sprint_id: 1, include_issues: true })
    );
    expect(host.get).toHaveBeenCalledWith('/projects/scoped/agile_sprints/1.json', {
      include: 'issues',
    });
    expect(emitted.issues).toEqual([{ id: 5 }]);
  });

  it('createAgileSprint and updateAgileSprint send codes and return the sprint', async () => {
    host.post.mockResolvedValue({ id: 2, name: 'n', status: 'active' });
    host.put.mockResolvedValue('');
    host.get.mockResolvedValue({ id: 2, name: 'n2', status: 'closed' });

    const created = await call('createAgileSprint', {
      name: 'n',
      start_date: '2026-12-01',
      end_date: '2026-12-14',
      status: 'active',
    });
    const updated = await call('updateAgileSprint', { sprint_id: 2, status: 'closed' });

    expect(host.post.mock.calls[0][1].agile_sprint.status).toBe(1);
    expect(host.put.mock.calls[0][1]).toEqual({ agile_sprint: { status: 2 } });
    expect(JSON.parse(textOf(created)).status).toBe('active');
    expect(JSON.parse(textOf(updated)).status).toBe('closed');
  });

  it('updateAgileSprint with no field is an error and sends nothing', async () => {
    const result = await call('updateAgileSprint', { sprint_id: 2 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Nothing to update');
    expect(host.put).not.toHaveBeenCalled();
  });

  it('deleteAgileSprint reports the deletion', async () => {
    const def = tool('deleteAgileSprint');
    const emitted = expectEmittedKeysDeclared(def.tool, await def.handler({ sprint_id: 2 }));
    expect(emitted).toEqual({ deleted: true });
    expect(host.delete).toHaveBeenCalledWith('/projects/scoped/agile_sprints/2.json');
  });

  it('getIssueAgileData returns the four fields', async () => {
    host.get.mockResolvedValue({
      agile_data: { agile_sprint_id: 3, story_points: 5, position: 1, color: 'x' },
    });
    const def = tool('getIssueAgileData');
    const emitted = expectEmittedKeysDeclared(def.tool, await def.handler({ issue_id: 580 }));
    expect(emitted).toEqual({ agile_sprint_id: 3, story_points: 5, position: 1, color: 'x' });
  });

  it('getIssueAgileData fails with the issue outside the scope', async () => {
    host.ensureIssueInScope.mockRejectedValue(new ProjectScopeError('scoped', 'other'));
    const result = await call('getIssueAgileData', { issue_id: 580 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Project scope violation');
  });

  it('setIssueAgileData returns the state read back', async () => {
    host.put.mockResolvedValue('');
    host.get.mockResolvedValue({ agile_sprint_id: 3 });
    const def = tool('setIssueAgileData');
    const emitted = expectEmittedKeysDeclared(
      def.tool,
      await def.handler({ issue_id: 580, agile_sprint_id: 3, story_points: 5 })
    );
    expect(emitted.story_points).toBeNull();
  });

  it('setIssueAgileData accepts null as an unlink and rejects an empty call', async () => {
    host.put.mockResolvedValue('');
    host.get.mockResolvedValue({});
    const unlink = await call('setIssueAgileData', { issue_id: 580, agile_sprint_id: null });
    expect(unlink.isError).toBeUndefined();

    const empty = await call('setIssueAgileData', { issue_id: 580 });
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toContain('agile_sprint_id or story_points');
    expect(host.put).toHaveBeenCalledTimes(1);
  });

  it.each(['Sprint 12', -1, 1.5, 0])(
    'rejects agile_sprint_id %s before any request',
    async (value) => {
      const result = await call('setIssueAgileData', { issue_id: 580, agile_sprint_id: value });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('agile_sprint_id');
      expect(host.put).not.toHaveBeenCalled();
    }
  );

  it('gives the one agile message for a 403 from the plugin', async () => {
    host.get.mockRejectedValue(
      new AxiosError('f', '403', undefined, undefined, {
        status: 403,
        data: '',
        statusText: '',
        headers: {},
        config: {} as never,
      })
    );
    const result = await call('listAgileSprints', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(AGILE_UNAVAILABLE_MESSAGE);
  });

  it('passes the Redmine 422 message on', async () => {
    host.post.mockRejectedValue(
      new AxiosError('f', '422', undefined, undefined, {
        status: 422,
        data: { errors: ['Dates overlap another sprint'] },
        statusText: '',
        headers: {},
        config: {} as never,
      })
    );
    const result = await call('createAgileSprint', { name: 'n', start_date: 'a', end_date: 'b' });
    expect(textOf(result)).toContain('Dates overlap another sprint');
  });

  it('rejects an unknown status word before any request', async () => {
    const result = await call('createAgileSprint', { name: 'n', status: 'paused' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown status "paused"');
    expect(host.post).not.toHaveBeenCalled();
  });
});
