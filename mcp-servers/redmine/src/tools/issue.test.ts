import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notConfiguredMessage } from '@speedwave/mcp-shared';
import { createIssueTools } from './issue-tools.js';
import { expectEmittedKeysDeclared } from './test-helpers.js';
import { RedmineClient, ProjectScopeError } from '../client.js';

type SchemaNode = { type: string; items?: SchemaNode; properties?: Record<string, SchemaNode> };

type MockClient = {
  listIssues: Mock;
  showIssue: Mock;
  searchIssues: Mock;
  createIssue: Mock;
  updateIssue: Mock;
  commentIssue: Mock;
  resolveUser: Mock;
  getMappings: Mock;
  getProjectScope: Mock;
};

const createMockClient = (): MockClient => ({
  listIssues: vi.fn(),
  showIssue: vi.fn(),
  searchIssues: vi.fn(),
  createIssue: vi.fn(),
  updateIssue: vi.fn(),
  commentIssue: vi.fn(),
  resolveUser: vi.fn(),
  getMappings: vi.fn(),
  getProjectScope: vi.fn().mockReturnValue(null),
});

describe('issue-tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    mockClient.getMappings.mockReturnValue({
      status_new: 1,
      status_in_progress: 2,
      status_resolved: 3,
      priority_low: 1,
      priority_normal: 2,
      priority_high: 3,
      tracker_bug: 1,
      tracker_feature: 2,
      activity_development: 1,
    });
  });

  describe('listIssueIds', () => {
    it('lists issues successfully', async () => {
      mockClient.listIssues.mockResolvedValue({
        issues: [{ id: 1 }, { id: 2 }, { id: 3 }],
        total_count: 3,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      const result = await handler!({});

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ids: [1, 2, 3], total_count: 3 }, null, 2),
          },
        ],
      });
      expect(mockClient.listIssues).toHaveBeenCalledWith({});
    });

    it('handles filters with project_id', async () => {
      mockClient.listIssues.mockResolvedValue({
        issues: [{ id: 1 }],
        total_count: 1,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ project_id: 'test-project' });

      expect(mockClient.listIssues).toHaveBeenCalledWith({
        project_id: 'test-project',
      });
    });

    it('handles special status values (open, closed, *)', async () => {
      mockClient.listIssues.mockResolvedValue({
        issues: [],
        total_count: 0,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ status: 'open' });

      expect(mockClient.listIssues).toHaveBeenCalledWith({
        status_id: 'open',
      });
    });

    it('resolves status name to status_id using mappings', async () => {
      mockClient.listIssues.mockResolvedValue({
        issues: [],
        total_count: 0,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ status: 'new' });

      expect(mockClient.listIssues).toHaveBeenCalledWith({
        status_id: 1,
      });
    });

    it('handles limit and offset parameters', async () => {
      mockClient.listIssues.mockResolvedValue({
        issues: [],
        total_count: 0,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ limit: 50, offset: 100 });

      expect(mockClient.listIssues).toHaveBeenCalledWith({
        limit: 50,
        offset: 100,
      });
    });

    it('handles API errors gracefully', async () => {
      mockClient.listIssues.mockRejectedValue(new Error('Network error'));

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      const result = await handler!({});

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Network error' }],
        isError: true,
      });
    });

    it('handles empty results', async () => {
      mockClient.listIssues.mockResolvedValue({
        issues: [],
        total_count: 0,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      const result = await handler!({});

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ids: [], total_count: 0 }, null, 2),
          },
        ],
      });
    });

    it('resolves assigned_to "me" to assigned_to_id', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [{ id: 1 }], total_count: 1 });
      mockClient.resolveUser.mockResolvedValue(496);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: 'me' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('me');
      expect(mockClient.listIssues).toHaveBeenCalledWith({ assigned_to_id: 496 });
    });

    it('resolves assigned_to username to assigned_to_id', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [{ id: 1 }], total_count: 1 });
      mockClient.resolveUser.mockResolvedValue(42);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: 'john.doe' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('john.doe');
      expect(mockClient.listIssues).toHaveBeenCalledWith({ assigned_to_id: 42 });
    });

    it('resolves assigned_to with special status open', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [], total_count: 0 });
      mockClient.resolveUser.mockResolvedValue(496);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ status: 'open', assigned_to: 'me' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('me');
      expect(mockClient.listIssues).toHaveBeenCalledWith({
        status_id: 'open',
        assigned_to_id: 496,
      });
    });

    it('resolves assigned_to with non-special status', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [], total_count: 0 });
      mockClient.resolveUser.mockResolvedValue(496);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ status: 'new', assigned_to: 'me' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('me');
      expect(mockClient.listIssues).toHaveBeenCalledWith({
        status_id: 1,
        assigned_to_id: 496,
      });
    });

    it('returns a teaching error instead of silently dropping an unresolvable assigned_to', async () => {
      mockClient.resolveUser.mockResolvedValue(null);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      const result = await handler!({ assigned_to: 'nonexistent' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('nonexistent');
      expect(mockClient.listIssues).not.toHaveBeenCalled();
      expect(result).toMatchObject({ isError: true });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      expect(text).toContain('nonexistent');
      expect(text).toContain('Get a valid value from resolveUser.');
    });

    it('preserves assigned_to_id when already provided', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [{ id: 1 }], total_count: 1 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to_id: 42 });

      expect(mockClient.resolveUser).not.toHaveBeenCalled();
      expect(mockClient.listIssues).toHaveBeenCalledWith({ assigned_to_id: 42 });
    });

    it('skips resolution when both assigned_to and assigned_to_id are provided', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [{ id: 1 }], total_count: 1 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: 'john.doe', assigned_to_id: 42 });

      expect(mockClient.resolveUser).not.toHaveBeenCalled();
      expect(mockClient.listIssues).toHaveBeenCalledWith({
        assigned_to: 'john.doe',
        assigned_to_id: 42,
      });
    });

    it('resolves assigned_to numeric string to assigned_to_id', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [{ id: 1 }], total_count: 1 });
      mockClient.resolveUser.mockResolvedValue(123);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: '123' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('123');
      expect(mockClient.listIssues).toHaveBeenCalledWith({ assigned_to_id: 123 });
    });

    it('skips resolution when assigned_to is empty string', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [], total_count: 0 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: '' });

      expect(mockClient.resolveUser).not.toHaveBeenCalled();
      expect(mockClient.listIssues).toHaveBeenCalledWith({ assigned_to: '' });
    });

    it('skips resolution when assigned_to is null', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [], total_count: 0 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: null });

      expect(mockClient.resolveUser).not.toHaveBeenCalled();
      expect(mockClient.listIssues).toHaveBeenCalledWith({ assigned_to: null });
    });

    it('skips resolution when assigned_to is undefined', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [], total_count: 0 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: undefined });

      expect(mockClient.resolveUser).not.toHaveBeenCalled();
      expect(mockClient.listIssues).toHaveBeenCalledWith({});
    });

    it('handles resolveUser error gracefully', async () => {
      mockClient.resolveUser.mockRejectedValue(new Error('User API error'));

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      const result = await handler!({ assigned_to: 'me' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: User API error' }],
        isError: true,
      });
    });

    it('declares the ids-only shape the handler emits in outputSchema', async () => {
      mockClient.listIssues.mockResolvedValue({
        issues: [{ id: 7, subject: 'Only issue', status: { id: 1, name: 'New' } }],
        total_count: 1,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const def = tools.find((t) => t.tool.name === 'listIssueIds')!;
      const props = def.tool.outputSchema!.properties as Record<string, SchemaNode>;

      expect(props.issues).toBeUndefined();
      expect(props.ids.items).toEqual({ type: 'number' });
      expect(props.total_count).toEqual({ type: 'number' });
      expect(def.tool.outputSchema!.required).toEqual(['success']);

      const emitted = expectEmittedKeysDeclared(def.tool, await def.handler({}));
      expect(emitted).toEqual({ ids: [7], total_count: 1 });
    });

    it('passes the tracker, priority, target version and parent filters to the client', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [], total_count: 0 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')!.handler;

      await handler({
        status: 'open',
        tracker_id: 1,
        priority_id: 3,
        fixed_version_id: 87,
        parent_id: 10,
      });

      expect(mockClient.listIssues).toHaveBeenCalledWith({
        status_id: 'open',
        tracker_id: 1,
        priority_id: 3,
        fixed_version_id: 87,
        parent_id: 10,
      });
    });

    describe('category_id', () => {
      const listIssueIds = () =>
        createIssueTools(mockClient as unknown as RedmineClient).find(
          (t) => t.tool.name === 'listIssueIds'
        )!.handler;

      beforeEach(() => {
        mockClient.listIssues.mockResolvedValue({ issues: [{ id: 101 }], total_count: 1 });
      });

      it('passes a string filter to the client and returns the ids', async () => {
        const result = await listIssueIds()({ project_id: 'my-project', category_id: '!*' });

        expect(mockClient.listIssues).toHaveBeenCalledWith({
          project_id: 'my-project',
          category_id: '!*',
        });
        expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
          ids: [101],
          total_count: 1,
        });
      });

      it('uses the configured project when project_id is omitted', async () => {
        mockClient.getProjectScope.mockReturnValue('my-project');

        const result = await listIssueIds()({ category_id: 5 });

        expect(result.isError).toBeUndefined();
        expect(mockClient.listIssues).toHaveBeenCalledWith({ category_id: 5 });
      });

      it('returns an error before any request when there is no project', async () => {
        const result = await listIssueIds()({ category_id: 5 });

        expect(mockClient.listIssues).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect((result.content[0] as { text: string }).text).toContain(
          'category_id requires project_id'
        );
      });

      it('rejects the call before any user or mapping lookup', async () => {
        const result = await listIssueIds()({ category_id: 5, assigned_to: 'me', status: 'new' });

        expect(result.isError).toBe(true);
        expect(mockClient.resolveUser).not.toHaveBeenCalled();
        expect(mockClient.getMappings).not.toHaveBeenCalled();
        expect(mockClient.listIssues).not.toHaveBeenCalled();
      });

      it('does not require a project when category_id is not given', async () => {
        const result = await listIssueIds()({ status: 'open' });

        expect(result.isError).toBeUndefined();
        expect(mockClient.listIssues).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('getIssueFull', () => {
    it('retrieves full issue data successfully', async () => {
      const mockIssue = {
        id: 1,
        subject: 'Test Issue',
        description: 'Test description',
        status: { id: 1, name: 'New' },
        priority: { id: 2, name: 'Normal' },
        tracker: { id: 1, name: 'Bug' },
        project: { id: 1, name: 'Test Project' },
        author: { id: 1, name: 'Test User' },
        created_on: '2025-01-01T00:00:00Z',
        updated_on: '2025-01-01T00:00:00Z',
      };

      mockClient.showIssue.mockResolvedValue(mockIssue);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'getIssueFull')?.handler;

      const result = await handler!({ issue_id: 1 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockIssue, null, 2),
          },
        ],
      });
      expect(mockClient.showIssue).toHaveBeenCalledWith(1, { include: [] });
    });

    it('emits the bare issue with every key Redmine sends declared at the top of outputSchema', async () => {
      const issue = {
        id: 83432,
        project: { id: 1972, name: 'Auditor' },
        tracker: { id: 1, name: 'Bug' },
        status: { id: 2, name: 'In Progress', is_closed: false },
        priority: { id: 2, name: 'Normal' },
        author: { id: 7, name: 'Ala' },
        assigned_to: { id: 1454, name: 'Kacper' },
        category: { id: 3, name: 'Backend' },
        fixed_version: { id: 87, name: 'Week 10' },
        parent: { id: 83000 },
        subject: 'Planned',
        description: 'd',
        start_date: '2026-03-02',
        due_date: null,
        done_ratio: 0,
        is_private: false,
        estimated_hours: null,
        total_estimated_hours: null,
        spent_hours: 0,
        total_spent_hours: 0,
        custom_fields: [{ id: 1, name: 'Team', value: 'A' }],
        created_on: '2026-02-20T09:00:00Z',
        updated_on: '2026-02-21T09:00:00Z',
        closed_on: null,
        journals: [],
        attachments: [],
        relations: [],
        children: [],
        watchers: [],
        changesets: [],
        allowed_statuses: [],
      };
      mockClient.showIssue.mockResolvedValue(issue);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const def = tools.find((t) => t.tool.name === 'getIssueFull')!;

      const emitted = expectEmittedKeysDeclared(def.tool, await def.handler({ issue_id: 83432 }));

      expect(emitted).toEqual(issue);
      expect((def.tool.outputSchema!.properties as Record<string, unknown>).issue).toBeUndefined();
    });

    it('declares the journal and custom field keys Redmine sends in their nested schemas', async () => {
      const issue = {
        id: 1,
        custom_fields: [{ id: 1, name: 'Tags', value: ['a'], multiple: true }],
        journals: [
          {
            id: 9,
            user: { id: 1, name: 'U' },
            notes: 'n',
            private_notes: true,
            details: [{ property: 'attr', name: 'done_ratio', old_value: '0', new_value: '50' }],
            created_on: '2026-11-24T09:00:00Z',
            updated_on: '2026-11-24T09:05:00Z',
          },
        ],
      };
      mockClient.showIssue.mockResolvedValue(issue);
      const def = createIssueTools(mockClient as unknown as RedmineClient).find(
        (t) => t.tool.name === 'getIssueFull'
      )!;

      const emitted = expectEmittedKeysDeclared(
        def.tool,
        await def.handler({ issue_id: 1, include: ['journals'] })
      ) as typeof issue;

      const schema = def.tool.outputSchema!.properties as Record<string, SchemaNode>;
      expect(Object.keys(schema.journals.items!.properties!)).toEqual(
        expect.arrayContaining(Object.keys(emitted.journals[0]))
      );
      expect(Object.keys(schema.custom_fields.items!.properties!)).toEqual(
        expect.arrayContaining(Object.keys(emitted.custom_fields[0]))
      );
    });

    it('describes what each include value adds', () => {
      const def = createIssueTools(mockClient as unknown as RedmineClient).find(
        (t) => t.tool.name === 'getIssueFull'
      )!;
      const include = (def.tool.inputSchema.properties as Record<string, { description: string }>)
        .include;
      const enumValues = (
        def.tool.inputSchema.properties as Record<string, { items: { enum: string[] } }>
      ).include.items.enum;

      for (const value of enumValues) expect(include.description).toContain(`${value}:`);
    });

    it('includes additional data when requested', async () => {
      mockClient.showIssue.mockResolvedValue({ id: 1 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'getIssueFull')?.handler;

      await handler!({ issue_id: 1, include: ['journals', 'attachments'] });

      expect(mockClient.showIssue).toHaveBeenCalledWith(1, {
        include: ['journals', 'attachments'],
      });
    });

    it("include enum covers every value Redmine's issue show endpoint documents", () => {
      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const getIssueFullTool = tools.find((t) => t.tool.name === 'getIssueFull')!;
      const includeSchema = (
        getIssueFullTool.tool.inputSchema.properties as Record<
          string,
          { items?: { enum?: string[] } }
        >
      ).include;

      expect(includeSchema.items!.enum!.sort()).toEqual(
        [
          'journals',
          'attachments',
          'relations',
          'children',
          'watchers',
          'changesets',
          'allowed_statuses',
        ].sort()
      );
    });

    it('handles non-existent issue', async () => {
      mockClient.showIssue.mockRejectedValue(new Error('Resource not found in Redmine.'));

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'getIssueFull')?.handler;

      const result = await handler!({ issue_id: 9999 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in Redmine.' }],
        isError: true,
      });
    });

    it('passes issue_id as formatError context on failure', async () => {
      mockClient.showIssue.mockRejectedValue(new Error('Not found'));
      const formatErrorSpy = vi.spyOn(RedmineClient, 'formatError');

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'getIssueFull')?.handler;

      await handler!({ issue_id: 9999 });

      expect(formatErrorSpy).toHaveBeenCalledWith(expect.any(Error), { issue_id: 9999 });
    });
  });

  describe('searchIssueIds', () => {
    it('searches issues successfully', async () => {
      mockClient.searchIssues.mockResolvedValue({
        results: [
          { id: 1, type: 'issue', title: 'Test Issue 1' },
          { id: 2, type: 'issue', title: 'Test Issue 2' },
        ],
        total_count: 2,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'searchIssueIds')?.handler;

      const result = await handler!({ query: 'test' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ids: [1, 2], total_count: 2 }, null, 2),
          },
        ],
      });
      expect(mockClient.searchIssues).toHaveBeenCalledWith('test', {});
    });

    it('searches with project_id filter', async () => {
      mockClient.searchIssues.mockResolvedValue({
        results: [],
        total_count: 0,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'searchIssueIds')?.handler;

      await handler!({ query: 'test', project_id: 'my-project', limit: 10 });

      expect(mockClient.searchIssues).toHaveBeenCalledWith('test', {
        project_id: 'my-project',
        limit: 10,
      });
    });

    it('handles empty search results', async () => {
      mockClient.searchIssues.mockResolvedValue({
        results: [],
        total_count: 0,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'searchIssueIds')?.handler;

      const result = await handler!({ query: 'nonexistent' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ids: [], total_count: 0 }, null, 2),
          },
        ],
      });
    });

    it('declares the ids-only shape the handler emits in outputSchema', async () => {
      mockClient.searchIssues.mockResolvedValue({
        results: [{ id: 9, type: 'issue', title: 'Hit' }],
        total_count: 1,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const def = tools.find((t) => t.tool.name === 'searchIssueIds')!;
      const props = def.tool.outputSchema!.properties as Record<string, SchemaNode>;

      expect(props.results).toBeUndefined();
      expect(props.ids.items).toEqual({ type: 'number' });
      expect(props.total_count).toEqual({ type: 'number' });

      const emitted = expectEmittedKeysDeclared(def.tool, await def.handler({ query: 'hit' }));
      expect(emitted).toEqual({ ids: [9], total_count: 1 });
    });
  });

  describe('createIssue', () => {
    it('creates issue successfully', async () => {
      const mockCreatedIssue = {
        id: 1,
        subject: 'New Issue',
        status: { id: 1, name: 'New' },
        priority: { id: 2, name: 'Normal' },
        tracker: { id: 1, name: 'Bug' },
        project: { id: 1, name: 'Test Project' },
        author: { id: 1, name: 'Test User' },
        created_on: '2025-01-01T00:00:00Z',
        updated_on: '2025-01-01T00:00:00Z',
      };

      mockClient.createIssue.mockResolvedValue(mockCreatedIssue);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      const result = await handler!({
        project_id: 'test-project',
        subject: 'New Issue',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...mockCreatedIssue, ignored_fields: [] }, null, 2),
          },
        ],
      });
      expect(mockClient.createIssue).toHaveBeenCalledWith(
        { project_id: 'test-project', subject: 'New Issue' },
        undefined
      );
    });

    describe('file_paths', () => {
      let workspace: string;
      let previous: string | undefined;

      beforeEach(async () => {
        workspace = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'redmine-issue-')));
        previous = process.env.WORKSPACE_DIR;
        process.env.WORKSPACE_DIR = workspace;
        await fsp.writeFile(path.join(workspace, 'shot.png'), 'png');
      });

      afterEach(async () => {
        if (previous === undefined) delete process.env.WORKSPACE_DIR;
        else process.env.WORKSPACE_DIR = previous;
        await fsp.rm(workspace, { recursive: true, force: true });
      });

      const createIssueHandler = () =>
        createIssueTools(mockClient as unknown as RedmineClient).find(
          (t) => t.tool.name === 'createIssue'
        )!.handler;

      it('hands the resolved files to the client instead of the raw paths', async () => {
        mockClient.createIssue.mockResolvedValue({ id: 5 });

        await createIssueHandler()({
          project_id: 'p',
          subject: 's',
          file_paths: ['shot.png'],
        });

        expect(mockClient.createIssue).toHaveBeenCalledWith({ project_id: 'p', subject: 's' }, [
          { path: path.join(workspace, 'shot.png'), name: 'shot.png', size: 3 },
        ]);
      });

      it('rejects a path outside the workspace before resolving the assignee or creating anything', async () => {
        const result = await createIssueHandler()({
          project_id: 'p',
          subject: 's',
          assigned_to: 'jane',
          file_paths: ['/etc/passwd'],
        });

        expect(result.isError).toBe(true);
        expect((result.content[0] as { text: string }).text).toContain('file_paths[0]');
        expect(mockClient.resolveUser).not.toHaveBeenCalled();
        expect(mockClient.createIssue).not.toHaveBeenCalled();
      });

      it('creates the issue without files when file_paths is not given', async () => {
        mockClient.createIssue.mockResolvedValue({ id: 5 });

        await createIssueHandler()({ project_id: 'p', subject: 's' });

        expect(mockClient.createIssue).toHaveBeenCalledWith(
          { project_id: 'p', subject: 's' },
          undefined
        );
      });
    });

    it('resolves tracker name to tracker_id', async () => {
      mockClient.createIssue.mockResolvedValue({ id: 1 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      await handler!({
        project_id: 'test-project',
        subject: 'Bug Fix',
        tracker: 'bug',
      });

      expect(mockClient.createIssue).toHaveBeenCalledWith(
        { project_id: 'test-project', subject: 'Bug Fix', tracker_id: 1 },
        undefined
      );
    });

    it('resolves assigned_to username to user ID', async () => {
      mockClient.createIssue.mockResolvedValue({ id: 1 });
      mockClient.resolveUser.mockResolvedValue(42);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      await handler!({
        project_id: 'test-project',
        subject: 'Assigned Issue',
        assigned_to: 'john.doe',
      });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('john.doe');
      expect(mockClient.createIssue).toHaveBeenCalledWith(
        { project_id: 'test-project', subject: 'Assigned Issue', assigned_to_id: 42 },
        undefined
      );
    });

    it('returns a teaching error instead of silently creating an unassigned issue', async () => {
      mockClient.resolveUser.mockResolvedValue(null);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      const result = await handler!({
        project_id: 'test-project',
        subject: 'Assigned Issue',
        assigned_to: 'nonexistent',
      });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('nonexistent');
      expect(mockClient.createIssue).not.toHaveBeenCalled();
      expect(result).toMatchObject({ isError: true });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      expect(text).toContain('nonexistent');
      expect(text).toContain('Get a valid value from resolveUser.');
    });

    it('names the fixed_version_id it sent when Redmine rejects the new issue', async () => {
      const formatErrorSpy = vi.spyOn(RedmineClient, 'formatError');
      formatErrorSpy.mockClear();
      mockClient.createIssue.mockRejectedValue(new Error('422'));

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')!.handler;

      await handler({ project_id: 'p', subject: 's', fixed_version_id: 87 });
      await handler({ project_id: 'p', subject: 's' });

      expect(formatErrorSpy).toHaveBeenNthCalledWith(1, expect.any(Error), {
        fixed_version_id: 87,
      });
      expect(formatErrorSpy).toHaveBeenNthCalledWith(2, expect.any(Error), undefined);
    });

    it('resolves multiple mappings', async () => {
      mockClient.createIssue.mockResolvedValue({ id: 1 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      await handler!({
        project_id: 'test-project',
        subject: 'Complex Issue',
        tracker: 'feature',
        priority: 'high',
        status: 'in_progress',
      });

      expect(mockClient.createIssue).toHaveBeenCalledWith(
        {
          project_id: 'test-project',
          subject: 'Complex Issue',
          tracker_id: 2,
          priority_id: 3,
          status_id: 2,
        },
        undefined
      );
    });

    it('handles creation errors', async () => {
      mockClient.createIssue.mockRejectedValue(
        new Error('Validation error: {"subject":["cannot be blank"]}')
      );

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      const result = await handler!({
        project_id: 'test-project',
        subject: 'Subject',
      });

      expect(result).toEqual({
        content: [
          { type: 'text', text: 'Error: Validation error: {"subject":["cannot be blank"]}' },
        ],
        isError: true,
      });
    });
  });

  describe('updateIssue', () => {
    it('updates issue successfully', async () => {
      const mockUpdatedIssue = {
        id: 1,
        subject: 'Updated Subject',
        status: { id: 2, name: 'In Progress' },
        priority: { id: 2, name: 'Normal' },
        tracker: { id: 1, name: 'Bug' },
        project: { id: 1, name: 'Test Project' },
        author: { id: 1, name: 'Test User' },
        created_on: '2025-01-01T00:00:00Z',
        updated_on: '2025-01-02T00:00:00Z',
      };

      mockClient.updateIssue.mockResolvedValue(mockUpdatedIssue);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      const result = await handler!({
        issue_id: 1,
        subject: 'Updated Subject',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...mockUpdatedIssue, ignored_fields: [] }, null, 2),
          },
        ],
      });
      expect(mockClient.updateIssue).toHaveBeenCalledWith(1, { subject: 'Updated Subject' });
    });

    it('returns the whole issue as it holds after the update', async () => {
      mockClient.updateIssue.mockResolvedValue({
        id: 83432,
        subject: 'Plan me',
        project: { id: 1972, name: 'Auditor' },
        tracker: { id: 2, name: 'Feature' },
        status: { id: 1, name: 'New' },
        priority: { id: 3, name: 'High' },
        author: { id: 7, name: 'Ala' },
        assigned_to: { id: 1454, name: 'Kacper' },
        fixed_version: { id: 87, name: 'Week 10' },
        parent: { id: 83000 },
        estimated_hours: 4,
        description: 'kept in the result',
        done_ratio: 50,
        custom_fields: [{ id: 1, name: 'Version', value: '2.4' }],
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const tool = tools.find((t) => t.tool.name === 'updateIssue')!;

      const result = await tool.handler({ issue_id: 83432, fixed_version_id: 87 });

      const emitted = expectEmittedKeysDeclared(tool.tool, result);
      expect(emitted).toMatchObject({
        id: 83432,
        author: { id: 7, name: 'Ala' },
        description: 'kept in the result',
        done_ratio: 50,
        custom_fields: [{ id: 1, name: 'Version', value: '2.4' }],
        ignored_fields: [],
      });
      expect(emitted).not.toHaveProperty('message');
      expect(mockClient.updateIssue).toHaveBeenCalledWith(83432, { fixed_version_id: 87 });
    });

    it('names the fixed_version_id it sent when Redmine rejects the update', async () => {
      const formatErrorSpy = vi.spyOn(RedmineClient, 'formatError');
      formatErrorSpy.mockClear();
      mockClient.updateIssue.mockRejectedValue(new Error('422'));

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')!.handler;

      await handler({ issue_id: 5, fixed_version_id: 87 });

      expect(formatErrorSpy).toHaveBeenCalledWith(expect.any(Error), {
        issue_id: 5,
        fixed_version_id: 87,
      });
    });

    it('resolves tracker and priority names the schema declares', async () => {
      mockClient.updateIssue.mockResolvedValue({ id: 5, subject: 's', status: { id: 1 } });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')!.handler;

      await handler({ issue_id: 5, tracker: 'feature', priority: 'high' });

      expect(mockClient.updateIssue).toHaveBeenCalledWith(5, { tracker_id: 2, priority_id: 3 });
    });

    it('updates status using name mapping', async () => {
      mockClient.updateIssue.mockResolvedValue({
        id: 1,
        subject: 'Test',
        status: { id: 3, name: 'Resolved' },
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      await handler!({
        issue_id: 1,
        status: 'resolved',
      });

      expect(mockClient.updateIssue).toHaveBeenCalledWith(1, { status_id: 3 });
    });

    it('resolves assigned_to username', async () => {
      mockClient.updateIssue.mockResolvedValue({
        id: 1,
        subject: 'Test',
        status: { id: 1, name: 'New' },
      });
      mockClient.resolveUser.mockResolvedValue(99);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      await handler!({
        issue_id: 1,
        assigned_to: 'jane.doe',
      });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('jane.doe');
      expect(mockClient.updateIssue).toHaveBeenCalledWith(1, { assigned_to_id: 99 });
    });

    it('returns a teaching error instead of silently no-oping the reassignment', async () => {
      mockClient.resolveUser.mockResolvedValue(null);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      const result = await handler!({
        issue_id: 1,
        assigned_to: 'nonexistent',
      });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('nonexistent');
      expect(mockClient.updateIssue).not.toHaveBeenCalled();
      expect(result).toMatchObject({ isError: true });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      expect(text).toContain('nonexistent');
      expect(text).toContain('Get a valid value from resolveUser.');
    });

    it('handles non-existent issue', async () => {
      mockClient.updateIssue.mockRejectedValue(new Error('Resource not found in Redmine.'));

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      const result = await handler!({
        issue_id: 9999,
        subject: 'Updated',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in Redmine.' }],
        isError: true,
      });
    });

    it('passes issue_id as formatError context on failure', async () => {
      mockClient.updateIssue.mockRejectedValue(new Error('Not found'));
      const formatErrorSpy = vi.spyOn(RedmineClient, 'formatError');

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      await handler!({ issue_id: 9999, subject: 'Updated' });

      expect(formatErrorSpy).toHaveBeenCalledWith(expect.any(Error), { issue_id: 9999 });
    });
  });

  describe('write rules from the issue field table', () => {
    const toolOf = (name: string) =>
      createIssueTools(mockClient as unknown as RedmineClient).find((t) => t.tool.name === name)!;
    const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
    const issueAfter = {
      id: 1,
      subject: 'A',
      project: { id: 1, name: 'P' },
      done_ratio: 20,
      start_date: '2026-11-24',
      custom_fields: [{ id: 1, name: 'Version', value: '2.4' }],
      watchers: [{ id: 1739, name: 'W' }],
    };

    it('creates an issue with the new fields and returns it with empty ignored_fields', async () => {
      mockClient.createIssue.mockResolvedValue(issueAfter);
      const tool = toolOf('createIssue');

      const result = await tool.handler({
        project_id: 'x',
        subject: 'A',
        done_ratio: 20,
        start_date: '2026-11-24',
        custom_fields: [{ id: 1, value: '2.4' }],
        watcher_user_ids: [1739],
      });

      const emitted = expectEmittedKeysDeclared(tool.tool, result);
      expect(emitted).toEqual({ ...issueAfter, ignored_fields: [] });
      expect(mockClient.createIssue).toHaveBeenCalledWith(
        {
          project_id: 'x',
          subject: 'A',
          done_ratio: 20,
          start_date: '2026-11-24',
          custom_fields: [{ id: 1, value: '2.4' }],
          watcher_user_ids: [1739],
        },
        undefined
      );
    });

    it.each([
      ['createIssue', { project_id: 'x', subject: '' }, 'Invalid subject.'],
      ['updateIssue', { issue_id: 1, subject: null }, 'Invalid subject.'],
    ])(
      '%s rejects an invalid value naming the field and the tool',
      async (name, params, expected) => {
        const result = await toolOf(name).handler(params);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(expected);
        expect(textOf(result)).toContain(`${name} rejected the call and sent nothing`);
      }
    );

    it.each([
      ['createIssue', { project_id: 'x', subject: 'A', assigned_to: 'jane', done_ratio: 'many' }],
      ['updateIssue', { issue_id: 1, assigned_to: 'jane', subject: '' }],
    ])(
      '%s makes no client call for a rejected value even when a name needs resolving',
      async (name, params) => {
        const result = await toolOf(name).handler(params);

        expect(result.isError).toBe(true);
        expect(mockClient.resolveUser).not.toHaveBeenCalled();
        expect(mockClient.createIssue).not.toHaveBeenCalled();
        expect(mockClient.updateIssue).not.toHaveBeenCalled();
      }
    );

    it('resolves a name after validation and sends its ID with the table fields', async () => {
      mockClient.updateIssue.mockResolvedValue(issueAfter);
      mockClient.resolveUser.mockResolvedValue(42);

      await toolOf('updateIssue').handler({
        issue_id: 1,
        assigned_to: 'jane',
        tracker: 'feature',
        due_date: '2026-12-01',
      });

      expect(mockClient.updateIssue).toHaveBeenCalledWith(1, {
        due_date: '2026-12-01',
        assigned_to_id: 42,
        tracker_id: 2,
      });
    });

    it('gives a custom field that did not apply its own reason in the message', async () => {
      mockClient.updateIssue.mockResolvedValue({ ...issueAfter, done_ratio: 20 });

      const result = await toolOf('updateIssue').handler({
        issue_id: 1,
        done_ratio: 50,
        custom_fields: [{ id: 9, value: 'x' }],
      });

      const emitted = JSON.parse(textOf(result));
      expect(emitted.ignored_fields).toEqual(['done_ratio', 'custom_fields.9']);
      expect(emitted.message).toContain('Redmine did not apply done_ratio: no permission');
      expect(emitted.message).toContain(
        'Redmine did not apply custom_fields.9: the custom field is not enabled for this project or tracker, or the user may not edit it.'
      );
    });

    it('updates dates and progress and returns the whole issue after the write', async () => {
      mockClient.updateIssue.mockResolvedValue({
        ...issueAfter,
        due_date: '2026-12-01',
        done_ratio: 50,
      });
      const tool = toolOf('updateIssue');

      const result = await tool.handler({ issue_id: 1, due_date: '2026-12-01', done_ratio: 50 });

      const emitted = expectEmittedKeysDeclared(tool.tool, result);
      expect(emitted).toEqual({
        ...issueAfter,
        due_date: '2026-12-01',
        done_ratio: 50,
        ignored_fields: [],
      });
      expect(mockClient.updateIssue).toHaveBeenCalledWith(1, {
        due_date: '2026-12-01',
        done_ratio: 50,
      });
    });

    it('lists done_ratio as ignored with a message when Redmine derives progress from status', async () => {
      mockClient.updateIssue.mockResolvedValue({ ...issueAfter, done_ratio: 20 });
      const tool = toolOf('updateIssue');

      const result = await tool.handler({ issue_id: 1, done_ratio: 50 });

      const emitted = expectEmittedKeysDeclared(tool.tool, result);
      expect(emitted.ignored_fields).toEqual(['done_ratio']);
      expect(emitted.message).toBe(
        'Redmine did not apply done_ratio: no permission, the field is disabled for the tracker, or it is derived from status or subtasks.'
      );
    });
  });

  describe('listIssueIds filters from the issue field table', () => {
    it('passes the date, progress, privacy, watcher and custom field filters to the client', async () => {
      mockClient.listIssues.mockResolvedValue({
        issues: [{ id: 101 }, { id: 107 }],
        total_count: 2,
      });
      const handler = createIssueTools(mockClient as unknown as RedmineClient).find(
        (t) => t.tool.name === 'listIssueIds'
      )!.handler;

      const result = await handler({
        project_id: 'x',
        due_date: '<=2026-11-30',
        done_ratio: '<=99',
        start_date: '><2026-11-01|2026-11-30',
        is_private: '0',
        watcher_id: 'me',
        cf: { '1': '2.4' },
      });

      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
        ids: [101, 107],
        total_count: 2,
      });
      expect(mockClient.listIssues).toHaveBeenCalledWith({
        project_id: 'x',
        due_date: '<=2026-11-30',
        done_ratio: '<=99',
        start_date: '><2026-11-01|2026-11-30',
        is_private: '0',
        watcher_id: 'me',
        cf: { '1': '2.4' },
      });
    });

    it('rejects an invalid cf naming it and sends nothing', async () => {
      const handler = createIssueTools(mockClient as unknown as RedmineClient).find(
        (t) => t.tool.name === 'listIssueIds'
      )!.handler;

      const result = await handler({ cf: { abc: 'x' }, assigned_to: 'jane' });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('Invalid cf.');
      expect(mockClient.resolveUser).not.toHaveBeenCalled();
      expect(mockClient.listIssues).not.toHaveBeenCalled();
    });
  });

  describe('commentIssue', () => {
    it('adds comment successfully', async () => {
      mockClient.commentIssue.mockResolvedValue(undefined);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'commentIssue')?.handler;

      const result = await handler!({
        issue_id: 1,
        notes: 'This is a comment',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true }, null, 2),
          },
        ],
      });
      expect(mockClient.commentIssue).toHaveBeenCalledWith(1, 'This is a comment');
    });

    it('handles comment errors', async () => {
      mockClient.commentIssue.mockRejectedValue(new Error('Permission denied'));

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'commentIssue')?.handler;

      const result = await handler!({
        issue_id: 1,
        notes: 'Comment',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Permission denied' }],
        isError: true,
      });
    });

    it('passes issue_id as formatError context on failure', async () => {
      mockClient.commentIssue.mockRejectedValue(new Error('Not found'));
      const formatErrorSpy = vi.spyOn(RedmineClient, 'formatError');

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'commentIssue')?.handler;

      await handler!({ issue_id: 1, notes: 'Comment' });

      expect(formatErrorSpy).toHaveBeenCalledWith(expect.any(Error), { issue_id: 1 });
    });
  });

  describe('unconfigured client', () => {
    it('returns error for all tools when client is null', async () => {
      const tools = createIssueTools(null);

      expect(tools).toHaveLength(6);

      for (const { tool, handler } of tools) {
        const result = await handler({});
        expect(result).toEqual({
          content: [
            {
              type: 'text',
              text: `Error: ${notConfiguredMessage('Redmine')}`,
            },
          ],
          isError: true,
        });
      }
    });
  });

  describe('ProjectScopeError propagation', () => {
    it('should surface ProjectScopeError for listIssueIds', async () => {
      const scopeError = new ProjectScopeError('my-project', 'other-project');
      mockClient.listIssues.mockRejectedValue(scopeError);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const tool = tools.find((t) => t.tool.name === 'listIssueIds');
      const result = await tool!.handler({});

      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: "Error: Project scope violation: configured project is 'my-project', but requested resource belongs to 'other-project'",
          },
        ],
      });
    });

    it('should surface ProjectScopeError for getIssueFull', async () => {
      const scopeError = new ProjectScopeError('my-project', 'other-project');
      mockClient.showIssue.mockRejectedValue(scopeError);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const tool = tools.find((t) => t.tool.name === 'getIssueFull');
      const result = await tool!.handler({ issue_id: 1 });

      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: "Error: Project scope violation: configured project is 'my-project', but requested resource belongs to 'other-project'",
          },
        ],
      });
    });

    it('should surface ProjectScopeError for searchIssueIds', async () => {
      const scopeError = new ProjectScopeError('my-project', 'other-project');
      mockClient.searchIssues.mockRejectedValue(scopeError);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const tool = tools.find((t) => t.tool.name === 'searchIssueIds');
      const result = await tool!.handler({ query: 'test' });

      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: "Error: Project scope violation: configured project is 'my-project', but requested resource belongs to 'other-project'",
          },
        ],
      });
    });

    it('should surface ProjectScopeError for createIssue', async () => {
      const scopeError = new ProjectScopeError('my-project', 'other-project');
      mockClient.createIssue.mockRejectedValue(scopeError);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const tool = tools.find((t) => t.tool.name === 'createIssue');
      const result = await tool!.handler({ project_id: 'other-project', subject: 'Test' });

      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: "Error: Project scope violation: configured project is 'my-project', but requested resource belongs to 'other-project'",
          },
        ],
      });
    });

    it('should surface ProjectScopeError for updateIssue', async () => {
      const scopeError = new ProjectScopeError('my-project', 'other-project');
      mockClient.updateIssue.mockRejectedValue(scopeError);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const tool = tools.find((t) => t.tool.name === 'updateIssue');
      const result = await tool!.handler({ issue_id: 1, subject: 'Updated' });

      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: "Error: Project scope violation: configured project is 'my-project', but requested resource belongs to 'other-project'",
          },
        ],
      });
    });

    it('should surface ProjectScopeError for commentIssue', async () => {
      const scopeError = new ProjectScopeError('my-project', 'other-project');
      mockClient.commentIssue.mockRejectedValue(scopeError);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const tool = tools.find((t) => t.tool.name === 'commentIssue');
      const result = await tool!.handler({ issue_id: 1, notes: 'A comment' });

      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: "Error: Project scope violation: configured project is 'my-project', but requested resource belongs to 'other-project'",
          },
        ],
      });
    });
  });
});
