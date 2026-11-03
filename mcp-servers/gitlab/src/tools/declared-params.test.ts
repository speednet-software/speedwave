import { describe, it, expect, vi } from 'vitest';
import { notConfiguredMessage, type ToolsCallResult } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './index.js';
import type { GitLabClient } from '../client.js';

const textOf = (result: ToolsCallResult): string => (result.content[0] as { text: string }).text;

const createMockClient = () => ({
  updateIssue: vi.fn().mockResolvedValue({ iid: 7 }),
  updateMergeRequest: vi.fn().mockResolvedValue({ iid: 7 }),
  listProjects: vi.fn().mockResolvedValue([]),
  listPipelines: vi.fn().mockResolvedValue([]),
});

const handlerFor = (client: ReturnType<typeof createMockClient>, name: string) =>
  createToolDefinitions(client as unknown as GitLabClient).find((d) => d.tool.name === name)!
    .handler;

describe('GitLab declared-parameter guard', () => {
  describe.each(createToolDefinitions(null).map((d) => [d.tool.name, d] as const))(
    '%s',
    (_name, def) => {
      it('rejects an undeclared argument before the handler runs', async () => {
        const result = await def.handler({ not_a_declared_param: 1 });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(`${def.tool.name} does not accept this parameter`);
        expect(textOf(result)).not.toContain(notConfiguredMessage('GitLab'));
      });

      it('declares every argument its input examples use', async () => {
        const declared = Object.keys(def.tool.inputSchema.properties);
        for (const example of def.tool.inputExamples ?? []) {
          expect(declared, example.description).toEqual(
            expect.arrayContaining(Object.keys(example.input))
          );
          const result = await def.handler(example.input);
          expect(textOf(result), example.description).toBe(
            `Error: ${notConfiguredMessage('GitLab')}`
          );
        }
      });
    }
  );

  it('rejects milestone_id on updateIssue instead of reporting a successful update', async () => {
    const client = createMockClient();

    const result = await handlerFor(
      client,
      'updateIssue'
    )({
      project_id: 'g/p',
      issue_iid: 7,
      milestone_id: 3,
    });

    expect(client.updateIssue).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('milestone_id');
    expect(textOf(result)).toContain('Accepted parameters');
  });

  it('rejects remove_source_branch on updateMergeRequest', async () => {
    const client = createMockClient();

    const result = await handlerFor(
      client,
      'updateMergeRequest'
    )({
      project_id: 'g/p',
      mr_iid: 7,
      remove_source_branch: true,
    });

    expect(client.updateMergeRequest).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('remove_source_branch');
  });

  it('rejects a missing required argument before calling the client', async () => {
    const client = createMockClient();

    const result = await handlerFor(client, 'updateIssue')({ project_id: 'g/p' });

    expect(client.updateIssue).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('updateIssue requires issue_iid');
  });

  it('sends a declared call through to the client', async () => {
    const client = createMockClient();

    const result = await handlerFor(
      client,
      'updateIssue'
    )({
      project_id: 'g/p',
      issue_iid: '#7',
      title: 'New',
    });

    expect(result.isError).toBeUndefined();
    expect(client.updateIssue).toHaveBeenCalledWith('g/p', 7, { title: 'New' });
  });

  it.each([
    ['listProjects', 'listProjectIds', {}],
    ['listPipelines', 'listPipelineIds', { project_id: 'g/p' }],
  ])('passes the page argument of %s through to the client', async (method, tool, base) => {
    const client = createMockClient();

    await handlerFor(client, tool)({ ...base, page: 2 });

    const mock = client[method as 'listProjects' | 'listPipelines'];
    expect(mock.mock.calls[0]!.at(-1)).toMatchObject({ page: 2 });
  });
});
