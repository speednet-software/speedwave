import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { createJournalTools } from './journal-tools.js';
import { ProjectScopeError } from '../client.js';
import type { RedmineClient } from '../client.js';

type MockClient = {
  listJournals: Mock;
  updateJournal: Mock;
  deleteJournal: Mock;
};

const createMockClient = (): MockClient => ({
  listJournals: vi.fn(),
  updateJournal: vi.fn(),
  deleteJournal: vi.fn(),
});

describe('journal-tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  describe('listJournals', () => {
    it('lists journals successfully', async () => {
      const mockJournals = [
        {
          id: 1,
          user: { id: 1, name: 'John Doe' },
          notes: 'First comment',
          created_on: '2025-01-15T10:00:00Z',
          private_notes: false,
          details: [],
        },
        {
          id: 2,
          user: { id: 2, name: 'Jane Smith' },
          notes: 'Second comment',
          created_on: '2025-01-16T11:00:00Z',
          private_notes: false,
          details: [
            {
              property: 'attr',
              name: 'status_id',
              old_value: '1',
              new_value: '2',
            },
          ],
        },
      ];

      mockClient.listJournals.mockResolvedValue(mockJournals);

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listJournals')?.handler;

      const result = await handler!({ issue_id: 10 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockJournals, null, 2),
          },
        ],
      });
      expect(mockClient.listJournals).toHaveBeenCalledWith(10);
    });

    it('handles empty journal list', async () => {
      mockClient.listJournals.mockResolvedValue([]);

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listJournals')?.handler;

      const result = await handler!({ issue_id: 10 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify([], null, 2),
          },
        ],
      });
    });

    it('handles journals with change details only (no notes)', async () => {
      const mockJournals = [
        {
          id: 1,
          user: { id: 1, name: 'John Doe' },
          created_on: '2025-01-15T10:00:00Z',
          private_notes: false,
          details: [
            {
              property: 'attr',
              name: 'assigned_to_id',
              old_value: '1',
              new_value: '2',
            },
          ],
        },
      ];

      mockClient.listJournals.mockResolvedValue(mockJournals);

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listJournals')?.handler;

      const result = await handler!({ issue_id: 10 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockJournals, null, 2),
          },
        ],
      });
    });

    it('handles private notes', async () => {
      const mockJournals = [
        {
          id: 1,
          user: { id: 1, name: 'Admin' },
          notes: 'Private internal note',
          created_on: '2025-01-15T10:00:00Z',
          private_notes: true,
          details: [],
        },
      ];

      mockClient.listJournals.mockResolvedValue(mockJournals);

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listJournals')?.handler;

      const result = await handler!({ issue_id: 10 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockJournals, null, 2),
          },
        ],
      });
    });

    it('handles non-existent issue', async () => {
      mockClient.listJournals.mockRejectedValue(new Error('Resource not found in Redmine.'));

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listJournals')?.handler;

      const result = await handler!({ issue_id: 9999 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in Redmine.' }],
        isError: true,
      });
    });

    it('handles API errors', async () => {
      mockClient.listJournals.mockRejectedValue(new Error('Network error'));

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listJournals')?.handler;

      const result = await handler!({ issue_id: 10 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Network error' }],
        isError: true,
      });
    });
  });

  describe('updateJournal', () => {
    it('updates journal successfully', async () => {
      mockClient.updateJournal.mockResolvedValue(undefined);

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateJournal')?.handler;

      const result = await handler!({
        issue_id: 10,
        journal_id: 5,
        notes: 'Updated comment text',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true }, null, 2),
          },
        ],
      });
      expect(mockClient.updateJournal).toHaveBeenCalledWith(10, 5, 'Updated comment text');
    });

    it('updates journal with empty notes', async () => {
      mockClient.updateJournal.mockResolvedValue(undefined);

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateJournal')?.handler;

      await handler!({
        issue_id: 10,
        journal_id: 5,
        notes: '',
      });

      expect(mockClient.updateJournal).toHaveBeenCalledWith(10, 5, '');
    });

    it('updates journal with special characters', async () => {
      mockClient.updateJournal.mockResolvedValue(undefined);

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateJournal')?.handler;

      const specialNotes = 'Updated with *bold*, _italic_, and @mentions';

      await handler!({
        issue_id: 10,
        journal_id: 5,
        notes: specialNotes,
      });

      expect(mockClient.updateJournal).toHaveBeenCalledWith(10, 5, specialNotes);
    });

    it('handles non-existent journal', async () => {
      mockClient.updateJournal.mockRejectedValue(new Error('Resource not found in Redmine.'));

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateJournal')?.handler;

      const result = await handler!({
        issue_id: 10,
        journal_id: 9999,
        notes: 'Updated',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in Redmine.' }],
        isError: true,
      });
    });

    it('handles permission errors', async () => {
      mockClient.updateJournal.mockRejectedValue(
        new Error('Permission denied. Your Redmine API key may not have sufficient permissions.')
      );

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateJournal')?.handler;

      const result = await handler!({
        issue_id: 10,
        journal_id: 5,
        notes: 'Updated',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: Permission denied. Your Redmine API key may not have sufficient permissions.',
          },
        ],
        isError: true,
      });
    });

    it('handles validation errors', async () => {
      mockClient.updateJournal.mockRejectedValue(
        new Error('Validation error: Cannot edit journals from other users')
      );

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateJournal')?.handler;

      const result = await handler!({
        issue_id: 10,
        journal_id: 5,
        notes: 'Updated',
      });

      expect(result).toEqual({
        content: [
          { type: 'text', text: 'Error: Validation error: Cannot edit journals from other users' },
        ],
        isError: true,
      });
    });
  });

  describe('deleteJournal', () => {
    it('deletes journal successfully', async () => {
      mockClient.deleteJournal.mockResolvedValue(undefined);

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'deleteJournal')?.handler;

      const result = await handler!({
        issue_id: 10,
        journal_id: 5,
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true }, null, 2),
          },
        ],
      });
      expect(mockClient.deleteJournal).toHaveBeenCalledWith(10, 5);
    });

    it('handles non-existent journal', async () => {
      mockClient.deleteJournal.mockRejectedValue(new Error('Resource not found in Redmine.'));

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'deleteJournal')?.handler;

      const result = await handler!({
        issue_id: 10,
        journal_id: 9999,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in Redmine.' }],
        isError: true,
      });
    });

    it('handles non-existent issue', async () => {
      mockClient.deleteJournal.mockRejectedValue(new Error('Resource not found in Redmine.'));

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'deleteJournal')?.handler;

      const result = await handler!({
        issue_id: 9999,
        journal_id: 5,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in Redmine.' }],
        isError: true,
      });
    });

    it('handles permission errors', async () => {
      mockClient.deleteJournal.mockRejectedValue(
        new Error('Permission denied. Your Redmine API key may not have sufficient permissions.')
      );

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'deleteJournal')?.handler;

      const result = await handler!({
        issue_id: 10,
        journal_id: 5,
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: Permission denied. Your Redmine API key may not have sufficient permissions.',
          },
        ],
        isError: true,
      });
    });

    it('handles network errors', async () => {
      mockClient.deleteJournal.mockRejectedValue(
        new Error('Network error. Check your Redmine URL.')
      );

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'deleteJournal')?.handler;

      const result = await handler!({
        issue_id: 10,
        journal_id: 5,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Network error. Check your Redmine URL.' }],
        isError: true,
      });
    });

    it('validates required parameters', async () => {
      mockClient.deleteJournal.mockResolvedValue(undefined);

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'deleteJournal')?.handler;

      await handler!({
        issue_id: 10,
        journal_id: 5,
      });

      expect(mockClient.deleteJournal).toHaveBeenCalledWith(10, 5);
    });
  });

  describe('unconfigured client', () => {
    it('returns error for all tools when client is null', async () => {
      const tools = createJournalTools(null);

      expect(tools).toHaveLength(3);

      for (const { tool, handler } of tools) {
        const result = await handler({});
        expect(result).toEqual({
          content: [
            { type: 'text', text: 'Error: Redmine not configured. Run: speedwave setup redmine' },
          ],
          isError: true,
        });
      }
    });

    it('list_journals returns error when unconfigured', async () => {
      const tools = createJournalTools(null);
      const handler = tools.find((t) => t.tool.name === 'listJournals')?.handler;

      const result = await handler!({ issue_id: 10 });

      expect(result).toEqual({
        content: [
          { type: 'text', text: 'Error: Redmine not configured. Run: speedwave setup redmine' },
        ],
        isError: true,
      });
    });

    it('update_journal returns error when unconfigured', async () => {
      const tools = createJournalTools(null);
      const handler = tools.find((t) => t.tool.name === 'updateJournal')?.handler;

      const result = await handler!({
        issue_id: 10,
        journal_id: 5,
        notes: 'Test',
      });

      expect(result).toEqual({
        content: [
          { type: 'text', text: 'Error: Redmine not configured. Run: speedwave setup redmine' },
        ],
        isError: true,
      });
    });

    it('delete_journal returns error when unconfigured', async () => {
      const tools = createJournalTools(null);
      const handler = tools.find((t) => t.tool.name === 'deleteJournal')?.handler;

      const result = await handler!({
        issue_id: 10,
        journal_id: 5,
      });

      expect(result).toEqual({
        content: [
          { type: 'text', text: 'Error: Redmine not configured. Run: speedwave setup redmine' },
        ],
        isError: true,
      });
    });
  });

  describe('ProjectScopeError propagation', () => {
    it('should surface ProjectScopeError for updateJournal', async () => {
      const scopeError = new ProjectScopeError('my-project', 'other-project');
      mockClient.updateJournal.mockRejectedValue(scopeError);

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const tool = tools.find((t) => t.tool.name === 'updateJournal');
      const result = await tool!.handler({ issue_id: 10, journal_id: 5, notes: 'Updated' });

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

    it('should surface ProjectScopeError for deleteJournal', async () => {
      const scopeError = new ProjectScopeError('my-project', 'other-project');
      mockClient.deleteJournal.mockRejectedValue(scopeError);

      const tools = createJournalTools(mockClient as unknown as RedmineClient);
      const tool = tools.find((t) => t.tool.name === 'deleteJournal');
      const result = await tool!.handler({ issue_id: 10, journal_id: 5 });

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
