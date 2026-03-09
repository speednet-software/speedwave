/**
 * Notes Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleListNoteFolders,
  handleListNotes,
  handleGetNote,
  handleSearchNotes,
  handleCreateNote,
  handleUpdateNote,
  handleDeleteNote,
  createNoteTools,
} from './notes-tools.js';

// Mock the platform runner
vi.mock('../platform-runner.js', () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from '../platform-runner.js';

describe('notes-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleListNoteFolders', () => {
    it('returns folders on success', async () => {
      const mockData = {
        folders: [
          { id: 'folder-1', name: 'Notes', account_name: 'iCloud', note_count: 42 },
          { id: 'folder-2', name: 'Work', account_name: 'iCloud', note_count: 10 },
        ],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleListNoteFolders({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(runCommand).toHaveBeenCalledWith('notes', 'list_folders');
    });
  });

  describe('handleListNotes', () => {
    it('returns notes on success', async () => {
      const mockData = {
        notes: [{ id: 'n-1', title: 'Shopping list', modified_at: '2026-02-19T10:00:00Z' }],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleListNotes({ limit: 20 });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(runCommand).toHaveBeenCalledWith('notes', 'list_notes', { limit: 20 });
    });

    it('passes folder_id filter', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { notes: [] } });

      await handleListNotes({ folder_id: 'folder-1' });

      expect(runCommand).toHaveBeenCalledWith('notes', 'list_notes', { folder_id: 'folder-1' });
    });
  });

  describe('handleGetNote', () => {
    it('returns note with body', async () => {
      const mockData = {
        id: 'n-1',
        title: 'Shopping list',
        body: '<h1>Shopping</h1><p>Milk, Eggs</p>',
        plaintext: 'Shopping\nMilk, Eggs',
        modified_at: '2026-02-19T10:00:00Z',
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleGetNote({ id: 'n-1' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('fails when id is empty', async () => {
      const result = await handleGetNote({ id: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
    });
  });

  describe('handleSearchNotes', () => {
    it('searches notes by query', async () => {
      const mockData = {
        results: [{ id: 'n-2', title: 'Meeting notes', snippet: '...discussed the project...' }],
      };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleSearchNotes({ query: 'meeting' });

      expect(result.success).toBe(true);
      expect(runCommand).toHaveBeenCalledWith('notes', 'search_notes', { query: 'meeting' });
    });

    it('fails when query is empty', async () => {
      const result = await handleSearchNotes({ query: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
      expect(result.error?.message).toContain('query');
    });

    it('passes folder_id and limit', async () => {
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { results: [] } });

      await handleSearchNotes({ query: 'test', folder_id: 'folder-1', limit: 5 });

      expect(runCommand).toHaveBeenCalledWith('notes', 'search_notes', {
        query: 'test',
        folder_id: 'folder-1',
        limit: 5,
      });
    });
  });

  describe('handleCreateNote', () => {
    it('creates note successfully', async () => {
      const mockData = { id: 'n-new', status: 'created' };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleCreateNote({ title: 'New note', body: 'Content here' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(runCommand).toHaveBeenCalledWith('notes', 'create_note', {
        title: 'New note',
        body: 'Content here',
      });
    });

    it('fails when title is empty', async () => {
      const result = await handleCreateNote({ title: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
      expect(result.error?.message).toContain('title');
    });
  });

  describe('handleUpdateNote', () => {
    it('updates note successfully', async () => {
      const mockData = { status: 'updated' };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleUpdateNote({ id: 'n-1', title: 'Updated title' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('fails when id is empty', async () => {
      const result = await handleUpdateNote({ id: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
    });
  });

  describe('handleDeleteNote', () => {
    it('deletes note successfully', async () => {
      const mockData = { status: 'deleted' };
      vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: mockData });

      const result = await handleDeleteNote({ id: 'n-1' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('fails when id is empty', async () => {
      const result = await handleDeleteNote({ id: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_FIELDS');
    });
  });

  describe('createNoteTools', () => {
    it('returns 7 tool definitions', () => {
      const tools = createNoteTools();

      expect(tools).toHaveLength(7);
      expect(tools.map((t) => t.tool.name)).toEqual([
        'listNoteFolders',
        'listNotes',
        'getNote',
        'searchNotes',
        'createNote',
        'updateNote',
        'deleteNote',
      ]);
    });

    it('all tools have handlers', () => {
      const tools = createNoteTools();
      for (const t of tools) {
        expect(t.handler).toBeTypeOf('function');
      }
    });
  });

  describe('input validation (SEC-012)', () => {
    describe('handleListNotes', () => {
      it('rejects folder_id exceeding max length', async () => {
        const result = await handleListNotes({ folder_id: 'a'.repeat(513) });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('FIELD_TOO_LONG');
      });

      it('rejects limit as string', async () => {
        const result = await handleListNotes({ limit: '50' as any });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_TYPE');
      });
    });

    describe('handleSearchNotes', () => {
      it('rejects query with control characters', async () => {
        const result = await handleSearchNotes({ query: 'test\x00query' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });

      it('rejects limit = 0', async () => {
        const result = await handleSearchNotes({ query: 'test', limit: 0 });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('OUT_OF_RANGE');
      });
    });

    describe('handleCreateNote', () => {
      it('rejects title exceeding max length', async () => {
        const result = await handleCreateNote({ title: 'a'.repeat(1001) });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('FIELD_TOO_LONG');
      });

      it('rejects title with bell character', async () => {
        const result = await handleCreateNote({ title: 'test\x07note' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });

      it('allows body with newlines (body mode)', async () => {
        vi.mocked(runCommand).mockResolvedValue({ stdout: '', parsed: { id: 'n-1' } });
        const result = await handleCreateNote({ title: 'Note', body: 'Line 1\nLine 2' });
        expect(result.success).toBe(true);
      });

      it('rejects body exceeding max length', async () => {
        const result = await handleCreateNote({ title: 'Note', body: 'a'.repeat(100_001) });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('FIELD_TOO_LONG');
      });
    });

    describe('handleUpdateNote', () => {
      it('rejects id with control characters', async () => {
        const result = await handleUpdateNote({ id: 'n\x01id' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });
    });

    describe('handleDeleteNote', () => {
      it('rejects id exceeding max length', async () => {
        const result = await handleDeleteNote({ id: 'a'.repeat(513) });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('FIELD_TOO_LONG');
      });

      it('rejects id with control characters', async () => {
        const result = await handleDeleteNote({ id: 'n\x01id' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_CHARACTERS');
      });
    });
  });
});
