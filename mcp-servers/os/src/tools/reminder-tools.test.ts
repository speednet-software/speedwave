/**
 * Reminder Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleListReminderLists,
  handleListReminders,
  handleGetReminder,
  handleCreateReminder,
  handleUpdateReminder,
  handleCompleteReminder,
  createReminderTools,
} from './reminder-tools.js';

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
      expect((result.data as any).reminder).toBeUndefined();
      expect((result.data as any).id).toBe('r-1');
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

  describe('handleUpdateReminder', () => {
    it('renames a reminder and passes only the given fields through', async () => {
      const mockData = { status: 'updated' };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleUpdateReminder({ id: 'r-1', name: 'Kacper chce na UoP' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(runCommand).toHaveBeenCalledWith('reminders', 'update_reminder', {
        id: 'r-1',
        name: 'Kacper chce na UoP',
      });
    });

    it('passes every updatable field through unchanged', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { status: 'updated' } });

      await handleUpdateReminder({
        id: 'r-1',
        name: 'Review PR #42',
        list_id: 'list-2',
        due_date: '2026-01-16T10:00:00',
        priority: 5,
        notes: 'Rescheduled',
        tags: ['work'],
        completed: false,
      });

      expect(runCommand).toHaveBeenCalledWith('reminders', 'update_reminder', {
        id: 'r-1',
        name: 'Review PR #42',
        list_id: 'list-2',
        due_date: '2026-01-16T10:00:00',
        priority: 5,
        notes: 'Rescheduled',
        tags: ['work'],
        completed: false,
      });
    });

    it('passes due_date null through so the CLI clears the due date', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { status: 'updated' } });

      const result = await handleUpdateReminder({ id: 'r-1', due_date: null });

      expect(result.success).toBe(true);
      expect(runCommand).toHaveBeenCalledWith('reminders', 'update_reminder', {
        id: 'r-1',
        due_date: null,
      });
    });

    it('accepts an all-day due date', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { status: 'updated' } });

      const result = await handleUpdateReminder({ id: 'r-1', due_date: '2026-07-01' });

      expect(result.success).toBe(true);
    });

    it('emits only keys declared in its outputSchema', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { status: 'updated' } });
      const tool = createReminderTools().find((t) => t.tool.name === 'updateReminder')!;

      const result = await tool.handler({ id: 'r-1', name: 'x' });

      const emitted = JSON.parse((result.content[0] as { text: string }).text) as Record<
        string,
        unknown
      >;
      const declared = Object.keys(tool.tool.outputSchema!.properties as Record<string, unknown>);
      expect(declared).toEqual(expect.arrayContaining(Object.keys(emitted)));
    });

    it('fails when id is missing', async () => {
      const result = await handleUpdateReminder({ name: 'x' } as any);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_FIELDS');
      expect(runCommand).not.toHaveBeenCalled();
    });

    it('fails when id is empty', async () => {
      const result = await handleUpdateReminder({ id: '', name: 'x' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
    });

    it('rejects an empty name (a reminder must keep a title)', async () => {
      const result = await handleUpdateReminder({ id: 'r-1', name: '   ' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
      expect(result.error?.message).toContain('name');
    });

    it('rejects name as null', async () => {
      const result = await handleUpdateReminder({ id: 'r-1', name: null as any });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_TYPE');
    });

    it('rejects name exceeding max length', async () => {
      const result = await handleUpdateReminder({ id: 'r-1', name: 'a'.repeat(1001) });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FIELD_TOO_LONG');
    });

    it('rejects an invalid due_date', async () => {
      const result = await handleUpdateReminder({ id: 'r-1', due_date: 'tomorrow' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_DATE');
    });

    it('rejects completed as a string', async () => {
      const result = await handleUpdateReminder({ id: 'r-1', completed: 'false' as any });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_TYPE');
    });

    it('rejects priority out of range', async () => {
      const result = await handleUpdateReminder({ id: 'r-1', priority: 10 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('OUT_OF_RANGE');
    });

    it('rejects a fractional priority instead of silently ignoring it', async () => {
      const result = await handleUpdateReminder({ id: 'r-1', priority: 5.5 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_TYPE');
      expect(runCommand).not.toHaveBeenCalled();
    });

    it('rejects a tag containing marker characters', async () => {
      const result = await handleUpdateReminder({ id: 'r-1', tags: ['ok', 'bad]#'] });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_CHARACTERS');
      expect(result.error?.message).toContain('tags[1]');
    });

    it('passes an empty tags array (clears all tags)', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { status: 'updated' } });

      await handleUpdateReminder({ id: 'r-1', tags: [] });

      expect(runCommand).toHaveBeenCalledWith(
        'reminders',
        'update_reminder',
        expect.objectContaining({ tags: [] })
      );
    });

    it('propagates CLI failures such as an unknown id', async () => {
      vi.mocked(runCommand).mockRejectedValue(
        new Error("reminders.update_reminder failed: Reminder with id 'nope' not found")
      );

      await expect(handleUpdateReminder({ id: 'nope', name: 'x' })).rejects.toThrow('not found');
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
    it('rejects an undeclared argument without running the command', async () => {
      const tool = createReminderTools().find((t) => t.tool.name === 'createReminder')!;

      const result = await tool.handler({ name: 'x', alarm: { offset_minutes: -5 } });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('alarm');
      expect(runCommand).not.toHaveBeenCalled();
    });

    it('returns 6 tool definitions', () => {
      const tools = createReminderTools();

      expect(tools).toHaveLength(6);
      expect(tools.map((t) => t.tool.name)).toEqual([
        'listReminderLists',
        'listReminders',
        'getReminder',
        'createReminder',
        'updateReminder',
        'completeReminder',
      ]);
    });

    it('updateReminderTool requires only id and lets due_date be null', () => {
      const tools = createReminderTools();
      const updateTool = tools.find((t) => t.tool.name === 'updateReminder')!;
      const props = updateTool.tool.inputSchema.properties as Record<string, { type: unknown }>;

      expect(updateTool.tool.inputSchema.required).toEqual(['id']);
      expect(props.due_date.type).toEqual(['string', 'null']);
      expect(props.completed.type).toBe('boolean');
      expect(props.tags.type).toBe('array');
      expect(updateTool.tool.annotations?.destructiveHint).toBe(false);
      expect(updateTool.tool.annotations?.readOnlyHint).toBe(false);
    });

    it('listReminders and getReminder outputSchemas declare all_day next to due_date', () => {
      const tools = createReminderTools();
      const listItems = (
        tools.find((t) => t.tool.name === 'listReminders')!.tool.outputSchema as any
      ).properties.reminders.items.properties;
      const getProps = (tools.find((t) => t.tool.name === 'getReminder')!.tool.outputSchema as any)
        .properties;

      for (const props of [listItems, getProps]) {
        expect(props.all_day.type).toBe('boolean');
        expect(props.due_date.description).toContain('YYYY-MM-DD');
      }
    });

    it('createReminder and updateReminder examples teach local due dates, never UTC', () => {
      const localDueDate = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/;
      const tools = createReminderTools().filter((t) =>
        ['createReminder', 'updateReminder'].includes(t.tool.name)
      );
      const dueDates = tools.flatMap((t) => [
        ...(t.tool.inputExamples ?? [])
          .map((e) => e.input.due_date)
          .filter((d): d is string => typeof d === 'string'),
        ...[...(t.tool.example ?? '').matchAll(/due_date: "([^"]*)"/g)].map((m) => m[1]),
      ]);

      expect(dueDates).toContain('2026-01-15T10:00:00');
      expect(dueDates.length).toBeGreaterThanOrEqual(4);
      for (const dueDate of dueDates) {
        expect(dueDate).toMatch(localDueDate);
      }
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

      it('rejects a fractional priority (the CLI cannot apply it)', async () => {
        const result = await handleCreateReminder({ name: 'Test', priority: 5.5 });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
        expect(runCommand).not.toHaveBeenCalled();
      });

      it('rejects due_date null (only updateReminder can clear a due date)', async () => {
        const result = await handleCreateReminder({ name: 'Test', due_date: null as any });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
        expect(runCommand).not.toHaveBeenCalled();
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

  describe('alarms', () => {
    const office = {
      name: 'Biuro',
      latitude: 52.23,
      longitude: 21.01,
      radius_m: 100,
      on: 'arrive' as const,
    };
    const validAlarms = [
      { at: '2026-06-15T08:30:00' },
      { offset_minutes: -30 },
      { location: office },
      { location: { name: 'Dom', latitude: -90, longitude: 180, on: 'leave' as const } },
    ];

    const invalidAlarms: [string, unknown, string][] = [
      [
        'two variants in one element',
        [{ at: '2026-06-15T08:30:00', offset_minutes: -5 }],
        'INVALID_PARAM',
      ],
      ['no variant in an element', [{}], 'INVALID_PARAM'],
      ['an element that is not an object', ['soon'], 'INVALID_TYPE'],
      ['an element that is an array', [[]], 'INVALID_TYPE'],
      ['an element that is null', [null], 'INVALID_TYPE'],
      ['alarms that are not an array', { offset_minutes: -5 }, 'INVALID_TYPE'],
      ['an invalid at', [{ at: 'tomorrow' }], 'INVALID_DATE'],
      ['a non-string at', [{ at: 20260615 }], 'INVALID_DATE'],
      ['a fractional offset', [{ offset_minutes: -0.5 }], 'INVALID_TYPE'],
      ['a string offset', [{ offset_minutes: '-30' }], 'INVALID_TYPE'],
      ['a location that is not an object', [{ location: 'Biuro' }], 'INVALID_TYPE'],
      ['a location without a name', [{ location: { ...office, name: '' } }], 'INVALID_TYPE'],
      [
        'a location name that is not a string',
        [{ location: { ...office, name: 7 } }],
        'INVALID_TYPE',
      ],
      ['a latitude above 90', [{ location: { ...office, latitude: 90.1 } }], 'OUT_OF_RANGE'],
      ['a latitude below -90', [{ location: { ...office, latitude: -91 } }], 'OUT_OF_RANGE'],
      ['a longitude above 180', [{ location: { ...office, longitude: 181 } }], 'OUT_OF_RANGE'],
      ['a longitude below -180', [{ location: { ...office, longitude: -180.5 } }], 'OUT_OF_RANGE'],
      ['a missing latitude', [{ location: { ...office, latitude: undefined } }], 'INVALID_TYPE'],
      [
        'a non-finite longitude',
        [{ location: { ...office, longitude: Infinity } }],
        'INVALID_TYPE',
      ],
      ['a negative radius', [{ location: { ...office, radius_m: -1 } }], 'OUT_OF_RANGE'],
      ['a non-numeric radius', [{ location: { ...office, radius_m: 'big' } }], 'INVALID_TYPE'],
      ['an unknown on', [{ location: { ...office, on: 'nearby' } }], 'INVALID_PARAM'],
      ['a missing on', [{ location: { ...office, on: undefined } }], 'INVALID_PARAM'],
    ];

    describe('handleCreateReminder', () => {
      it('passes valid alarms of every variant through unchanged', async () => {
        vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { id: 'r-1' } });
        const params = { name: 'Call', due_date: '2026-06-15T09:00:00', alarms: validAlarms };

        const result = await handleCreateReminder(params);

        expect(result.success).toBe(true);
        expect(runCommand).toHaveBeenCalledWith('reminders', 'create_reminder', params);
      });

      it('passes an empty alarms array through', async () => {
        vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { id: 'r-1' } });

        const result = await handleCreateReminder({ name: 'Call', alarms: [] });

        expect(result.success).toBe(true);
      });

      it('rejects alarms null (only updateReminder can clear alarms)', async () => {
        const result = await handleCreateReminder({ name: 'Call', alarms: null as any });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
        expect(runCommand).not.toHaveBeenCalled();
      });

      it.each(invalidAlarms)('rejects %s', async (_label, alarms, code) => {
        const result = await handleCreateReminder({ name: 'Call', alarms: alarms as any });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(code);
        expect(runCommand).not.toHaveBeenCalled();
      });
    });

    describe('handleUpdateReminder', () => {
      it('passes valid alarms of every variant through unchanged', async () => {
        vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { status: 'updated' } });
        const params = { id: 'r-1', alarms: validAlarms };

        const result = await handleUpdateReminder(params);

        expect(result.success).toBe(true);
        expect(runCommand).toHaveBeenCalledWith('reminders', 'update_reminder', params);
      });

      it('passes alarms null through so the CLI removes every alarm', async () => {
        vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { status: 'updated' } });

        const result = await handleUpdateReminder({ id: 'r-1', alarms: null });

        expect(result.success).toBe(true);
        expect(runCommand).toHaveBeenCalledWith('reminders', 'update_reminder', {
          id: 'r-1',
          alarms: null,
        });
      });

      it('passes an empty alarms array through', async () => {
        vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { status: 'updated' } });

        const result = await handleUpdateReminder({ id: 'r-1', alarms: [] });

        expect(result.success).toBe(true);
      });

      it.each(invalidAlarms)('rejects %s', async (_label, alarms, code) => {
        const result = await handleUpdateReminder({ id: 'r-1', alarms: alarms as any });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(code);
        expect(runCommand).not.toHaveBeenCalled();
      });
    });
  });
});
