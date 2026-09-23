import { describe, it, expect, vi } from 'vitest';
import { notConfiguredMessage, type ToolsCallResult } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './index.js';
import type { RedmineClient } from '../client.js';

const textOf = (result: ToolsCallResult): string => (result.content[0] as { text: string }).text;

const createMockClient = () => ({
  getMappings: vi.fn().mockReturnValue({}),
  updateIssue: vi.fn().mockResolvedValue({ id: 83432, subject: 's', status: { id: 1 } }),
  createIssue: vi.fn().mockResolvedValue({ id: 1 }),
  deleteJournal: vi.fn().mockResolvedValue(undefined),
  resolveUser: vi.fn().mockResolvedValue(1454),
  getCurrentUser: vi.fn().mockResolvedValue({ id: 1454, login: 'kacper' }),
});

const handlerFor = (client: ReturnType<typeof createMockClient>, name: string) =>
  createToolDefinitions(client as unknown as RedmineClient).find((d) => d.tool.name === name)!
    .handler;

describe('Redmine declared-parameter guard', () => {
  describe.each(createToolDefinitions(null).map((d) => [d.tool.name, d] as const))(
    '%s',
    (_name, def) => {
      it('rejects an undeclared argument before the handler runs', async () => {
        const result = await def.handler({ not_a_declared_param: 1 });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(`${def.tool.name} does not accept this parameter`);
        expect(textOf(result)).not.toContain(notConfiguredMessage('Redmine'));
      });

      it('declares every argument its input examples use, with valid numeric IDs', async () => {
        const declared = Object.keys(def.tool.inputSchema.properties);
        for (const example of def.tool.inputExamples ?? []) {
          expect(declared, example.description).toEqual(
            expect.arrayContaining(Object.keys(example.input))
          );
          const result = await def.handler(example.input);
          expect(textOf(result), example.description).toBe(
            `Error: ${notConfiguredMessage('Redmine')}`
          );
        }
      });
    }
  );

  it('rejects a misspelled field instead of reporting a successful update', async () => {
    const client = createMockClient();
    const updateIssue = handlerFor(client, 'updateIssue');

    const result = await updateIssue({ issue_id: 83432, fixed_version: 87 });

    expect(client.updateIssue).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid fixed_version.');
    expect(textOf(result)).toContain('fixed_version_id');
  });

  it('sends a declared fixed_version_id through to the client', async () => {
    const client = createMockClient();
    const updateIssue = handlerFor(client, 'updateIssue');

    const result = await updateIssue({ issue_id: 83432, fixed_version_id: 87 });

    expect(result.isError).toBeUndefined();
    expect(client.updateIssue).toHaveBeenCalledWith(83432, {
      issue_id: 83432,
      fixed_version_id: 87,
    });
  });

  it('rejects parent_id on createIssue and names parent_issue_id as accepted', async () => {
    const client = createMockClient();
    const createIssue = handlerFor(client, 'createIssue');

    const result = await createIssue({ project_id: 'p', subject: 'Sub-task', parent_id: 10 });

    expect(client.createIssue).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('Invalid parent_id.');
    expect(textOf(result)).toMatch(/Accepted parameters: .*parent_issue_id/);
  });

  it('rejects any argument to getCurrentUser, which accepts none', async () => {
    const client = createMockClient();

    const result = await handlerFor(client, 'getCurrentUser')({ include: ['api_key'] });

    expect(client.getCurrentUser).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('Accepted parameters: none.');
  });

  it('lets a call with only declared arguments reach the client', async () => {
    const client = createMockClient();

    const result = await handlerFor(client, 'getCurrentUser')({});

    expect(client.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(JSON.parse(textOf(result))).toEqual({ id: 1454, login: 'kacper' });
  });

  it('rejects resolveUser without an identifier instead of listing every user', async () => {
    const client = createMockClient();

    const result = await handlerFor(client, 'resolveUser')({});

    expect(client.resolveUser).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('resolveUser requires identifier');
  });

  describe('numeric IDs', () => {
    it('rejects a path-traversal journal_id without calling the client', async () => {
      const client = createMockClient();

      const result = await handlerFor(
        client,
        'deleteJournal'
      )({
        issue_id: 5,
        journal_id: '../../../issues/999',
      });

      expect(client.deleteJournal).not.toHaveBeenCalled();
      expect(textOf(result)).toContain('Invalid journal_id');
      expect(textOf(result)).toContain('positive integer');
    });

    it('turns a digit string into a number before the client sees it', async () => {
      const client = createMockClient();

      await handlerFor(client, 'deleteJournal')({ issue_id: '5', journal_id: '67890' });

      expect(client.deleteJournal).toHaveBeenCalledWith(5, 67890);
    });

    it.each([null, 0, -3, 4.5, 'NaN'])(
      'rejects fixed_version_id %j, which would otherwise clear or corrupt the version',
      async (value) => {
        const client = createMockClient();

        const result = await handlerFor(
          client,
          'updateIssue'
        )({
          issue_id: 83432,
          fixed_version_id: value,
        });

        expect(client.updateIssue).not.toHaveBeenCalled();
        expect(textOf(result)).toContain('Invalid fixed_version_id');
      }
    );

    it('leaves status_id, which also takes open/closed/*, to the handler', async () => {
      const client = { ...createMockClient(), listIssues: vi.fn() };
      client.listIssues.mockResolvedValue({ issues: [], total_count: 0 });

      const result = await handlerFor(client, 'listIssueIds')({ status_id: '*' });

      expect(result.isError).toBeUndefined();
      expect(client.listIssues).toHaveBeenCalledWith({ status_id: '*' });
    });
  });
});
