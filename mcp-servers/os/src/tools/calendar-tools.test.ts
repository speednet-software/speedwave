/**
 * Calendar Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleListCalendars,
  handleListEvents,
  handleGetEvent,
  handleCreateEvent,
  handleUpdateEvent,
  handleDeleteEvent,
  createCalendarTools,
} from './calendar-tools.js';

// Mock the platform runner
vi.mock('../platform-runner.js', () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from '../platform-runner.js';

describe('calendar-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleListCalendars', () => {
    it('returns calendars on success', async () => {
      const mockData = {
        calendars: [
          { id: 'cal-1', name: 'Personal', type: 'local', color: '#FF0000' },
          { id: 'cal-2', name: 'Work', type: 'exchange', color: '#0000FF' },
        ],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleListCalendars({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(runCommand).toHaveBeenCalledWith('calendar', 'list_calendars');
    });
  });

  describe('handleListEvents', () => {
    it('returns events on success', async () => {
      const mockData = {
        events: [
          {
            id: 'e-1',
            summary: 'Meeting',
            start: '2026-02-20T10:00:00Z',
            end: '2026-02-20T11:00:00Z',
          },
        ],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleListEvents({
        start: '2026-02-20T00:00:00Z',
        end: '2026-02-21T00:00:00Z',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('passes date range to runCommand', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { events: [] } });

      await handleListEvents({
        calendar_id: 'cal-1',
        start: '2026-02-01T00:00:00Z',
        end: '2026-02-28T23:59:59Z',
        limit: 100,
      });

      expect(runCommand).toHaveBeenCalledWith('calendar', 'list_events', {
        calendar_id: 'cal-1',
        start: '2026-02-01T00:00:00Z',
        end: '2026-02-28T23:59:59Z',
        limit: 100,
      });
    });

    it('rejects invalid start date', async () => {
      const result = await handleListEvents({ start: 'not-a-date' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_DATE');
      expect(result.error?.message).toContain('start');
    });

    it('rejects invalid end date', async () => {
      const result = await handleListEvents({ start: '2026-02-20T00:00:00Z', end: 'invalid' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_DATE');
      expect(result.error?.message).toContain('end');
    });
  });

  describe('handleGetEvent', () => {
    it('returns event by ID', async () => {
      const mockData = { id: 'e-1', summary: 'Meeting', start: '2026-02-20T10:00:00Z' };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleGetEvent({ id: 'e-1' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('fails when id is empty', async () => {
      const result = await handleGetEvent({ id: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
    });
  });

  describe('handleCreateEvent', () => {
    it('creates event successfully', async () => {
      const mockData = { id: 'e-new', status: 'created' };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleCreateEvent({
        summary: 'Lunch',
        start: '2026-02-20T12:00:00Z',
        end: '2026-02-20T13:00:00Z',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('fails when required fields are empty', async () => {
      const result = await handleCreateEvent({
        summary: '',
        start: '2026-02-20T12:00:00Z',
        end: '2026-02-20T13:00:00Z',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
      expect(result.error?.message).toContain('summary');
    });

    it('rejects invalid start date', async () => {
      const result = await handleCreateEvent({
        summary: 'Lunch',
        start: 'not-a-date',
        end: '2026-02-20T13:00:00Z',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_DATE');
    });

    it('rejects invalid end date', async () => {
      const result = await handleCreateEvent({
        summary: 'Lunch',
        start: '2026-02-20T12:00:00Z',
        end: 'not-a-date',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_DATE');
    });
  });

  describe('handleUpdateEvent', () => {
    it('updates event successfully', async () => {
      const mockData = { status: 'updated' };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleUpdateEvent({ id: 'e-1', summary: 'Updated Meeting' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('fails when id is empty', async () => {
      const result = await handleUpdateEvent({ id: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
    });

    it('rejects invalid date in update', async () => {
      const result = await handleUpdateEvent({ id: 'e-1', start: 'bad-date' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_DATE');
    });
  });

  describe('handleDeleteEvent', () => {
    it('deletes event successfully', async () => {
      const mockData = { status: 'deleted' };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleDeleteEvent({ id: 'e-1' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('fails when id is empty', async () => {
      const result = await handleDeleteEvent({ id: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
    });
  });

  describe('createCalendarTools', () => {
    it('returns 6 tool definitions', () => {
      const tools = createCalendarTools();

      expect(tools).toHaveLength(6);
      expect(tools.map((t) => t.tool.name)).toEqual([
        'listCalendars',
        'listEvents',
        'getEvent',
        'createEvent',
        'updateEvent',
        'deleteEvent',
      ]);
    });

    it('all tools have handlers', () => {
      const tools = createCalendarTools();
      for (const t of tools) {
        expect(t.handler).toBeTypeOf('function');
      }
    });
  });

  describe('input validation (SEC-012)', () => {
    describe('handleListEvents', () => {
      it('rejects calendar_id exceeding max length', async () => {
        const result = await handleListEvents({ calendar_id: 'a'.repeat(513) });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('FIELD_TOO_LONG');
      });

      it('rejects calendar_id with control characters', async () => {
        const result = await handleListEvents({ calendar_id: 'cal\x07id' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });

      it('rejects limit as string', async () => {
        const result = await handleListEvents({ limit: '50' as any });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });

      it('rejects limit = 0 (below min)', async () => {
        const result = await handleListEvents({ limit: 0 });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('OUT_OF_RANGE');
      });
    });

    describe('handleCreateEvent', () => {
      it('rejects summary exceeding max length', async () => {
        const result = await handleCreateEvent({
          summary: 'a'.repeat(1001),
          start: '2026-02-20T12:00:00Z',
          end: '2026-02-20T13:00:00Z',
        });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('FIELD_TOO_LONG');
      });

      it('rejects summary with null byte', async () => {
        const result = await handleCreateEvent({
          summary: 'test\x00event',
          start: '2026-02-20T12:00:00Z',
          end: '2026-02-20T13:00:00Z',
        });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });

      it('allows description with newlines (body mode)', async () => {
        vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { id: 'e-1' } });
        const result = await handleCreateEvent({
          summary: 'Meeting',
          start: '2026-02-20T12:00:00Z',
          end: '2026-02-20T13:00:00Z',
          description: 'Line 1\nLine 2\tTabbed',
        });
        expect(result.success).toBe(true);
      });

      it('rejects all_day as string "true"', async () => {
        const result = await handleCreateEvent({
          summary: 'Meeting',
          start: '2026-02-20T12:00:00Z',
          end: '2026-02-20T13:00:00Z',
          all_day: 'true' as any,
        });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });
    });

    describe('handleGetEvent', () => {
      it('rejects id with control characters', async () => {
        const result = await handleGetEvent({ id: 'e\x01id' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });
    });

    describe('handleUpdateEvent', () => {
      it('rejects description exceeding max length', async () => {
        const result = await handleUpdateEvent({
          id: 'e-1',
          description: 'a'.repeat(100_001),
        });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('FIELD_TOO_LONG');
      });
    });

    describe('handleDeleteEvent', () => {
      it('rejects id with control characters', async () => {
        const result = await handleDeleteEvent({ id: 'e\x01id' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });
    });
  });
});
