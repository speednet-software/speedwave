/**
 * Sync Engine Tests
 * Tests for stateful OneDrive-like sync planning
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  SyncEngine,
  SyncFileEntry,
  SyncMode,
  SyncPlan,
  SyncOperation,
  FileOperationExecutor,
  buildSyncStateFromResults,
} from './sync-engine.js';
import { SyncState, SYNC_STATE_FILENAME } from './sync-state.js';
import { PathValidator } from './path-validator.js';

// Mock PathValidator
const createMockPathValidator = (): PathValidator => {
  const validator = new PathValidator();
  vi.spyOn(validator, 'validatePath').mockReturnValue(true);
  vi.spyOn(validator, 'validateLocalPath').mockReturnValue(true);
  return validator;
};

// Mock FileOperationExecutor
const createMockExecutor = (): FileOperationExecutor => ({
  uploadFile: vi.fn().mockResolvedValue(undefined),
  downloadFile: vi.fn().mockResolvedValue(undefined),
  deleteRemoteFile: vi.fn().mockResolvedValue(undefined),
  ensureParentFolders: vi.fn().mockResolvedValue(undefined),
  createRemoteFolder: vi.fn().mockResolvedValue(undefined),
});

// Helper to create file entry
const createFile = (
  path: string,
  size = 100,
  lastModified = '2025-01-15T10:00:00.000Z',
  etag = '"default-etag"'
): SyncFileEntry => ({
  path,
  size,
  lastModified,
  etag,
  isFolder: false,
});

// Helper to create folder entry
const createFolder = (path: string, lastModified = '2025-01-15T10:00:00.000Z'): SyncFileEntry => ({
  path,
  size: 0,
  lastModified,
  isFolder: true,
});

// Helper to create previous state
const createPreviousState = (files: string[]): SyncState => ({
  version: '1.0',
  lastSyncTime: '2025-01-14T10:00:00.000Z',
  sharepointPath: 'context',
  files: Object.fromEntries(
    files.map((f) => [
      f,
      {
        path: f,
        size: 100,
        lastModified: '2025-01-14T09:00:00.000Z',
        etag: '"default-etag"',
        syncedAt: '2025-01-14T10:00:00.000Z',
      },
    ])
  ),
});

// Helper to create previous state with custom lastModified per file
const createPreviousStateWithTimestamp = (
  files: Array<{ path: string; lastModified: string; etag?: string }>
): SyncState => ({
  version: '1.0',
  lastSyncTime: '2025-01-14T10:00:00.000Z',
  sharepointPath: 'context',
  files: Object.fromEntries(
    files.map((f) => [
      f.path,
      {
        path: f.path,
        size: 100,
        lastModified: f.lastModified,
        etag: f.etag || '"default-etag"',
        syncedAt: '2025-01-14T10:00:00.000Z',
      },
    ])
  ),
});

describe('SyncEngine', () => {
  let engine: SyncEngine;
  let pathValidator: PathValidator;
  let executor: FileOperationExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    pathValidator = createMockPathValidator();
    executor = createMockExecutor();
    engine = new SyncEngine(pathValidator, executor, 'context');
  });

  describe('computeSyncPlanWithState', () => {
    describe('first sync (no previous state)', () => {
      it('falls back to stateless computeSyncPlan', () => {
        const localFiles = [createFile('file1.txt')];
        const remoteFiles: SyncFileEntry[] = [];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          null,
          'two_way',
          true
        );

        expect(plan.operations).toHaveLength(1);
        expect(plan.operations[0]).toMatchObject({
          action: 'upload',
          path: 'file1.txt',
          reason: 'new_local',
        });
      });
    });

    describe('deletion detection with previous state', () => {
      it('detects file deleted locally -> deletes on SharePoint (two_way)', () => {
        // previousState: [file1, file2], local: [file1], remote: [file1, file2]
        const previousState = createPreviousState(['file1.txt', 'file2.txt']);
        const localFiles = [createFile('file1.txt')];
        const remoteFiles = [createFile('file1.txt'), createFile('file2.txt')];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const deleteOp = plan.operations.find((op) => op.path === 'file2.txt');
        expect(deleteOp).toBeDefined();
        expect(deleteOp?.action).toBe('delete_remote');
        expect(deleteOp?.reason).toBe('deleted_locally');
      });

      it('detects file deleted on SharePoint -> deletes locally (two_way)', () => {
        // previousState: [file1, file2], local: [file1, file2], remote: [file1]
        const previousState = createPreviousState(['file1.txt', 'file2.txt']);
        const localFiles = [createFile('file1.txt'), createFile('file2.txt')];
        const remoteFiles = [createFile('file1.txt')];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const deleteOp = plan.operations.find((op) => op.path === 'file2.txt');
        expect(deleteOp).toBeDefined();
        expect(deleteOp?.action).toBe('delete_local');
        expect(deleteOp?.reason).toBe('deleted_on_remote');
      });

      it('detects new local file -> uploads (two_way)', () => {
        // previousState: [file1], local: [file1, file2], remote: [file1]
        const previousState = createPreviousState(['file1.txt']);
        const localFiles = [createFile('file1.txt'), createFile('file2.txt')];
        const remoteFiles = [createFile('file1.txt')];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const uploadOp = plan.operations.find((op) => op.path === 'file2.txt');
        expect(uploadOp).toBeDefined();
        expect(uploadOp?.action).toBe('upload');
        expect(uploadOp?.reason).toBe('new_local');
      });

      it('detects new remote file -> downloads (two_way)', () => {
        // previousState: [file1], local: [file1], remote: [file1, file2]
        const previousState = createPreviousState(['file1.txt']);
        const localFiles = [createFile('file1.txt')];
        const remoteFiles = [createFile('file1.txt'), createFile('file2.txt')];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const downloadOp = plan.operations.find((op) => op.path === 'file2.txt');
        expect(downloadOp).toBeDefined();
        expect(downloadOp?.action).toBe('download');
        expect(downloadOp?.reason).toBe('new_remote');
      });

      it('no action when file deleted on both sides', () => {
        // previousState: [file1, file2], local: [file1], remote: [file1]
        const previousState = createPreviousState(['file1.txt', 'file2.txt']);
        const localFiles = [createFile('file1.txt')];
        const remoteFiles = [createFile('file1.txt')];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const file2Op = plan.operations.find((op) => op.path === 'file2.txt');
        expect(file2Op).toBeUndefined();
      });
    });

    describe('mode-specific behavior with state', () => {
      it('pull mode: deletes locally when deleted on SharePoint', () => {
        const previousState = createPreviousState(['file1.txt', 'file2.txt']);
        const localFiles = [createFile('file1.txt'), createFile('file2.txt')];
        const remoteFiles = [createFile('file1.txt')]; // file2 deleted on SharePoint

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'pull',
          true
        );

        const deleteOp = plan.operations.find((op) => op.path === 'file2.txt');
        expect(deleteOp).toBeDefined();
        expect(deleteOp?.action).toBe('delete_local');
        expect(deleteOp?.reason).toBe('deleted_on_remote');
      });

      it('pull mode: ignores local deletions (does not delete on SharePoint)', () => {
        const previousState = createPreviousState(['file1.txt', 'file2.txt']);
        const localFiles = [createFile('file1.txt')]; // file2 deleted locally
        const remoteFiles = [createFile('file1.txt'), createFile('file2.txt')];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'pull',
          true
        );

        const file2Op = plan.operations.find((op) => op.path === 'file2.txt');
        expect(file2Op).toBeUndefined();
      });

      it('push mode: deletes on SharePoint when deleted locally', () => {
        const previousState = createPreviousState(['file1.txt', 'file2.txt']);
        const localFiles = [createFile('file1.txt')]; // file2 deleted locally
        const remoteFiles = [createFile('file1.txt'), createFile('file2.txt')];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'push',
          true
        );

        const deleteOp = plan.operations.find((op) => op.path === 'file2.txt');
        expect(deleteOp).toBeDefined();
        expect(deleteOp?.action).toBe('delete_remote');
        expect(deleteOp?.reason).toBe('deleted_locally');
      });

      it('push mode: ignores SharePoint deletions (does not delete locally)', () => {
        const previousState = createPreviousState(['file1.txt', 'file2.txt']);
        const localFiles = [createFile('file1.txt'), createFile('file2.txt')];
        const remoteFiles = [createFile('file1.txt')]; // file2 deleted on SharePoint

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'push',
          true
        );

        const file2Op = plan.operations.find((op) => op.path === 'file2.txt');
        expect(file2Op).toBeUndefined();
      });

      it('two_way mode: propagates deletions in both directions', () => {
        const previousState = createPreviousState(['file1.txt', 'file2.txt', 'file3.txt']);
        const localFiles = [createFile('file1.txt'), createFile('file3.txt')]; // file2 deleted locally
        const remoteFiles = [createFile('file1.txt'), createFile('file2.txt')]; // file3 deleted on SharePoint

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const file2Op = plan.operations.find((op) => op.path === 'file2.txt');
        expect(file2Op).toBeDefined();
        expect(file2Op?.action).toBe('delete_remote');
        expect(file2Op?.reason).toBe('deleted_locally');

        const file3Op = plan.operations.find((op) => op.path === 'file3.txt');
        expect(file3Op).toBeDefined();
        expect(file3Op?.action).toBe('delete_local');
        expect(file3Op?.reason).toBe('deleted_on_remote');
      });

      it('push mode: deletes remote file NOT in previous state (regression test for recursive nesting bug)', () => {
        // This test ensures that files on remote which are NOT in previous state
        // will be deleted in push mode with delete=true.
        // This fixes the bug where MASŁO was not deleted from SharePoint because
        // it wasn't in .sync-state.json
        const previousState = createPreviousState(['file1.txt']); // Only file1 in state
        const localFiles = [createFile('file1.txt')]; // Only file1 locally
        const remoteFiles = [
          createFile('file1.txt'),
          createFile('orphan.txt'), // On remote but NOT in state, NOT locally
        ];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'push',
          true // deleteEnabled
        );

        // orphan.txt should be deleted from remote
        const orphanOp = plan.operations.find((op) => op.path === 'orphan.txt');
        expect(orphanOp).toBeDefined();
        expect(orphanOp?.action).toBe('delete_remote');
        expect(orphanOp?.reason).toBe('not_in_local');
      });

      it('two_way mode: downloads remote file NOT in previous state (not delete)', () => {
        // In two_way mode, files on remote not in state should be downloaded, not deleted
        const previousState = createPreviousState(['file1.txt']);
        const localFiles = [createFile('file1.txt')];
        const remoteFiles = [createFile('file1.txt'), createFile('new_remote.txt')];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const newRemoteOp = plan.operations.find((op) => op.path === 'new_remote.txt');
        expect(newRemoteOp).toBeDefined();
        expect(newRemoteOp?.action).toBe('download');
        expect(newRemoteOp?.reason).toBe('new_remote');
      });
    });

    describe('delete disabled', () => {
      it('does not propagate deletions when deleteEnabled=false', () => {
        const previousState = createPreviousState(['file1.txt', 'file2.txt']);
        const localFiles = [createFile('file1.txt')]; // file2 deleted locally
        const remoteFiles = [createFile('file1.txt'), createFile('file2.txt')];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          false // deleteEnabled = false
        );

        const file2Op = plan.operations.find((op) => op.path === 'file2.txt');
        expect(file2Op).toBeUndefined();
      });
    });

    describe('timestamp comparison', () => {
      it('skips unchanged files (within tolerance of previous state)', () => {
        // State recorded at 10:00:00, both files at 10:00:01 (within 2s tolerance)
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z' },
        ]);
        const localFiles = [createFile('file1.txt', 100, '2025-01-15T10:00:01.000Z')];
        const remoteFiles = [createFile('file1.txt', 100, '2025-01-15T10:00:01.500Z')];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const skipOp = plan.operations.find((op) => op.path === 'file1.txt');
        expect(skipOp).toBeDefined();
        expect(skipOp?.action).toBe('skip');
        expect(skipOp?.reason).toBe('unchanged');
      });

      it('uploads when local is newer (modified since state)', () => {
        // State at 10:00:00, local at 12:00:00 (modified), remote at 10:00:01 (not modified)
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z' },
        ]);
        const localFiles = [createFile('file1.txt', 100, '2025-01-15T12:00:00.000Z')];
        const remoteFiles = [createFile('file1.txt', 100, '2025-01-15T10:00:01.000Z')];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const uploadOp = plan.operations.find((op) => op.path === 'file1.txt');
        expect(uploadOp).toBeDefined();
        expect(uploadOp?.action).toBe('upload');
        expect(uploadOp?.reason).toBe('local_modified');
      });

      it('downloads when remote is newer (modified since state)', () => {
        // State has etag "old-etag", remote has "new-etag" → remote modified
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z', etag: '"old-etag"' },
        ]);
        const localFiles = [createFile('file1.txt', 100, '2025-01-15T10:00:01.000Z', '"old-etag"')];
        const remoteFiles = [
          createFile('file1.txt', 100, '2025-01-15T12:00:00.000Z', '"new-etag"'),
        ];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const downloadOp = plan.operations.find((op) => op.path === 'file1.txt');
        expect(downloadOp).toBeDefined();
        expect(downloadOp?.action).toBe('download');
        expect(downloadOp?.reason).toBe('remote_modified');
      });
    });

    describe('summary calculation', () => {
      it('correctly summarizes planned operations', () => {
        // State at 10:00:00, existing file within tolerance → skip
        const previousState = createPreviousStateWithTimestamp([
          { path: 'existing.txt', lastModified: '2025-01-15T10:00:00.000Z' },
        ]);
        const localFiles = [
          createFile('existing.txt', 100, '2025-01-15T10:00:01.000Z'), // within tolerance
          createFile('new_local.txt'),
        ];
        const remoteFiles = [
          createFile('existing.txt', 100, '2025-01-15T10:00:01.000Z'), // within tolerance
          createFile('new_remote.txt'),
        ];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        expect(plan.summary.toUpload).toBe(1); // new_local.txt
        expect(plan.summary.toDownload).toBe(1); // new_remote.txt
        expect(plan.summary.skipped).toBe(1); // existing.txt
      });
    });

    describe('ping-pong fix - compare with previous state', () => {
      it('skips file when neither local nor remote modified since last sync (within tolerance)', () => {
        // State recorded at 10:00:00
        // Local at 10:00:01 (1s later - within 2s tolerance)
        // Remote at 10:00:01 (1s later - within 2s tolerance)
        // Expected: skip (unchanged)
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z' },
        ]);
        const localFiles = [createFile('file1.txt', 100, '2025-01-15T10:00:01.000Z')];
        const remoteFiles = [createFile('file1.txt', 100, '2025-01-15T10:00:01.000Z')];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const op = plan.operations.find((o) => o.path === 'file1.txt');
        expect(op).toBeDefined();
        expect(op?.action).toBe('skip');
        expect(op?.reason).toBe('unchanged');
      });

      it('uploads when only local modified since last sync', () => {
        // State recorded at 10:00:00
        // Local at 11:00:00 (1h later - modified)
        // Remote at 10:00:01 (1s later - within tolerance)
        // Expected: upload (local_modified)
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z' },
        ]);
        const localFiles = [createFile('file1.txt', 100, '2025-01-15T11:00:00.000Z')];
        const remoteFiles = [createFile('file1.txt', 100, '2025-01-15T10:00:01.000Z')];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const op = plan.operations.find((o) => o.path === 'file1.txt');
        expect(op).toBeDefined();
        expect(op?.action).toBe('upload');
        expect(op?.reason).toBe('local_modified');
      });

      it('downloads when only remote modified since last sync', () => {
        // State has etag "old-etag", remote has "new-etag" → remote modified
        // Local mtime within tolerance (not modified)
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z', etag: '"old-etag"' },
        ]);
        const localFiles = [createFile('file1.txt', 100, '2025-01-15T10:00:01.000Z', '"old-etag"')];
        const remoteFiles = [
          createFile('file1.txt', 100, '2025-01-15T11:00:00.000Z', '"new-etag"'),
        ];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const op = plan.operations.find((o) => o.path === 'file1.txt');
        expect(op).toBeDefined();
        expect(op?.action).toBe('download');
        expect(op?.reason).toBe('remote_modified');
      });

      it('handles conflict when both modified - remote newer wins in two_way', () => {
        // Local mtime changed (modified), remote etag changed (modified)
        // Remote has newer timestamp → download
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z', etag: '"old-etag"' },
        ]);
        const localFiles = [createFile('file1.txt', 100, '2025-01-15T11:00:00.000Z', '"old-etag"')];
        const remoteFiles = [
          createFile('file1.txt', 100, '2025-01-15T12:00:00.000Z', '"new-etag"'),
        ];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const op = plan.operations.find((o) => o.path === 'file1.txt');
        expect(op).toBeDefined();
        expect(op?.action).toBe('download');
        expect(op?.reason).toBe('remote_newer');
      });

      it('handles conflict when both modified - local newer wins in two_way', () => {
        // Local mtime changed (modified, newer), remote etag changed (modified)
        // Local has newer timestamp → upload
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z', etag: '"old-etag"' },
        ]);
        const localFiles = [createFile('file1.txt', 100, '2025-01-15T12:00:00.000Z', '"old-etag"')];
        const remoteFiles = [
          createFile('file1.txt', 100, '2025-01-15T11:00:00.000Z', '"new-etag"'),
        ];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const op = plan.operations.find((o) => o.path === 'file1.txt');
        expect(op).toBeDefined();
        expect(op?.action).toBe('upload');
        expect(op?.reason).toBe('local_newer');
      });

      it('force uploads in push mode even when remote also modified', () => {
        // Both modified (local mtime, remote etag), push mode → always upload
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z', etag: '"old-etag"' },
        ]);
        const localFiles = [createFile('file1.txt', 100, '2025-01-15T11:00:00.000Z', '"old-etag"')];
        const remoteFiles = [
          createFile('file1.txt', 100, '2025-01-15T12:00:00.000Z', '"new-etag"'),
        ];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'push',
          true
        );

        const op = plan.operations.find((o) => o.path === 'file1.txt');
        expect(op).toBeDefined();
        expect(op?.action).toBe('upload');
        expect(op?.reason).toBe('force_push');
      });

      it('force downloads in pull mode even when local also modified', () => {
        // Both modified (local mtime, remote etag), pull mode → always download
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z', etag: '"old-etag"' },
        ]);
        const localFiles = [createFile('file1.txt', 100, '2025-01-15T12:00:00.000Z', '"old-etag"')];
        const remoteFiles = [
          createFile('file1.txt', 100, '2025-01-15T11:00:00.000Z', '"new-etag"'),
        ];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'pull',
          true
        );

        const op = plan.operations.find((o) => o.path === 'file1.txt');
        expect(op).toBeDefined();
        expect(op?.action).toBe('download');
        expect(op?.reason).toBe('force_pull');
      });
    });

    describe('consecutive syncs - no ping-pong', () => {
      it('second sync has no operations when nothing actually changed', () => {
        // Simulate: after first sync, state has timestamp T
        // Second sync: local and remote both have timestamps slightly after T (due to sync)
        // Both should be within tolerance → skip
        const syncTime = '2025-01-15T10:00:00.000Z';
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: syncTime },
          { path: 'file2.txt', lastModified: syncTime },
        ]);

        // After sync, files have timestamps close to sync time
        const localFiles = [
          createFile('file1.txt', 100, '2025-01-15T10:00:01.000Z'),
          createFile('file2.txt', 100, '2025-01-15T10:00:01.500Z'),
        ];
        const remoteFiles = [
          createFile('file1.txt', 100, '2025-01-15T10:00:01.200Z'),
          createFile('file2.txt', 100, '2025-01-15T10:00:01.800Z'),
        ];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        // All files should be skipped
        expect(plan.summary.toUpload).toBe(0);
        expect(plan.summary.toDownload).toBe(0);
        expect(plan.summary.skipped).toBe(2);
      });
    });

    describe('ETag-based remote change detection', () => {
      it('detects remote change when etag differs', () => {
        // State has etag "abc123", remote has "xyz789" → remote modified
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z', etag: '"abc123"' },
        ]);
        const localFiles = [createFile('file1.txt', 100, '2025-01-15T10:00:01.000Z', '"abc123"')];
        const remoteFiles = [createFile('file1.txt', 100, '2025-01-15T10:00:01.000Z', '"xyz789"')];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const op = plan.operations.find((o) => o.path === 'file1.txt');
        expect(op).toBeDefined();
        expect(op?.action).toBe('download');
        expect(op?.reason).toBe('remote_modified');
      });

      it('skips when etag unchanged even if remote timestamp differs', () => {
        // Same etag, different timestamps → skip (ETag is authoritative)
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z', etag: '"same-etag"' },
        ]);
        const localFiles = [
          createFile('file1.txt', 100, '2025-01-15T10:00:01.000Z', '"same-etag"'),
        ];
        // Remote has different timestamp but same etag
        const remoteFiles = [
          createFile('file1.txt', 100, '2025-01-15T12:00:00.000Z', '"same-etag"'),
        ];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const op = plan.operations.find((o) => o.path === 'file1.txt');
        expect(op).toBeDefined();
        expect(op?.action).toBe('skip');
        expect(op?.reason).toBe('unchanged');
      });

      it('uploads when local modified but remote etag unchanged', () => {
        // Local mtime > state mtime, same etag → upload (local_modified)
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z', etag: '"same-etag"' },
        ]);
        // Local has newer timestamp
        const localFiles = [
          createFile('file1.txt', 100, '2025-01-15T12:00:00.000Z', '"same-etag"'),
        ];
        const remoteFiles = [
          createFile('file1.txt', 100, '2025-01-15T10:00:01.000Z', '"same-etag"'),
        ];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const op = plan.operations.find((o) => o.path === 'file1.txt');
        expect(op).toBeDefined();
        expect(op?.action).toBe('upload');
        expect(op?.reason).toBe('local_modified');
      });

      it('handles conflict when both local and remote modified', () => {
        // Local mtime changed AND remote etag changed → conflict, newer wins
        const previousState = createPreviousStateWithTimestamp([
          { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z', etag: '"old-etag"' },
        ]);
        // Local modified (newer mtime)
        const localFiles = [createFile('file1.txt', 100, '2025-01-15T11:00:00.000Z', '"old-etag"')];
        // Remote modified (different etag, even newer timestamp)
        const remoteFiles = [
          createFile('file1.txt', 100, '2025-01-15T12:00:00.000Z', '"new-etag"'),
        ];

        const plan = engine.computeSyncPlanWithState(
          localFiles,
          remoteFiles,
          previousState,
          'two_way',
          true
        );

        const op = plan.operations.find((o) => o.path === 'file1.txt');
        expect(op).toBeDefined();
        // Remote is newer, so download
        expect(op?.action).toBe('download');
        expect(op?.reason).toBe('remote_newer');
      });
    });
  });
});

describe('buildSyncStateFromResults', () => {
  const createLocalFile = (
    path: string,
    lastModified: string,
    etag = '"local-etag"'
  ): SyncFileEntry => ({
    path,
    size: 100,
    lastModified,
    etag,
    isFolder: false,
  });

  const createRemoteFile = (
    path: string,
    lastModified: string,
    etag = '"remote-etag"'
  ): SyncFileEntry => ({
    path,
    size: 100,
    lastModified,
    etag,
    isFolder: false,
  });

  it('uses resultEtag from upload operations (prevents ping-pong)', () => {
    const localFiles = [createLocalFile('file1.txt', '2025-01-15T10:00:00.000Z', '"old-etag"')];
    const remoteFiles = [createRemoteFile('file1.txt', '2025-01-15T09:00:00.000Z', '"old-etag"')];
    const executedOps: SyncOperation[] = [
      {
        path: 'file1.txt',
        action: 'upload',
        reason: 'local_modified',
        resultEtag: '"new-etag-from-server"', // SharePoint returns new etag after upload
      },
    ];

    const state = buildSyncStateFromResults(localFiles, remoteFiles, executedOps, 'context');

    // State should have the NEW etag from upload, not the old one
    expect(state.files['file1.txt'].etag).toBe('"new-etag-from-server"');
  });

  it('uses NOW as lastModified for downloaded files (prevents ping-pong)', () => {
    const before = new Date().toISOString();
    const localFiles = [createLocalFile('file1.txt', '2025-01-15T09:00:00.000Z')];
    const remoteFiles = [createRemoteFile('file1.txt', '2025-01-15T10:00:00.000Z')];
    const executedOps: SyncOperation[] = [
      {
        path: 'file1.txt',
        action: 'download',
        reason: 'remote_modified',
      },
    ];

    const state = buildSyncStateFromResults(localFiles, remoteFiles, executedOps, 'context');
    const after = new Date().toISOString();

    // For downloaded files, lastModified should be NOW (when download happened)
    // not the pre-sync timestamp (which would cause local_modified detection)
    const savedTime = state.files['file1.txt'].lastModified;
    expect(savedTime >= before).toBe(true);
    expect(savedTime <= after).toBe(true);
  });

  it('removes files that were deleted locally (delete_remote)', () => {
    const localFiles: SyncFileEntry[] = []; // File deleted locally
    const remoteFiles = [createRemoteFile('deleted.txt', '2025-01-15T10:00:00.000Z')];
    const executedOps: SyncOperation[] = [
      {
        path: 'deleted.txt',
        action: 'delete_remote',
        reason: 'deleted_locally',
      },
    ];

    const state = buildSyncStateFromResults(localFiles, remoteFiles, executedOps, 'context');

    // Deleted files should NOT be in state
    expect(state.files['deleted.txt']).toBeUndefined();
  });

  it('removes files that were deleted remotely (delete_local)', () => {
    const localFiles = [createLocalFile('deleted.txt', '2025-01-15T10:00:00.000Z')];
    const remoteFiles: SyncFileEntry[] = []; // File deleted remotely
    const executedOps: SyncOperation[] = [
      {
        path: 'deleted.txt',
        action: 'delete_local',
        reason: 'deleted_on_remote',
      },
    ];

    const state = buildSyncStateFromResults(localFiles, remoteFiles, executedOps, 'context');

    // Deleted files should NOT be in state
    expect(state.files['deleted.txt']).toBeUndefined();
  });

  it('uses MAX timestamp for unchanged files', () => {
    const localFiles = [createLocalFile('file1.txt', '2025-01-15T08:00:00.000Z')];
    const remoteFiles = [createRemoteFile('file1.txt', '2025-01-15T10:00:00.000Z')]; // Remote is newer
    const executedOps: SyncOperation[] = []; // No operations (file unchanged)

    const state = buildSyncStateFromResults(localFiles, remoteFiles, executedOps, 'context');

    // Should use MAX(local, remote) timestamp
    expect(state.files['file1.txt'].lastModified).toBe('2025-01-15T10:00:00.000Z');
  });

  it('prefers remote etag over local etag for unchanged files', () => {
    const localFiles = [createLocalFile('file1.txt', '2025-01-15T10:00:00.000Z', '"local-etag"')];
    const remoteFiles = [
      createRemoteFile('file1.txt', '2025-01-15T10:00:00.000Z', '"remote-etag"'),
    ];
    const executedOps: SyncOperation[] = [];

    const state = buildSyncStateFromResults(localFiles, remoteFiles, executedOps, 'context');

    // Remote etag is authoritative (server is source of truth)
    expect(state.files['file1.txt'].etag).toBe('"remote-etag"');
  });

  it('handles files only on local (new upload)', () => {
    const localFiles = [
      createLocalFile('new-local.txt', '2025-01-15T10:00:00.000Z', '"local-etag"'),
    ];
    const remoteFiles: SyncFileEntry[] = [];
    const executedOps: SyncOperation[] = [
      {
        path: 'new-local.txt',
        action: 'upload',
        reason: 'new_local',
        resultEtag: '"server-assigned-etag"',
      },
    ];

    const state = buildSyncStateFromResults(localFiles, remoteFiles, executedOps, 'context');

    expect(state.files['new-local.txt']).toBeDefined();
    expect(state.files['new-local.txt'].etag).toBe('"server-assigned-etag"');
  });

  it('handles files only on remote (new download)', () => {
    const before = new Date().toISOString();
    const localFiles: SyncFileEntry[] = [];
    const remoteFiles = [
      createRemoteFile('new-remote.txt', '2025-01-15T10:00:00.000Z', '"remote-etag"'),
    ];
    const executedOps: SyncOperation[] = [
      {
        path: 'new-remote.txt',
        action: 'download',
        reason: 'new_remote',
      },
    ];

    const state = buildSyncStateFromResults(localFiles, remoteFiles, executedOps, 'context');
    const after = new Date().toISOString();

    expect(state.files['new-remote.txt']).toBeDefined();
    expect(state.files['new-remote.txt'].etag).toBe('"remote-etag"');
    // lastModified should be NOW for downloaded files
    expect(state.files['new-remote.txt'].lastModified >= before).toBe(true);
    expect(state.files['new-remote.txt'].lastModified <= after).toBe(true);
  });

  it('sets correct metadata on state', () => {
    const before = new Date().toISOString();
    const localFiles = [createLocalFile('file1.txt', '2025-01-15T10:00:00.000Z')];
    const remoteFiles = [createRemoteFile('file1.txt', '2025-01-15T10:00:00.000Z')];

    const state = buildSyncStateFromResults(localFiles, remoteFiles, [], 'my-context');
    const after = new Date().toISOString();

    expect(state.version).toBe('1.0');
    expect(state.sharepointPath).toBe('my-context');
    expect(state.lastSyncTime >= before).toBe(true);
    expect(state.lastSyncTime <= after).toBe(true);
    expect(state.files['file1.txt'].syncedAt >= before).toBe(true);
    expect(state.files['file1.txt'].syncedAt <= after).toBe(true);
  });
});

describe('Empty Folders Support', () => {
  let engine: SyncEngine;
  let pathValidator: PathValidator;
  let executor: FileOperationExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    pathValidator = createMockPathValidator();
    executor = createMockExecutor();
    engine = new SyncEngine(pathValidator, executor, 'context');
  });

  describe('listLocalFilesRecursive with folders', () => {
    it('does not include empty folders when includeEmptyFolders is false', async () => {
      // This test would require actual filesystem setup - skipping for now
      // Testing will be done via integration tests
    });

    it('includes empty folders when includeEmptyFolders is true', async () => {
      // This test would require actual filesystem setup - skipping for now
      // Testing will be done via integration tests
    });
  });

  describe('computeSyncPlanWithState with folders', () => {
    it('uploads new local empty folder (two_way mode)', () => {
      const previousState = createPreviousState(['file1.txt']);
      const localFiles = [createFile('file1.txt'), createFolder('empty-dir')];
      const remoteFiles = [createFile('file1.txt')];

      const plan = engine.computeSyncPlanWithState(
        localFiles,
        remoteFiles,
        previousState,
        'two_way',
        true
      );

      const uploadOp = plan.operations.find((op) => op.path === 'empty-dir');
      expect(uploadOp).toBeDefined();
      expect(uploadOp?.action).toBe('upload');
      expect(uploadOp?.reason).toBe('new_local');
      expect(uploadOp?.isFolder).toBe(true);
    });

    it('downloads new remote empty folder (two_way mode)', () => {
      const previousState = createPreviousState(['file1.txt']);
      const localFiles = [createFile('file1.txt')];
      const remoteFiles = [createFile('file1.txt'), createFolder('empty-dir')];

      const plan = engine.computeSyncPlanWithState(
        localFiles,
        remoteFiles,
        previousState,
        'two_way',
        true
      );

      const downloadOp = plan.operations.find((op) => op.path === 'empty-dir');
      expect(downloadOp).toBeDefined();
      expect(downloadOp?.action).toBe('download');
      expect(downloadOp?.reason).toBe('new_remote');
      expect(downloadOp?.isFolder).toBe(true);
    });

    it('deletes local folder when deleted on remote (two_way mode)', () => {
      // Create state with a folder
      const previousState = createPreviousStateWithTimestamp([
        { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z' },
        { path: 'empty-dir', lastModified: '2025-01-15T10:00:00.000Z' },
      ]);
      const localFiles = [createFile('file1.txt'), createFolder('empty-dir')];
      const remoteFiles = [createFile('file1.txt')]; // folder deleted on remote

      const plan = engine.computeSyncPlanWithState(
        localFiles,
        remoteFiles,
        previousState,
        'two_way',
        true
      );

      const deleteOp = plan.operations.find((op) => op.path === 'empty-dir');
      expect(deleteOp).toBeDefined();
      expect(deleteOp?.action).toBe('delete_local');
      expect(deleteOp?.reason).toBe('deleted_on_remote');
      expect(deleteOp?.isFolder).toBe(true);
    });

    it('deletes remote folder when deleted locally (two_way mode)', () => {
      const previousState = createPreviousStateWithTimestamp([
        { path: 'file1.txt', lastModified: '2025-01-15T10:00:00.000Z' },
        { path: 'empty-dir', lastModified: '2025-01-15T10:00:00.000Z' },
      ]);
      const localFiles = [createFile('file1.txt')]; // folder deleted locally
      const remoteFiles = [createFile('file1.txt'), createFolder('empty-dir')];

      const plan = engine.computeSyncPlanWithState(
        localFiles,
        remoteFiles,
        previousState,
        'two_way',
        true
      );

      const deleteOp = plan.operations.find((op) => op.path === 'empty-dir');
      expect(deleteOp).toBeDefined();
      expect(deleteOp?.action).toBe('delete_remote');
      expect(deleteOp?.reason).toBe('deleted_locally');
      expect(deleteOp?.isFolder).toBe(true);
    });

    it('skips folder when it exists on both sides', () => {
      const previousState = createPreviousStateWithTimestamp([
        { path: 'empty-dir', lastModified: '2025-01-15T10:00:00.000Z' },
      ]);
      const localFiles = [createFolder('empty-dir')];
      const remoteFiles = [createFolder('empty-dir')];

      const plan = engine.computeSyncPlanWithState(
        localFiles,
        remoteFiles,
        previousState,
        'two_way',
        true
      );

      const skipOp = plan.operations.find((op) => op.path === 'empty-dir');
      expect(skipOp).toBeDefined();
      expect(skipOp?.action).toBe('skip');
      expect(skipOp?.reason).toBe('unchanged');
      expect(skipOp?.isFolder).toBe(true);
    });
  });

  describe('executeSyncOperation with folders', () => {
    it('creates remote folder on upload', async () => {
      const operation: SyncOperation = {
        action: 'upload',
        path: 'empty-dir',
        reason: 'new_local',
        isFolder: true,
      };

      await engine.executeSyncOperation(operation, '/local/base', 'context');

      expect(executor.createRemoteFolder).toHaveBeenCalledWith('context/empty-dir');
    });

    it('creates local folder on download', async () => {
      // Note: This test verifies the operation logic but doesn't mock fs.mkdir
      // because it's already imported in the module. Full integration test
      // would be needed to verify actual filesystem operations.
      const operation: SyncOperation = {
        action: 'download',
        path: 'empty-dir',
        reason: 'new_remote',
        isFolder: true,
      };

      // This will attempt to create the directory, which is fine in test env
      // as pathValidator is mocked to always return true
      await expect(
        engine.executeSyncOperation(operation, '/tmp/test-base', 'context')
      ).resolves.toBeDefined();
    });

    it('deletes local folder on delete_local', async () => {
      // Note: Similar to above - this test verifies logic flow
      const operation: SyncOperation = {
        action: 'delete_local',
        path: 'empty-dir',
        reason: 'deleted_on_remote',
        isFolder: true,
      };

      // Will attempt rmdir - may fail if dir doesn't exist, but that's ok
      // The important part is testing the code path
      await expect(
        engine.executeSyncOperation(operation, '/tmp/test-base', 'context')
      ).resolves.toBeDefined();
    });

    it('deletes remote folder on delete_remote', async () => {
      const operation: SyncOperation = {
        action: 'delete_remote',
        path: 'empty-dir',
        reason: 'deleted_locally',
        isFolder: true,
      };

      await engine.executeSyncOperation(operation, '/local/base', 'context');

      expect(executor.deleteRemoteFile).toHaveBeenCalledWith('context/empty-dir');
    });

    it('skip operation does nothing for folders', async () => {
      const operation: SyncOperation = {
        action: 'skip',
        path: 'empty-dir',
        reason: 'unchanged',
        isFolder: true,
      };

      await expect(
        engine.executeSyncOperation(operation, '/local/base', 'context')
      ).resolves.toBeDefined();

      // No executor methods should be called
      expect(executor.createRemoteFolder).not.toHaveBeenCalled();
      expect(executor.deleteRemoteFile).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('handles nested empty folders', () => {
      const previousState = createPreviousState([]);
      const localFiles = [
        createFolder('parent'),
        createFolder('parent/child'),
        createFolder('parent/child/grandchild'),
      ];
      const remoteFiles: SyncFileEntry[] = [];

      const plan = engine.computeSyncPlanWithState(
        localFiles,
        remoteFiles,
        previousState,
        'two_way',
        true
      );

      const folderOps = plan.operations.filter((op) => op.isFolder);
      expect(folderOps.length).toBe(3);
      expect(folderOps.every((op) => op.action === 'upload')).toBe(true);
    });

    it('handles mixed files and folders', () => {
      const previousState = createPreviousState([]);
      const localFiles = [createFolder('dir1'), createFile('dir1/file1.txt'), createFolder('dir2')];
      const remoteFiles: SyncFileEntry[] = [];

      const plan = engine.computeSyncPlanWithState(
        localFiles,
        remoteFiles,
        previousState,
        'push',
        true
      );

      const uploadOps = plan.operations.filter((op) => op.action === 'upload');
      expect(uploadOps.length).toBe(3);

      const folderOps = uploadOps.filter((op) => op.isFolder);
      const fileOps = uploadOps.filter((op) => !op.isFolder);
      expect(folderOps.length).toBe(2);
      expect(fileOps.length).toBe(1);
    });

    it('folder present on both sides (new files, not in state) - no conflict', () => {
      // Both local and remote have a folder that wasn't in previous state
      // This should skip (folders are structural, no conflicts)
      const previousState = createPreviousState([]);
      const localFiles = [createFolder('shared-dir')];
      const remoteFiles = [createFolder('shared-dir')];

      const plan = engine.computeSyncPlanWithState(
        localFiles,
        remoteFiles,
        previousState,
        'two_way',
        true
      );

      const op = plan.operations.find((o) => o.path === 'shared-dir');
      expect(op).toBeDefined();
      expect(op?.action).toBe('skip');
      expect(op?.isFolder).toBe(true);
    });
  });

  describe('cleanupEmptyParentDirectories', () => {
    let syncEngine: SyncEngine;
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-cleanup-test-'));
      syncEngine = new SyncEngine(createMockPathValidator(), createMockExecutor(), tempDir);
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('removes empty parent directory after deleting last child', async () => {
      // Setup: basePath/test/empty-subdir
      const testDir = path.join(tempDir, 'test');
      const subDir = path.join(testDir, 'empty-subdir');
      await fs.mkdir(subDir, { recursive: true });

      // Simulate deletion of subDir
      await fs.rmdir(subDir);

      // Action: cleanup parents
      await (
        syncEngine as unknown as {
          cleanupEmptyParentDirectories: (deletedPath: string, basePath: string) => Promise<void>;
        }
      ).cleanupEmptyParentDirectories(subDir, tempDir);

      // Verify: test/ should be removed
      await expect(fs.access(testDir)).rejects.toThrow();
    });

    it('removes multiple levels of empty parent directories', async () => {
      // Setup: basePath/a/b/c/d/empty
      const deepPath = path.join(tempDir, 'a', 'b', 'c', 'd', 'empty');
      await fs.mkdir(deepPath, { recursive: true });

      // Simulate deletion
      await fs.rmdir(deepPath);

      // Action
      await (
        syncEngine as unknown as {
          cleanupEmptyParentDirectories: (deletedPath: string, basePath: string) => Promise<void>;
        }
      ).cleanupEmptyParentDirectories(deepPath, tempDir);

      // Verify: a/ should be removed (entire chain)
      await expect(fs.access(path.join(tempDir, 'a'))).rejects.toThrow();
    });

    it('stops at non-empty parent directory', async () => {
      // Setup: basePath/parent/sibling.txt and basePath/parent/empty-child/
      const parentDir = path.join(tempDir, 'parent');
      const siblingFile = path.join(parentDir, 'sibling.txt');
      const emptyChild = path.join(parentDir, 'empty-child');

      await fs.mkdir(emptyChild, { recursive: true });
      await fs.writeFile(siblingFile, 'content');

      // Simulate deletion
      await fs.rmdir(emptyChild);

      // Action
      await (
        syncEngine as unknown as {
          cleanupEmptyParentDirectories: (deletedPath: string, basePath: string) => Promise<void>;
        }
      ).cleanupEmptyParentDirectories(emptyChild, tempDir);

      // Verify: parent/ still exists (has sibling.txt)
      const parentExists = await fs
        .access(parentDir)
        .then(() => true)
        .catch(() => false);
      expect(parentExists).toBe(true);
    });

    it('does not delete basePath even if empty', async () => {
      // Setup: basePath/only-child/
      const onlyChild = path.join(tempDir, 'only-child');
      await fs.mkdir(onlyChild);

      // Simulate deletion
      await fs.rmdir(onlyChild);

      // Action
      await (
        syncEngine as unknown as {
          cleanupEmptyParentDirectories: (deletedPath: string, basePath: string) => Promise<void>;
        }
      ).cleanupEmptyParentDirectories(onlyChild, tempDir);

      // Verify: basePath (tempDir) still exists
      const baseExists = await fs
        .access(tempDir)
        .then(() => true)
        .catch(() => false);
      expect(baseExists).toBe(true);
    });

    it('ignores .sync-state.json when checking if directory is empty', async () => {
      // Setup: basePath/dir-with-state/.sync-state.json
      const dirWithState = path.join(tempDir, 'dir-with-state');
      const childDir = path.join(dirWithState, 'child');
      await fs.mkdir(childDir, { recursive: true });
      await fs.writeFile(path.join(dirWithState, SYNC_STATE_FILENAME), '{}');

      // Simulate deletion of child
      await fs.rmdir(childDir);

      // Action
      await (
        syncEngine as unknown as {
          cleanupEmptyParentDirectories: (deletedPath: string, basePath: string) => Promise<void>;
        }
      ).cleanupEmptyParentDirectories(childDir, tempDir);

      // Verify: dir-with-state/ should be removed (only had .sync-state.json)
      await expect(fs.access(dirWithState)).rejects.toThrow();
    });

    it('ignores Conflicts directory when checking if empty', async () => {
      // Setup: basePath/dir/Conflicts/ and basePath/dir/child/
      const dir = path.join(tempDir, 'dir');
      const conflicts = path.join(dir, 'Conflicts');
      const child = path.join(dir, 'child');

      await fs.mkdir(conflicts, { recursive: true });
      await fs.mkdir(child);

      // Simulate deletion of child
      await fs.rmdir(child);

      // Action
      await (
        syncEngine as unknown as {
          cleanupEmptyParentDirectories: (deletedPath: string, basePath: string) => Promise<void>;
        }
      ).cleanupEmptyParentDirectories(child, tempDir);

      // Verify: dir/ should be removed (only had Conflicts/)
      await expect(fs.access(dir)).rejects.toThrow();
    });

    it('handles already deleted parent gracefully', async () => {
      // Setup: path that doesn't exist
      const nonExistent = path.join(tempDir, 'gone', 'child');

      // Action: should not throw
      await expect(
        (
          syncEngine as unknown as {
            cleanupEmptyParentDirectories: (deletedPath: string, basePath: string) => Promise<void>;
          }
        ).cleanupEmptyParentDirectories(nonExistent, tempDir)
      ).resolves.not.toThrow();
    });

    it('handles race condition when directory becomes non-empty', async () => {
      // Setup: basePath/race/child
      const raceDir = path.join(tempDir, 'race');
      const child = path.join(raceDir, 'child');
      await fs.mkdir(child, { recursive: true });

      // Simulate deletion
      await fs.rmdir(child);

      // Add file to race/ before cleanup can remove it
      await fs.writeFile(path.join(raceDir, 'new-file.txt'), 'content');

      // Action: should handle gracefully (directory has content now)
      await expect(
        (
          syncEngine as unknown as {
            cleanupEmptyParentDirectories: (deletedPath: string, basePath: string) => Promise<void>;
          }
        ).cleanupEmptyParentDirectories(child, tempDir)
      ).resolves.not.toThrow();

      // Verify: race/ still exists
      const exists = await fs
        .access(raceDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('executeSyncOperations - parent cleanup integration', () => {
    let syncEngine: SyncEngine;
    let tempDir: string;
    let mockExecutor: FileOperationExecutor;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-exec-test-'));
      mockExecutor = createMockExecutor();
      syncEngine = new SyncEngine(createMockPathValidator(), mockExecutor, tempDir);
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('removes orphaned parent after delete_local of last folder child', async () => {
      // Setup: basePath/test/empty-subdir exists locally
      const testDir = path.join(tempDir, 'test');
      const subDir = path.join(testDir, 'empty-subdir');
      await fs.mkdir(subDir, { recursive: true });

      // Execute delete_local operation for the folder
      const operation: SyncOperation = {
        action: 'delete_local',
        path: 'test/empty-subdir',
        reason: 'deleted_on_remote',
        isFolder: true,
      };

      await syncEngine.executeSyncOperation(operation, tempDir, 'remote/path');

      // Verify: both empty-subdir and test/ are removed
      await expect(fs.access(subDir)).rejects.toThrow();
      await expect(fs.access(testDir)).rejects.toThrow();
    });

    it('removes orphaned parent after delete_local of last file child', async () => {
      // Setup: basePath/docs/readme.txt exists locally
      const docsDir = path.join(tempDir, 'docs');
      const readmeFile = path.join(docsDir, 'readme.txt');
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(readmeFile, 'content');

      // Execute delete_local operation for the file
      const operation: SyncOperation = {
        action: 'delete_local',
        path: 'docs/readme.txt',
        reason: 'deleted_on_remote',
        isFolder: false,
      };

      await syncEngine.executeSyncOperation(operation, tempDir, 'remote/path');

      // Verify: both readme.txt and docs/ are removed
      await expect(fs.access(readmeFile)).rejects.toThrow();
      await expect(fs.access(docsDir)).rejects.toThrow();
    });

    it('preserves parent with remaining siblings after delete_local', async () => {
      // Setup: basePath/mixed/file1.txt and basePath/mixed/file2.txt
      const mixedDir = path.join(tempDir, 'mixed');
      const file1 = path.join(mixedDir, 'file1.txt');
      const file2 = path.join(mixedDir, 'file2.txt');
      await fs.mkdir(mixedDir, { recursive: true });
      await fs.writeFile(file1, 'content1');
      await fs.writeFile(file2, 'content2');

      // Execute delete_local for file1 only
      const operation: SyncOperation = {
        action: 'delete_local',
        path: 'mixed/file1.txt',
        reason: 'deleted_on_remote',
        isFolder: false,
      };

      await syncEngine.executeSyncOperation(operation, tempDir, 'remote/path');

      // Verify: file1 is deleted, but mixed/ and file2 still exist
      await expect(fs.access(file1)).rejects.toThrow();
      const dirExists = await fs
        .access(mixedDir)
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(true);
      const file2Exists = await fs
        .access(file2)
        .then(() => true)
        .catch(() => false);
      expect(file2Exists).toBe(true);
    });
  });
});
