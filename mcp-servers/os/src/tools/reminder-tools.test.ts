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
