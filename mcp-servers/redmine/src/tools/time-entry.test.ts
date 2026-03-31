import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage } from '@speedwave/mcp-shared';
import { createTimeEntryTools } from './time-entry-tools.js';
import type { RedmineClient } from '../client.js';

type MockClient = {
  listTimeEntries: Mock;
  createTimeEntry: Mock;
  updateTimeEntry: Mock;
  getMappings: Mock;
};

const createMockClient = (): MockClient => ({
  listTimeEntries: vi.fn(),
  createTimeEntry: vi.fn(),
  updateTimeEntry: vi.fn(),
  getMappings: vi.fn(),
});

describe('time-entry-tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    mockClient.getMappings.mockReturnValue({
      activity_development: 1,
      activity_testing: 2,
      activity_documentation: 3,
    });
  });

  describe('listTimeEntries', () => {
    it('lists time entries successfully', async () => {
      const mockTimeEntries = [
        {
          id: 1,
          hours: 2.5,
          spent_on: '2025-01-15',
          activity: { id: 1, name: 'Development' },
          user: { id: 1, name: 'John Doe' },
          project: { id: 1, name: 'Test Project' },
          comments: 'Working on feature',
          created_on: '2025-01-15T10:00:00Z',
          updated_on: '2025-01-15T10:00:00Z',
        },
        {
          id: 2,
          hours: 1.0,
          spent_on: '2025-01-16',
          activity: { id: 2, name: 'Testing' },
          user: { id: 1, name: 'John Doe' },
          project: { id: 1, name: 'Test Project' },
          issue: { id: 10 },
          created_on: '2025-01-16T14:00:00Z',
          updated_on: '2025-01-16T14:00:00Z',
        },
      ];

      mockClient.listTimeEntries.mockResolvedValue({
        time_entries: mockTimeEntries,
        total_count: 2,
      });

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listTimeEntries')?.handler;

      const result = await handler!({});

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ time_entries: mockTimeEntries, total_count: 2 }, null, 2),
          },
        ],
      });
      expect(mockClient.listTimeEntries).toHaveBeenCalledWith({});
    });

    it('filters by issue_id', async () => {
      mockClient.listTimeEntries.mockResolvedValue({
        time_entries: [],
        total_count: 0,
      });

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listTimeEntries')?.handler;

      await handler!({ issue_id: 123 });

      expect(mockClient.listTimeEntries).toHaveBeenCalledWith({
        issue_id: 123,
      });
    });

    it('filters by project_id', async () => {
      mockClient.listTimeEntries.mockResolvedValue({
        time_entries: [],
        total_count: 0,
      });

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listTimeEntries')?.handler;

      await handler!({ project_id: 'my-project' });

      expect(mockClient.listTimeEntries).toHaveBeenCalledWith({
        project_id: 'my-project',
      });
    });

    it('filters by date range', async () => {
      mockClient.listTimeEntries.mockResolvedValue({
        time_entries: [],
        total_count: 0,
      });

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listTimeEntries')?.handler;

      await handler!({
        from: '2025-01-01',
        to: '2025-01-31',
      });

      expect(mockClient.listTimeEntries).toHaveBeenCalledWith({
        from: '2025-01-01',
        to: '2025-01-31',
      });
    });

    it('filters by user_id and limit', async () => {
      mockClient.listTimeEntries.mockResolvedValue({
        time_entries: [],
        total_count: 0,
      });

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listTimeEntries')?.handler;

      await handler!({
        user_id: 5,
        limit: 50,
      });

      expect(mockClient.listTimeEntries).toHaveBeenCalledWith({
        user_id: 5,
        limit: 50,
      });
    });

    it('handles API errors', async () => {
      mockClient.listTimeEntries.mockRejectedValue(new Error('Network error'));

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listTimeEntries')?.handler;

      const result = await handler!({});

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Network error' }],
        isError: true,
      });
    });

    it('handles empty results', async () => {
      mockClient.listTimeEntries.mockResolvedValue({
        time_entries: [],
        total_count: 0,
      });

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listTimeEntries')?.handler;

      const result = await handler!({});

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ time_entries: [], total_count: 0 }, null, 2),
          },
        ],
      });
    });
  });

  describe('createTimeEntry', () => {
    it('creates time entry successfully with issue_id', async () => {
      const mockCreatedEntry = {
        id: 1,
        hours: 3.5,
        spent_on: '2025-01-15',
        activity: { id: 1, name: 'Development' },
        user: { id: 1, name: 'John Doe' },
        project: { id: 1, name: 'Test Project' },
        issue: { id: 10 },
        comments: 'Implemented feature X',
        created_on: '2025-01-15T10:00:00Z',
        updated_on: '2025-01-15T10:00:00Z',
      };

      mockClient.createTimeEntry.mockResolvedValue(mockCreatedEntry);

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createTimeEntry')?.handler;

      const result = await handler!({
        issue_id: 10,
        hours: 3.5,
        comments: 'Implemented feature X',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockCreatedEntry, null, 2),
          },
        ],
      });
      expect(mockClient.createTimeEntry).toHaveBeenCalledWith({
        issue_id: 10,
        hours: 3.5,
        comments: 'Implemented feature X',
      });
    });

    it('creates time entry with project_id', async () => {
      const mockCreatedEntry = {
        id: 2,
        hours: 2.0,
        spent_on: '2025-01-16',
        activity: { id: 1, name: 'Development' },
        user: { id: 1, name: 'John Doe' },
        project: { id: 1, name: 'Test Project' },
        created_on: '2025-01-16T10:00:00Z',
        updated_on: '2025-01-16T10:00:00Z',
      };

      mockClient.createTimeEntry.mockResolvedValue(mockCreatedEntry);

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createTimeEntry')?.handler;

      await handler!({
        project_id: 'my-project',
        hours: 2.0,
      });

      expect(mockClient.createTimeEntry).toHaveBeenCalledWith({
        project_id: 'my-project',
        hours: 2.0,
      });
    });

    it('resolves activity name to activity_id', async () => {
      mockClient.createTimeEntry.mockResolvedValue({ id: 1 });

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createTimeEntry')?.handler;

      await handler!({
        issue_id: 10,
        hours: 1.5,
        activity: 'development',
      });

      expect(mockClient.createTimeEntry).toHaveBeenCalledWith({
        issue_id: 10,
        hours: 1.5,
        activity_id: 1,
      });
    });

    it('creates time entry with custom spent_on date', async () => {
      mockClient.createTimeEntry.mockResolvedValue({ id: 1 });

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createTimeEntry')?.handler;

      await handler!({
        issue_id: 10,
        hours: 4.0,
        spent_on: '2025-01-10',
      });

      expect(mockClient.createTimeEntry).toHaveBeenCalledWith({
        issue_id: 10,
        hours: 4.0,
        spent_on: '2025-01-10',
      });
    });

    it('handles all parameters together', async () => {
      mockClient.createTimeEntry.mockResolvedValue({ id: 1 });

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createTimeEntry')?.handler;

      await handler!({
        issue_id: 10,
        hours: 2.5,
        activity: 'testing',
        comments: 'QA testing',
        spent_on: '2025-01-15',
      });

      expect(mockClient.createTimeEntry).toHaveBeenCalledWith({
        issue_id: 10,
        hours: 2.5,
        activity_id: 2,
        comments: 'QA testing',
        spent_on: '2025-01-15',
      });
    });

    it('handles creation errors', async () => {
      mockClient.createTimeEntry.mockRejectedValue(
        new Error('Validation error: {"hours":["must be greater than 0"]}')
      );

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createTimeEntry')?.handler;

      const result = await handler!({
        issue_id: 10,
        hours: 0,
      });

      expect(result).toEqual({
        content: [
          { type: 'text', text: 'Error: Validation error: {"hours":["must be greater than 0"]}' },
        ],
        isError: true,
      });
    });

    it('handles negative hours', async () => {
      mockClient.createTimeEntry.mockRejectedValue(
        new Error('Validation error: hours must be positive')
      );

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createTimeEntry')?.handler;

      const result = await handler!({
        issue_id: 10,
        hours: -1.5,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Validation error: hours must be positive' }],
        isError: true,
      });
    });
  });

  describe('updateTimeEntry', () => {
    it('updates time entry successfully', async () => {
      mockClient.updateTimeEntry.mockResolvedValue(undefined);

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateTimeEntry')?.handler;

      const result = await handler!({
        time_entry_id: 1,
        hours: 4.0,
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true }, null, 2),
          },
        ],
      });
      expect(mockClient.updateTimeEntry).toHaveBeenCalledWith(1, {
        time_entry_id: 1,
        hours: 4.0,
      });
    });

    it('updates activity using name mapping', async () => {
      mockClient.updateTimeEntry.mockResolvedValue(undefined);

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateTimeEntry')?.handler;

      await handler!({
        time_entry_id: 1,
        activity: 'documentation',
      });

      expect(mockClient.updateTimeEntry).toHaveBeenCalledWith(1, {
        time_entry_id: 1,
        activity_id: 3,
      });
    });

    it('updates comments', async () => {
      mockClient.updateTimeEntry.mockResolvedValue(undefined);

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateTimeEntry')?.handler;

      await handler!({
        time_entry_id: 1,
        comments: 'Updated comment',
      });

      expect(mockClient.updateTimeEntry).toHaveBeenCalledWith(1, {
        time_entry_id: 1,
        comments: 'Updated comment',
      });
    });

    it('updates multiple fields at once', async () => {
      mockClient.updateTimeEntry.mockResolvedValue(undefined);

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateTimeEntry')?.handler;

      await handler!({
        time_entry_id: 1,
        hours: 3.5,
        activity: 'testing',
        comments: 'Fixed tests',
      });

      expect(mockClient.updateTimeEntry).toHaveBeenCalledWith(1, {
        time_entry_id: 1,
        hours: 3.5,
        activity_id: 2,
        comments: 'Fixed tests',
      });
    });

    it('handles non-existent time entry', async () => {
      mockClient.updateTimeEntry.mockRejectedValue(new Error('Resource not found in Redmine.'));

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateTimeEntry')?.handler;

      const result = await handler!({
        time_entry_id: 9999,
        hours: 2.0,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in Redmine.' }],
        isError: true,
      });
    });

    it('handles permission errors', async () => {
      mockClient.updateTimeEntry.mockRejectedValue(new Error('Permission denied'));

      const tools = createTimeEntryTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateTimeEntry')?.handler;

      const result = await handler!({
        time_entry_id: 1,
        hours: 2.0,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Permission denied' }],
        isError: true,
      });
    });
  });

  describe('unconfigured client', () => {
    it('returns error for all tools when client is null', async () => {
      const tools = createTimeEntryTools(null);

      expect(tools).toHaveLength(3);

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
});
