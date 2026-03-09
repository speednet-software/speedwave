/**
 * Sync State Tests
 * Tests for OneDrive-like sync state persistence
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { SyncStateStore, SyncState, SYNC_STATE_FILENAME } from './sync-state.js';

// Mock fs module
vi.mock('fs/promises');

describe('SyncStateStore', () => {
  const mockLocalPath = '/context/sync-test';
  const expectedStatePath = path.join(mockLocalPath, SYNC_STATE_FILENAME);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates state path in local directory', () => {
      const store = new SyncStateStore(mockLocalPath);
      expect(store.getStatePath()).toBe(expectedStatePath);
    });
  });

  describe('load', () => {
    it('returns null when state file does not exist', async () => {
      vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });

      const store = new SyncStateStore(mockLocalPath);
      const result = await store.load();

      expect(result).toBeNull();
      expect(fs.readFile).toHaveBeenCalledWith(expectedStatePath, 'utf-8');
    });

    it('parses valid state file', async () => {
      const validState: SyncState = {
        version: '1.0',
        lastSyncTime: '2025-01-15T10:00:00.000Z',
        sharepointPath: 'context',
        files: {
          'file1.txt': {
            path: 'file1.txt',
            size: 100,
            lastModified: '2025-01-15T09:00:00.000Z',
            syncedAt: '2025-01-15T10:00:00.000Z',
          },
        },
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validState));

      const store = new SyncStateStore(mockLocalPath);
      const result = await store.load();

      expect(result).toEqual(validState);
    });

    it('returns null and warns on corrupted JSON', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('{ invalid json }}}');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const store = new SyncStateStore(mockLocalPath);
      const result = await store.load();

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load sync state'));
    });

    it('returns null and warns on wrong version', async () => {
      const wrongVersionState = {
        version: '2.0', // Wrong version
        lastSyncTime: '2025-01-15T10:00:00.000Z',
        sharepointPath: 'context',
        files: {},
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(wrongVersionState));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const store = new SyncStateStore(mockLocalPath);
      const result = await store.load();

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Sync state version mismatch'));
    });

    it('returns null for other file read errors', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('Permission denied'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const store = new SyncStateStore(mockLocalPath);
      const result = await store.load();

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load sync state'));
    });
  });

  describe('save', () => {
    it('saves state to .sync-state.json', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const state: SyncState = {
        version: '1.0',
        lastSyncTime: '2025-01-15T10:00:00.000Z',
        sharepointPath: 'context',
        files: {
          'file1.txt': {
            path: 'file1.txt',
            size: 100,
            lastModified: '2025-01-15T09:00:00.000Z',
            syncedAt: '2025-01-15T10:00:00.000Z',
          },
        },
      };

      const store = new SyncStateStore(mockLocalPath);
      await store.save(state);

      expect(fs.writeFile).toHaveBeenCalledWith(
        expectedStatePath,
        JSON.stringify(state, null, 2),
        'utf-8'
      );
    });

    it('overwrites existing state file', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const oldState: SyncState = {
        version: '1.0',
        lastSyncTime: '2025-01-14T10:00:00.000Z',
        sharepointPath: 'context',
        files: {
          'old.txt': {
            path: 'old.txt',
            size: 50,
            lastModified: '2025-01-14T09:00:00.000Z',
            syncedAt: '2025-01-14T10:00:00.000Z',
          },
        },
      };
      const newState: SyncState = {
        version: '1.0',
        lastSyncTime: '2025-01-15T10:00:00.000Z',
        sharepointPath: 'context',
        files: {
          'new.txt': {
            path: 'new.txt',
            size: 100,
            lastModified: '2025-01-15T09:00:00.000Z',
            syncedAt: '2025-01-15T10:00:00.000Z',
          },
        },
      };

      const store = new SyncStateStore(mockLocalPath);
      await store.save(oldState);
      await store.save(newState);

      // Should be called twice, second call with new state
      expect(fs.writeFile).toHaveBeenCalledTimes(2);
      expect(fs.writeFile).toHaveBeenLastCalledWith(
        expectedStatePath,
        JSON.stringify(newState, null, 2),
        'utf-8'
      );
    });
  });

  describe('SYNC_STATE_FILENAME', () => {
    it('is .sync-state.json', () => {
      expect(SYNC_STATE_FILENAME).toBe('.sync-state.json');
    });
  });
});
