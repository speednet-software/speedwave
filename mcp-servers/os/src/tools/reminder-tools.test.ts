/**
 * Reminder Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleListReminderLists,
  handleListReminders,
  handleGetReminder,
  handleCreateReminder,
  handleCompleteReminder,
  createReminderTools,
} from './reminder-tools.js';

// Mock the platform runner
vi.mock('../platform-runner.js', () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from '../platform-runner.js';

describe('reminder-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleListReminderLists', () => {
    it('returns parsed data on success', async () => {
      const mockData = {
        lists: [
          { id: 'list-1', name: 'Reminders', color: '#FF0000' },
          { id: 'list-2', name: 'Work', color: '#0000FF' },
        ],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleListReminderLists({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(runCommand).toHaveBeenCalledWith('reminders', 'list_lists');
    });

    it('propagates errors from runCommand', async () => {
      vi.mocked(runCommand).mockRejectedValue(new Error('Native CLI binary not found'));

      await expect(handleListReminderLists({})).rejects.toThrow('Native CLI binary not found');
    });
  });

  describe('handleListReminders', () => {
    it('returns reminders on success', async () => {
      const mockData = {
        reminders: [
          { id: 'r-1', name: 'Buy groceries', completed: false, due_date: '2026-02-20T10:00:00Z' },
        ],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleListReminders({ limit: 20 });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(runCommand).toHaveBeenCalledWith('reminders', 'list_reminders', { limit: 20 });
    });

    it('passes filter params to runCommand', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { reminders: [] } });

      await handleListReminders({ list_id: 'list-1', show_completed: true });

      expect(runCommand).toHaveBeenCalledWith('reminders', 'list_reminders', {
        list_id: 'list-1',
        show_completed: true,
      });
    });

    it('returns reminders with tags and notes', async () => {
      const mockData = {
        reminders: [
          {
            id: 'r-1',
            name: 'Tagged',
            completed: false,
            tags: ['idea'],
            notes: 'Some note',
          },
        ],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleListReminders({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('returns reminders without tags when absent from CLI output', async () => {
      const mockData = {
        reminders: [{ id: 'r-1', name: 'No tags', completed: false }],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleListReminders({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });
  });

  describe('handleGetReminder', () => {
    it('returns reminder by ID', async () => {
      const mockData = {
        id: 'r-1',
        name: 'Buy groceries',
        completed: false,
        due_date: '2026-02-20T10:00:00Z',
        priority: 0,
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleGetReminder({ id: 'r-1' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(runCommand).toHaveBeenCalledWith('reminders', 'get_reminder', { id: 'r-1' });
    });

    it('fails when id is empty', async () => {
      const result = await handleGetReminder({ id: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
      expect(result.error?.message).toContain('id');
    });

    it('returns reminder with tags', async () => {
      const mockData = {
        id: 'r-1',
        name: 'Tagged',
        completed: false,
        tags: ['work'],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleGetReminder({ id: 'r-1' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('returns reminder without tags when absent from CLI output', async () => {
      const mockData = { id: 'r-1', name: 'No tags', completed: false };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleGetReminder({ id: 'r-1' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });
  });

  describe('handleCreateReminder', () => {
    it('creates reminder successfully', async () => {
      const mockData = { id: 'r-new', status: 'created' };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleCreateReminder({
        name: 'New reminder',
        due_date: '2026-03-01T09:00:00Z',
        priority: 1,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(runCommand).toHaveBeenCalledWith('reminders', 'create_reminder', {
        name: 'New reminder',
        due_date: '2026-03-01T09:00:00Z',
        priority: 1,
      });
    });

    it('fails when name is empty', async () => {
      const result = await handleCreateReminder({ name: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
      expect(result.error?.message).toContain('name');
    });

    it('passes optional params to runCommand', async () => {
      vi.mocked(runCommand).mockResolvedValue({
        stdout: '',
        parsed: { id: 'r-2', status: 'created' },
      });

      await handleCreateReminder({
        name: 'With notes',
        notes: 'Some details',
        list_id: 'list-2',
      });

      expect(runCommand).toHaveBeenCalledWith('reminders', 'create_reminder', {
        name: 'With notes',
        notes: 'Some details',
        list_id: 'list-2',
      });
    });

    it('creates reminder with tags', async () => {
      vi.mocked(runCommand).mockResolvedValue({
        stdout: '',
        parsed: { id: 'r-t', status: 'created' },
      });

      await handleCreateReminder({ name: 'Test', tags: ['idea', 'work'] });

      expect(runCommand).toHaveBeenCalledWith(
        'reminders',
        'create_reminder',
        expect.objectContaining({ tags: ['idea', 'work'] })
      );
    });

    it('passes empty tags array', async () => {
      vi.mocked(runCommand).mockResolvedValue({
        stdout: '',
        parsed: { id: 'r-e', status: 'created' },
      });

      await handleCreateReminder({ name: 'Test', tags: [] });

      expect(runCommand).toHaveBeenCalledWith(
        'reminders',
        'create_reminder',
        expect.objectContaining({ tags: [] })
      );
    });

    it('creates reminder without tags when omitted', async () => {
      vi.mocked(runCommand).mockResolvedValue({
        stdout: '',
        parsed: { id: 'r-n', status: 'created' },
      });

      await handleCreateReminder({ name: 'Test' });

      expect(vi.mocked(runCommand).mock.calls[0][2]).not.toHaveProperty('tags');
    });
  });

  describe('handleCompleteReminder', () => {
    it('completes reminder successfully', async () => {
      const mockData = { status: 'completed' };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleCompleteReminder({ id: 'r-1' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(runCommand).toHaveBeenCalledWith('reminders', 'complete_reminder', { id: 'r-1' });
    });

    it('fails when id is empty', async () => {
      const result = await handleCompleteReminder({ id: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
    });
  });

  describe('createReminderTools', () => {
    it('returns 5 tool definitions', () => {
      const tools = createReminderTools();

      expect(tools).toHaveLength(5);
      expect(tools.map((t) => t.tool.name)).toEqual([
        'listReminderLists',
        'listReminders',
        'getReminder',
        'createReminder',
        'completeReminder',
      ]);
    });

    it('all tools have handlers', () => {
      const tools = createReminderTools();
      for (const t of tools) {
        expect(t.handler).toBeTypeOf('function');
      }
    });

    it('createReminderTool inputSchema includes tags', () => {
      const tools = createReminderTools();
      const createTool = tools.find((t) => t.tool.name === 'createReminder')!;
      const props = createTool.tool.inputSchema.properties as Record<string, { type: string }>;
      expect(props.tags).toBeDefined();
      expect(props.tags.type).toBe('array');
    });

    it('listRemindersTool outputSchema includes notes and tags', () => {
      const tools = createReminderTools();
      const listTool = tools.find((t) => t.tool.name === 'listReminders')!;
      const items = (listTool.tool.outputSchema as any)?.properties?.reminders?.items;
      expect(items?.properties?.notes).toBeDefined();
      expect(items?.properties?.tags).toBeDefined();
      expect(items?.properties?.tags?.type).toBe('array');
    });

    it('listRemindersTool outputSchema includes list_id, list_name and completed_date', () => {
      const tools = createReminderTools();
      const listTool = tools.find((t) => t.tool.name === 'listReminders')!;
      const items = (listTool.tool.outputSchema as any)?.properties?.reminders?.items;
      expect(items?.properties?.list_id).toBeDefined();
      expect(items?.properties?.list_name).toBeDefined();
      expect(items?.properties?.completed_date).toBeDefined();
    });

    it('getReminderTool outputSchema includes tags', () => {
      const tools = createReminderTools();
      const getTool = tools.find((t) => t.tool.name === 'getReminder')!;
      const props = (getTool.tool.outputSchema as any)?.properties;
      expect(props?.tags).toBeDefined();
      expect(props?.tags?.type).toBe('array');
    });
  });

  describe('input validation (SEC-012)', () => {
    describe('handleListReminders', () => {
      it('rejects list_id with control characters', async () => {
        const result = await handleListReminders({ list_id: 'list\x07id' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });

      it('rejects limit as string', async () => {
        const result = await handleListReminders({ limit: '50' as any });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });

      it('rejects show_completed as string', async () => {
        const result = await handleListReminders({ show_completed: 'true' as any });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });
    });

    describe('handleCreateReminder', () => {
      it('rejects name exceeding max length', async () => {
        const result = await handleCreateReminder({ name: 'a'.repeat(1001) });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('FIELD_TOO_LONG');
      });

      it('rejects name with null byte', async () => {
        const result = await handleCreateReminder({ name: 'test\x00name' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });

      it('rejects priority as string', async () => {
        const result = await handleCreateReminder({ name: 'Test', priority: '1' as any });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });

      it('rejects invalid due_date', async () => {
        const result = await handleCreateReminder({
          name: 'Test',
          due_date: 'not-a-date',
        });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_DATE');
      });

      it('rejects tags as string', async () => {
        const result = await handleCreateReminder({ name: 'Test', tags: 'not-array' as any });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });

      it('rejects tags as null', async () => {
        const result = await handleCreateReminder({ name: 'Test', tags: null as any });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });

      it('rejects tags with non-string element', async () => {
        const result = await handleCreateReminder({ name: 'Test', tags: ['ok', 123 as any] });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });

      it('rejects tags with empty string', async () => {
        const result = await handleCreateReminder({ name: 'Test', tags: ['ok', ''] });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('EMPTY_FIELDS');
      });

      it('rejects tags with control chars', async () => {
        const result = await handleCreateReminder({ name: 'Test', tags: ['ok\x00bad'] });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });

      it('rejects tags as boolean', async () => {
        const result = await handleCreateReminder({ name: 'Test', tags: true as any });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });

      it('rejects tags exceeding max items', async () => {
        const result = await handleCreateReminder({ name: 'Test', tags: Array(51).fill('tag') });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('ARRAY_TOO_LONG');
      });

      it('rejects tag exceeding max length', async () => {
        const result = await handleCreateReminder({ name: 'Test', tags: ['a'.repeat(1001)] });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('FIELD_TOO_LONG');
      });

      it('rejects tag containing ] to prevent marker injection', async () => {
        const result = await handleCreateReminder({
          name: 'Test',
          tags: ['work][#injected'],
        });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });

      it('rejects tag containing [ character', async () => {
        const result = await handleCreateReminder({ name: 'Test', tags: ['[bad'] });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });

      it('rejects tag containing # character', async () => {
        const result = await handleCreateReminder({ name: 'Test', tags: ['#bad'] });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });
    });

    describe('handleCompleteReminder', () => {
      it('rejects id exceeding max length', async () => {
        const result = await handleCompleteReminder({ id: 'a'.repeat(513) });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('FIELD_TOO_LONG');
      });
    });
  });
});
