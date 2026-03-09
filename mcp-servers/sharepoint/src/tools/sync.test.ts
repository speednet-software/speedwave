/**
 * Sync Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { handleSyncDirectory } from './sync-tools.js';
import type { SharePointClient } from '../client.js';

type MockClient = {
  syncDirectory: Mock;
  formatError: Mock;
};

interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  failed: number;
}

interface SyncResult {
  success: boolean;
  plan: { operations: unknown[]; summary: { toUpload: number; toDownload: number } };
  summary: SyncSummary;
  conflicts?: string[];
  errors?: unknown[];
}

describe('sync-tools', () => {
  const createMockClient = (): MockClient => ({
    syncDirectory: vi.fn(),
    formatError: vi.fn((error: unknown) => {
      const e = error as { message?: string };
      return e.message || 'Unknown error';
    }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleSyncDirectory', () => {
    it('syncs directory successfully with two_way mode', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [],
          summary: {
            toUpload: 2,
            toDownload: 1,
            toDeleteLocal: 0,
            toDeleteRemote: 0,
            conflicts: 0,
            skipped: 5,
          },
        },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 2,
          downloaded: 1,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        mode: 'two_way',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(syncResult);
      expect(client.syncDirectory).toHaveBeenCalledWith({
        localPath: '/tmp/sync',
        mode: 'two_way',
      });
    });

    it('syncs directory with pull mode', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [],
          summary: {
            toUpload: 0,
            toDownload: 3,
            toDeleteLocal: 0,
            toDeleteRemote: 0,
            conflicts: 0,
            skipped: 2,
          },
        },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 0,
          downloaded: 3,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        mode: 'pull',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(syncResult);
      expect((result.data as SyncResult)?.summary.downloaded).toBe(3);
      expect((result.data as SyncResult)?.summary.uploaded).toBe(0);
    });

    it('syncs directory with push mode', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [],
          summary: {
            toUpload: 5,
            toDownload: 0,
            toDeleteLocal: 0,
            toDeleteRemote: 0,
            conflicts: 0,
            skipped: 1,
          },
        },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 5,
          downloaded: 0,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        mode: 'push',
      });

      expect(result.success).toBe(true);
      expect((result.data as SyncResult)?.summary.uploaded).toBe(5);
      expect((result.data as SyncResult)?.summary.downloaded).toBe(0);
    });

    it('syncs directory with sharepointPath specified', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [],
          summary: {
            toUpload: 1,
            toDownload: 1,
            toDeleteLocal: 0,
            toDeleteRemote: 0,
            conflicts: 0,
            skipped: 3,
          },
        },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 1,
          downloaded: 1,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        sharepointPath: 'documents/project',
        mode: 'two_way',
      });

      expect(result.success).toBe(true);
      expect(client.syncDirectory).toHaveBeenCalledWith({
        localPath: '/tmp/sync',
        sharepointPath: 'documents/project',
        mode: 'two_way',
      });
    });

    it('syncs directory with delete enabled', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [],
          summary: {
            toUpload: 1,
            toDownload: 1,
            toDeleteLocal: 2,
            toDeleteRemote: 1,
            conflicts: 0,
            skipped: 0,
          },
        },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 1,
          downloaded: 1,
          deletedLocal: 2,
          deletedRemote: 1,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        mode: 'two_way',
        delete: true,
      });

      expect(result.success).toBe(true);
      expect((result.data as SyncResult)?.summary.deletedLocal).toBe(2);
      expect((result.data as SyncResult)?.summary.deletedRemote).toBe(1);
    });

    it('syncs directory with delete disabled', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [],
          summary: {
            toUpload: 1,
            toDownload: 1,
            toDeleteLocal: 0,
            toDeleteRemote: 0,
            conflicts: 0,
            skipped: 4,
          },
        },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 1,
          downloaded: 1,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        mode: 'two_way',
        delete: false,
      });

      expect(result.success).toBe(true);
      expect((result.data as SyncResult)?.summary.deletedLocal).toBe(0);
      expect((result.data as SyncResult)?.summary.deletedRemote).toBe(0);
    });

    it('syncs directory with ignore patterns', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [],
          summary: {
            toUpload: 2,
            toDownload: 1,
            toDeleteLocal: 0,
            toDeleteRemote: 0,
            conflicts: 0,
            skipped: 10,
          },
        },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 2,
          downloaded: 1,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        mode: 'two_way',
        ignorePatterns: ['*.log', 'node_modules/**', '.git/**'],
      });

      expect(result.success).toBe(true);
      expect(client.syncDirectory).toHaveBeenCalledWith({
        localPath: '/tmp/sync',
        mode: 'two_way',
        ignorePatterns: ['*.log', 'node_modules/**', '.git/**'],
      });
    });

    it('syncs directory with dry run enabled', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [],
          summary: {
            toUpload: 3,
            toDownload: 2,
            toDeleteLocal: 1,
            toDeleteRemote: 1,
            conflicts: 0,
            skipped: 5,
          },
        },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 0,
          downloaded: 0,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        mode: 'two_way',
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect((result.data as SyncResult)?.summary.uploaded).toBe(0);
      expect((result.data as SyncResult)?.summary.downloaded).toBe(0);
      expect((result.data as SyncResult)?.plan.summary.toUpload).toBe(3);
      expect((result.data as SyncResult)?.plan.summary.toDownload).toBe(2);
    });

    it('syncs directory with conflicts detected', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [],
          summary: {
            toUpload: 0,
            toDownload: 0,
            toDeleteLocal: 0,
            toDeleteRemote: 0,
            conflicts: 2,
            skipped: 3,
          },
        },
        executed: [],
        conflicts: ['file1.txt', 'file2.txt'],
        errors: [],
        summary: {
          uploaded: 0,
          downloaded: 0,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 2,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        mode: 'two_way',
      });

      expect(result.success).toBe(true);
      expect((result.data as SyncResult)?.summary.conflicts).toBe(2);
      expect((result.data as SyncResult)?.conflicts).toEqual(['file1.txt', 'file2.txt']);
    });

    it('syncs directory with errors', async () => {
      const client = createMockClient();
      const syncResult = {
        success: false,
        plan: {
          operations: [],
          summary: {
            toUpload: 5,
            toDownload: 0,
            toDeleteLocal: 0,
            toDeleteRemote: 0,
            conflicts: 0,
            skipped: 0,
          },
        },
        executed: [],
        conflicts: [],
        errors: [
          { path: 'file1.txt', error: 'Permission denied' },
          { path: 'file2.txt', error: 'Network timeout' },
        ],
        summary: {
          uploaded: 3,
          downloaded: 0,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 2,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        mode: 'push',
      });

      expect(result.success).toBe(true);
      expect((result.data as SyncResult)?.success).toBe(false);
      expect((result.data as SyncResult)?.summary.failed).toBe(2);
      expect((result.data as SyncResult)?.errors).toHaveLength(2);
    });

    it('syncs directory with all parameters', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [],
          summary: {
            toUpload: 2,
            toDownload: 1,
            toDeleteLocal: 1,
            toDeleteRemote: 0,
            conflicts: 0,
            skipped: 3,
          },
        },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 2,
          downloaded: 1,
          deletedLocal: 1,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        sharepointPath: 'docs/project',
        mode: 'two_way',
        delete: true,
        ignorePatterns: ['*.tmp', '.DS_Store'],
        dryRun: false,
      });

      expect(result.success).toBe(true);
      expect(client.syncDirectory).toHaveBeenCalledWith({
        localPath: '/tmp/sync',
        sharepointPath: 'docs/project',
        mode: 'two_way',
        delete: true,
        ignorePatterns: ['*.tmp', '.DS_Store'],
        dryRun: false,
      });
    });

    it('returns error when sync fails', async () => {
      const client = createMockClient();
      client.syncDirectory.mockRejectedValue(new Error('Sync failed'));

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        mode: 'two_way',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'SYNC_DIR_FAILED',
        message: 'Sync failed',
      });
    });

    it('returns error for invalid local path', async () => {
      const client = createMockClient();
      client.syncDirectory.mockRejectedValue(
        new Error('Invalid local_path: must be /home/speedwave/.claude/context or subdirectory')
      );

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/etc/passwd',
        mode: 'two_way',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SYNC_DIR_FAILED');
    });

    it('returns error for network failure', async () => {
      const client = createMockClient();
      client.syncDirectory.mockRejectedValue(new Error('Network error'));

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        mode: 'pull',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SYNC_DIR_FAILED');
    });

    it('returns error for authentication failure', async () => {
      const client = createMockClient();
      client.syncDirectory.mockRejectedValue(new Error('401 Unauthorized'));

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        mode: 'two_way',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SYNC_DIR_FAILED');
    });

    it('returns error for permission denied', async () => {
      const client = createMockClient();
      client.syncDirectory.mockRejectedValue(new Error('403 Forbidden'));

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/sync',
        mode: 'push',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SYNC_DIR_FAILED');
    });

    it('handles empty directory sync', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [],
          summary: {
            toUpload: 0,
            toDownload: 0,
            toDeleteLocal: 0,
            toDeleteRemote: 0,
            conflicts: 0,
            skipped: 0,
          },
        },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 0,
          downloaded: 0,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/tmp/empty',
        mode: 'two_way',
      });

      expect(result.success).toBe(true);
      expect((result.data as SyncResult)?.summary.uploaded).toBe(0);
      expect((result.data as SyncResult)?.summary.downloaded).toBe(0);
    });

    it('handles push to non-existent SharePoint folder (404 returns empty list)', async () => {
      // When SharePoint folder doesn't exist, listFiles returns [] (not error)
      // This enables push mode to create new folders
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [
            { action: 'upload', path: 'file1.txt', reason: 'new file' },
            { action: 'upload', path: 'file2.txt', reason: 'new file' },
          ],
          summary: {
            toUpload: 2,
            toDownload: 0,
            toDeleteLocal: 0,
            toDeleteRemote: 0,
            conflicts: 0,
            skipped: 0,
          },
        },
        executed: [
          { action: 'upload', path: 'file1.txt', reason: 'new file' },
          { action: 'upload', path: 'file2.txt', reason: 'new file' },
        ],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 2,
          downloaded: 0,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        localPath: '/context/opportunities/new-client',
        mode: 'push',
      });

      expect(result.success).toBe(true);
      expect((result.data as SyncResult)?.summary.uploaded).toBe(2);
      expect((result.data as SyncResult)?.plan.summary.toUpload).toBe(2);
    });

    it('auto-calculates sharepointPath from localPath when not provided', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [],
          summary: {
            toUpload: 1,
            toDownload: 0,
            toDeleteLocal: 0,
            toDeleteRemote: 0,
            conflicts: 0,
            skipped: 0,
          },
        },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 1,
          downloaded: 0,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        local_path: '/home/speedwave/.claude/context/opportunities/MASŁO',
        mode: 'push',
      });

      expect(result.success).toBe(true);
      expect(client.syncDirectory).toHaveBeenCalledWith({
        localPath: '/home/speedwave/.claude/context/opportunities/MASŁO',
        mode: 'push',
      });
    });

    it('uses explicit sharepointPath when provided', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [],
          summary: {
            toUpload: 2,
            toDownload: 1,
            toDeleteLocal: 0,
            toDeleteRemote: 0,
            conflicts: 0,
            skipped: 0,
          },
        },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 2,
          downloaded: 1,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        local_path: '/home/speedwave/.claude/context/opportunities/MASŁO',
        sharepoint_path: 'context',
        mode: 'two_way',
      });

      expect(result.success).toBe(true);
      expect(client.syncDirectory).toHaveBeenCalledWith({
        localPath: '/home/speedwave/.claude/context/opportunities/MASŁO',
        sharepointPath: 'context',
        mode: 'two_way',
      });
    });

    it('uses context for root localPath', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: {
          operations: [],
          summary: {
            toUpload: 5,
            toDownload: 3,
            toDeleteLocal: 0,
            toDeleteRemote: 0,
            conflicts: 0,
            skipped: 10,
          },
        },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 5,
          downloaded: 3,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        local_path: '/home/speedwave/.claude/context',
        mode: 'two_way',
      });

      expect(result.success).toBe(true);
      expect(client.syncDirectory).toHaveBeenCalledWith({
        localPath: '/home/speedwave/.claude/context',
        mode: 'two_way',
      });
    });

    it('returns MISSING_PARAM when localPath is missing', async () => {
      const client = createMockClient();

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        mode: 'push',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAM');
      expect(result.error?.message).toContain('localPath');
    });

    it('returns MISSING_PARAM when mode is missing', async () => {
      const client = createMockClient();

      const result = await handleSyncDirectory(client as unknown as SharePointClient, {
        local_path: '/home/speedwave/.claude/context/opportunities/MASŁO',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAM');
      expect(result.error?.message).toContain('mode');
    });
  });

  describe('sharepointPath auto-calculation (regression tests for recursive nesting bug)', () => {
    // Bug: When localPath points to subfolder like /context/opportunities/MASŁO
    // but sharepointPath defaults to 'context', paths don't match and files
    // get downloaded into nested directories like MASŁO/opportunities/MASŁO/

    it('passes through sharepointPath when not provided (auto-calculated in client)', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: { operations: [], summary: { toUpload: 0, toDownload: 0 } },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 0,
          downloaded: 0,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      // When user calls sync with only localPath (no sharepointPath), the handler
      // should pass undefined sharepointPath to client, which will auto-calculate it
      await handleSyncDirectory(client as unknown as SharePointClient, {
        local_path: '/home/speedwave/.claude/context/opportunities/MASŁO',
        mode: 'push',
      });

      // Handler passes normalized params to client - sharepointPath should be undefined
      // so that client.syncDirectory can auto-calculate it from localPath
      expect(client.syncDirectory).toHaveBeenCalledWith({
        localPath: '/home/speedwave/.claude/context/opportunities/MASŁO',
        sharepointPath: undefined,
        mode: 'push',
      });
    });

    it('preserves explicit sharepointPath when provided', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: { operations: [], summary: { toUpload: 0, toDownload: 0 } },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 0,
          downloaded: 0,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      await handleSyncDirectory(client as unknown as SharePointClient, {
        local_path: '/home/speedwave/.claude/context/opportunities/MASŁO',
        sharepoint_path: 'context/opportunities/MASŁO',
        mode: 'push',
      });

      expect(client.syncDirectory).toHaveBeenCalledWith({
        localPath: '/home/speedwave/.claude/context/opportunities/MASŁO',
        sharepointPath: 'context/opportunities/MASŁO',
        mode: 'push',
      });
    });

    it('handles root context path without sharepointPath', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        plan: { operations: [], summary: { toUpload: 0, toDownload: 0 } },
        executed: [],
        conflicts: [],
        errors: [],
        summary: {
          uploaded: 0,
          downloaded: 0,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          failed: 0,
        },
      };
      client.syncDirectory.mockResolvedValue(syncResult);

      await handleSyncDirectory(client as unknown as SharePointClient, {
        local_path: '/home/speedwave/.claude/context',
        mode: 'two_way',
      });

      // sharepointPath should be undefined, client will auto-calculate to 'context'
      expect(client.syncDirectory).toHaveBeenCalledWith({
        localPath: '/home/speedwave/.claude/context',
        sharepointPath: undefined,
        mode: 'two_way',
      });
    });
  });
});
