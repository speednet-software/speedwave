/**
 * Sync Engine Module - Handles directory synchronization logic
 * @module sharepoint/sync-engine
 */

import fs from 'fs/promises';
import path from 'path';
import { ts } from '../../shared/dist/index.js';
import { PathValidator } from './path-validator.js';
import { SyncState, SyncStateEntry, SYNC_STATE_FILENAME } from './sync-state.js';

//═══════════════════════════════════════════════════════════════════════════════
// Types
//═══════════════════════════════════════════════════════════════════════════════

/** Sync mode for directory synchronization */
export type SyncMode = 'two_way' | 'pull' | 'push';

/**
 * Represents a file entry for sync comparison
 * @interface SyncFileEntry
 */
export interface SyncFileEntry {
  /** Relative path from sync root */
  path: string;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp (ISO 8601) */
  lastModified: string;
  /** ETag for CAS (SharePoint only) */
  etag?: string;
  /** Whether this is a folder */
  isFolder: boolean;
}

/**
 * Single operation in sync plan
 * @interface SyncOperation
 */
export interface SyncOperation {
  /** Type of operation */
  action: 'upload' | 'download' | 'delete_local' | 'delete_remote' | 'skip' | 'conflict';
  /** Relative path of the file */
  path: string;
  /** Reason for this operation */
  reason: string;
  /** Whether this is a folder operation */
  isFolder?: boolean;
  /** Local file modification time (for conflicts) */
  localModified?: string;
  /** Remote file modification time (for conflicts) */
  remoteModified?: string;
  /** ETag returned after upload (for state tracking) */
  resultEtag?: string;
}

/**
 * Sync plan computed before execution
 * @interface SyncPlan
 */
export interface SyncPlan {
  /** List of operations to perform */
  operations: SyncOperation[];
  /** Summary statistics */
  summary: {
    toUpload: number;
    toDownload: number;
    toDeleteLocal: number;
    toDeleteRemote: number;
    conflicts: number;
    skipped: number;
  };
}

/**
 * Result of directory sync execution
 * @interface DirectorySyncResult
 */
export interface DirectorySyncResult {
  /** Whether sync completed successfully */
  success: boolean;
  /** The computed plan */
  plan: SyncPlan;
  /** Operations that were executed */
  executed: SyncOperation[];
  /** Paths to conflict copies in Conflicts/ folder */
  conflicts: string[];
  /** Errors encountered during execution */
  errors: Array<{ path: string; error: string }>;
  /** Execution summary */
  summary: {
    uploaded: number;
    downloaded: number;
    deletedLocal: number;
    deletedRemote: number;
    conflicts: number;
    failed: number;
  };
}

/**
 * File operation executor interface - allows dependency injection
 * @interface FileOperationExecutor
 */
export interface FileOperationExecutor {
  uploadFile(sharepointPath: string, localPath: string): Promise<{ etag?: string }>;
  downloadFile(sharepointPath: string, localPath: string): Promise<void>;
  deleteRemoteFile(sharepointPath: string): Promise<void>;
  ensureParentFolders(fullPath: string): Promise<void>;
  createRemoteFolder(sharepointPath: string): Promise<void>;
}

//═══════════════════════════════════════════════════════════════════════════════
// Sync Engine Class
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Handles directory synchronization planning and execution
 * @class SyncEngine
 */
export class SyncEngine {
  private pathValidator: PathValidator;
  private fileOperationExecutor: FileOperationExecutor;
  private basePath: string;

  /**
   * Create a SyncEngine
   * @param {PathValidator} pathValidator - Path validator instance
   * @param {FileOperationExecutor} fileOperationExecutor - File operation executor
   * @param {string} basePath - SharePoint base path
   */
  constructor(
    pathValidator: PathValidator,
    fileOperationExecutor: FileOperationExecutor,
    basePath: string
  ) {
    this.pathValidator = pathValidator;
    this.fileOperationExecutor = fileOperationExecutor;
    this.basePath = basePath;
  }

  /**
   * Compute sync plan by comparing local and remote file lists
   * @param {SyncFileEntry[]} localFiles - Local file entries
   * @param {SyncFileEntry[]} remoteFiles - Remote file entries
   * @param {SyncMode} mode - Sync mode
   * @param {boolean} deleteEnabled - Whether to propagate deletions
   * @returns {SyncPlan} Computed sync plan
   */
  computeSyncPlan(
    localFiles: SyncFileEntry[],
    remoteFiles: SyncFileEntry[],
    mode: SyncMode,
    deleteEnabled: boolean
  ): SyncPlan {
    const operations: SyncOperation[] = [];

    // Build lookup maps
    const localMap = new Map(localFiles.map((f) => [f.path, f]));
    const remoteMap = new Map(remoteFiles.map((f) => [f.path, f]));

    // Get all unique paths
    const allPaths = new Set([...localMap.keys(), ...remoteMap.keys()]);

    for (const filePath of allPaths) {
      const localFile = localMap.get(filePath);
      const remoteFile = remoteMap.get(filePath);

      if (localFile && !remoteFile) {
        // Exists locally only
        if (mode === 'push' || mode === 'two_way') {
          operations.push({ action: 'upload', path: filePath, reason: 'new_local' });
        } else if (mode === 'pull' && deleteEnabled) {
          operations.push({ action: 'delete_local', path: filePath, reason: 'not_in_remote' });
        }
      } else if (!localFile && remoteFile) {
        // Exists remotely only
        if (mode === 'pull' || mode === 'two_way') {
          operations.push({ action: 'download', path: filePath, reason: 'new_remote' });
        } else if (mode === 'push' && deleteEnabled) {
          operations.push({ action: 'delete_remote', path: filePath, reason: 'not_in_local' });
        }
      } else if (localFile && remoteFile) {
        // Exists in both - compare timestamps
        const localTime = new Date(localFile.lastModified).getTime();
        const remoteTime = new Date(remoteFile.lastModified).getTime();

        // Allow 1 second tolerance for timestamp comparison
        const timeDiff = Math.abs(localTime - remoteTime);
        if (timeDiff <= 1000) {
          operations.push({ action: 'skip', path: filePath, reason: 'unchanged' });
        } else if (mode === 'push') {
          operations.push({
            action: 'upload',
            path: filePath,
            reason: 'force_push',
            localModified: localFile.lastModified,
            remoteModified: remoteFile.lastModified,
          });
        } else if (mode === 'pull') {
          operations.push({
            action: 'download',
            path: filePath,
            reason: 'force_pull',
            localModified: localFile.lastModified,
            remoteModified: remoteFile.lastModified,
          });
        } else {
          // two_way mode - detect conflicts or prefer newer
          // Conflict: both files have different sizes AND timestamps are close (within 5 minutes)
          // This suggests both were independently modified
          const CONFLICT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
          const sizeDiffers = localFile.size !== remoteFile.size;
          const timestampsClose = timeDiff <= CONFLICT_THRESHOLD_MS;

          if (sizeDiffers && timestampsClose) {
            // True conflict - both files modified independently
            // Strategy: keep local, copy remote to Conflicts/
            operations.push({
              action: 'conflict',
              path: filePath,
              reason: 'both_modified',
              localModified: localFile.lastModified,
              remoteModified: remoteFile.lastModified,
            });
          } else if (localTime > remoteTime) {
            operations.push({
              action: 'upload',
              path: filePath,
              reason: 'local_newer',
              localModified: localFile.lastModified,
              remoteModified: remoteFile.lastModified,
            });
          } else {
            operations.push({
              action: 'download',
              path: filePath,
              reason: 'remote_newer',
              localModified: localFile.lastModified,
              remoteModified: remoteFile.lastModified,
            });
          }
        }
      }
    }

    // Compute summary
    const summary = this.computeSummary(operations);

    return { operations, summary };
  }

  /**
   * Compute sync plan with previous state for OneDrive-like deletion tracking
   * Uses three-way comparison: local files, remote files, and previous sync state
   * @param {SyncFileEntry[]} localFiles - Local file entries
   * @param {SyncFileEntry[]} remoteFiles - Remote file entries
   * @param {SyncState | null} previousState - Previous sync state (null for first sync)
   * @param {SyncMode} mode - Sync mode
   * @param {boolean} deleteEnabled - Whether to propagate deletions
   * @returns {SyncPlan} Computed sync plan
   */
  computeSyncPlanWithState(
    localFiles: SyncFileEntry[],
    remoteFiles: SyncFileEntry[],
    previousState: SyncState | null,
    mode: SyncMode,
    deleteEnabled: boolean
  ): SyncPlan {
    // First sync (no previous state) - fallback to stateless logic
    if (!previousState) {
      console.log(`${ts()} 📋 First sync (no previous state) - using stateless comparison`);
      return this.computeSyncPlan(localFiles, remoteFiles, mode, deleteEnabled);
    }

    console.log(`${ts()} 📋 Stateful sync - using three-way comparison with previous state`);
    const operations: SyncOperation[] = [];

    // Build lookup maps
    const localMap = new Map(localFiles.map((f) => [f.path, f]));
    const remoteMap = new Map(remoteFiles.map((f) => [f.path, f]));
    const previousMap = previousState.files;

    // Get all unique paths from all three sources
    const allPaths = new Set([
      ...localMap.keys(),
      ...remoteMap.keys(),
      ...Object.keys(previousMap),
    ]);

    for (const filePath of allPaths) {
      const local = localMap.get(filePath);
      const remote = remoteMap.get(filePath);
      const previous = previousMap[filePath];

      const op = this.decideOperationWithState(local, remote, previous, mode, deleteEnabled);
      if (op) {
        operations.push(op);
      }
    }

    // Compute summary
    const summary = this.computeSummary(operations);
    return { operations, summary };
  }

  /**
   * Decide operation for a single file using three-way comparison
   * @param local - Local files
   * @param remote - Remote files
   * @param previous - Previous state
   * @param mode - Sync mode
   * @param deleteEnabled - Delete enabled flag
   * @private
   */
  private decideOperationWithState(
    local: SyncFileEntry | undefined,
    remote: SyncFileEntry | undefined,
    previous: SyncStateEntry | undefined,
    mode: SyncMode,
    deleteEnabled: boolean
  ): SyncOperation | null {
    const inLocal = !!local;
    const inRemote = !!remote;
    const inPrevious = !!previous;

    // CASE 1: File was in previous sync state
    if (inPrevious) {
      if (!inLocal && !inRemote) {
        // Deleted from both sides - nothing to do
        return null;
      }
      if (inLocal && !inRemote) {
        // Was synced before, exists locally, not on remote → DELETED ON SHAREPOINT
        if (deleteEnabled && (mode === 'pull' || mode === 'two_way')) {
          return {
            action: 'delete_local',
            path: local!.path,
            reason: 'deleted_on_remote',
            isFolder: local!.isFolder,
          };
        }
        return null;
      }
      if (!inLocal && inRemote) {
        // Was synced before, not locally, exists on remote → DELETED LOCALLY
        if (deleteEnabled && (mode === 'push' || mode === 'two_way')) {
          return {
            action: 'delete_remote',
            path: remote!.path,
            reason: 'deleted_locally',
            isFolder: remote!.isFolder,
          };
        }
        return null;
      }
      // Both exist → compare with previous state to detect actual changes
      return this.compareWithPreviousState(local!, remote!, previous!, mode);
    }

    // CASE 2: File was NOT in previous sync state (new file)
    if (inLocal && !inRemote) {
      // New local file or folder
      if (mode === 'push' || mode === 'two_way') {
        return {
          action: 'upload',
          path: local!.path,
          reason: 'new_local',
          isFolder: local!.isFolder,
        };
      }
      return null;
    }
    if (!inLocal && inRemote) {
      // File exists only on remote, not locally, not in previous state
      if (mode === 'push' && deleteEnabled) {
        // push mode with delete: remove from remote (not in local = should not exist)
        return {
          action: 'delete_remote',
          path: remote!.path,
          reason: 'not_in_local',
          isFolder: remote!.isFolder,
        };
      }
      if (mode === 'pull' || mode === 'two_way') {
        // pull/two_way: download new remote file
        return {
          action: 'download',
          path: remote!.path,
          reason: 'new_remote',
          isFolder: remote!.isFolder,
        };
      }
      return null;
    }
    if (inLocal && inRemote) {
      // Both new? Compare timestamps
      return this.compareTimestampsForSync(local!, remote!, mode);
    }

    return null;
  }

  /**
   * Compare timestamps and decide sync operation
   * @param local - Local files
   * @param remote - Remote files
   * @param mode - Sync mode
   * @private
   */
  private compareTimestampsForSync(
    local: SyncFileEntry,
    remote: SyncFileEntry,
    mode: SyncMode
  ): SyncOperation {
    // For folders, always skip if both exist (folders are structural, not content-based)
    const folderSkip = this.skipFolderIfBothExist(local, remote);
    if (folderSkip) return folderSkip;

    const localTime = new Date(local.lastModified).getTime();
    const remoteTime = new Date(remote.lastModified).getTime();
    const timeDiff = Math.abs(localTime - remoteTime);

    // Allow 1 second tolerance
    if (timeDiff <= 1000) {
      return { action: 'skip', path: local.path, reason: 'unchanged' };
    }

    if (mode === 'push') {
      return {
        action: 'upload',
        path: local.path,
        reason: 'force_push',
        localModified: local.lastModified,
        remoteModified: remote.lastModified,
      };
    }

    if (mode === 'pull') {
      return {
        action: 'download',
        path: local.path,
        reason: 'force_pull',
        localModified: local.lastModified,
        remoteModified: remote.lastModified,
      };
    }

    // two_way mode - detect conflicts or prefer newer
    const CONFLICT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    const sizeDiffers = local.size !== remote.size;
    const timestampsClose = timeDiff <= CONFLICT_THRESHOLD_MS;

    if (sizeDiffers && timestampsClose) {
      return {
        action: 'conflict',
        path: local.path,
        reason: 'both_modified',
        localModified: local.lastModified,
        remoteModified: remote.lastModified,
      };
    }

    if (localTime > remoteTime) {
      return {
        action: 'upload',
        path: local.path,
        reason: 'local_newer',
        localModified: local.lastModified,
        remoteModified: remote.lastModified,
      };
    }

    return {
      action: 'download',
      path: local.path,
      reason: 'remote_newer',
      localModified: local.lastModified,
      remoteModified: remote.lastModified,
    };
  }

  /**
   * Compare file against previous sync state to detect actual changes.
   * Uses ETag for remote (authoritative) and mtime for local (fast).
   * This fixes the "ping-pong" bug where files would be repeatedly synced.
   * @param local - Local files
   * @param remote - Remote files
   * @param previous - Previous state
   * @param mode - Sync mode
   * @private
   */
  private compareWithPreviousState(
    local: SyncFileEntry,
    remote: SyncFileEntry,
    previous: SyncStateEntry,
    mode: SyncMode
  ): SyncOperation | null {
    // For folders, always skip if both exist (folders are structural, not content-based)
    const folderSkip = this.skipFolderIfBothExist(local, remote);
    if (folderSkip) return folderSkip;

    const TOLERANCE_MS = 2000; // 2 seconds tolerance for local mtime
    const previousTime = new Date(previous.lastModified).getTime();
    const localTime = new Date(local.lastModified).getTime();
    const remoteTime = new Date(remote.lastModified).getTime();

    // Local: use mtime (fast, no hash needed)
    const localModified = localTime > previousTime + TOLERANCE_MS;
    // Remote: use ETag (server is authoritative)
    const remoteModified = remote.etag !== previous.etag;

    // Neither modified since last sync → skip
    if (!localModified && !remoteModified) {
      return { action: 'skip', path: local.path, reason: 'unchanged' };
    }

    // Only local modified
    if (localModified && !remoteModified) {
      if (mode === 'push' || mode === 'two_way') {
        return { action: 'upload', path: local.path, reason: 'local_modified' };
      }
      return null;
    }

    // Only remote modified
    if (!localModified && remoteModified) {
      if (mode === 'pull' || mode === 'two_way') {
        return { action: 'download', path: remote.path, reason: 'remote_modified' };
      }
      return null;
    }

    // Both modified → conflict handling based on mode
    if (mode === 'push') {
      return { action: 'upload', path: local.path, reason: 'force_push' };
    }
    if (mode === 'pull') {
      return { action: 'download', path: remote.path, reason: 'force_pull' };
    }

    // two_way: newer wins
    if (localTime > remoteTime) {
      return { action: 'upload', path: local.path, reason: 'local_newer' };
    }
    return { action: 'download', path: remote.path, reason: 'remote_newer' };
  }

  /**
   * Compute summary statistics from operations
   * @param operations - Sync operations
   * @private
   */
  private computeSummary(operations: SyncOperation[]): SyncPlan['summary'] {
    return {
      toUpload: operations.filter((op) => op.action === 'upload').length,
      toDownload: operations.filter((op) => op.action === 'download').length,
      toDeleteLocal: operations.filter((op) => op.action === 'delete_local').length,
      toDeleteRemote: operations.filter((op) => op.action === 'delete_remote').length,
      conflicts: operations.filter((op) => op.action === 'conflict').length,
      skipped: operations.filter((op) => op.action === 'skip').length,
    };
  }

  /**
   * Check if both entries are folders and return skip operation if so.
   * Folders are structural and don't need content-based sync.
   * @param local - Local file entry
   * @param remote - Remote file entry
   * @returns Skip operation if both are folders, null otherwise
   * @private
   */
  private skipFolderIfBothExist(local: SyncFileEntry, remote: SyncFileEntry): SyncOperation | null {
    if (local.isFolder && remote.isFolder) {
      return { action: 'skip', path: local.path, reason: 'unchanged', isFolder: true };
    }
    return null;
  }

  /**
   * Execute a single sync operation
   * @param {SyncOperation} operation - Operation to execute
   * @param {string} localBasePath - Local base path
   * @param {string} sharepointBasePath - SharePoint base path
   * @returns {Promise<{ etag?: string }>} Result with optional etag from upload
   */
  async executeSyncOperation(
    operation: SyncOperation,
    localBasePath: string,
    sharepointBasePath: string
  ): Promise<{ etag?: string }> {
    // Validate operation.path to prevent path traversal attacks
    if (!this.pathValidator.validatePath(operation.path)) {
      throw new Error(`Invalid operation path (security check failed): ${operation.path}`);
    }

    // Construct paths
    const localFilePath = path.join(localBasePath, operation.path);
    const sharepointFilePath = sharepointBasePath
      ? `${sharepointBasePath}/${operation.path}`
      : operation.path;

    // Validate that resolved local path is within allowed directory
    if (!this.pathValidator.validateLocalPath(localFilePath)) {
      throw new Error(
        `Invalid resolved local path (security check failed): ${localFilePath} must be within /context or /home/speedwave/.claude/context`
      );
    }

    // Execute operation based on action type (unified switch for files and folders)
    switch (operation.action) {
      case 'upload': {
        if (operation.isFolder) {
          // Create remote folder
          await this.fileOperationExecutor.createRemoteFolder(sharepointFilePath);
          return {};
        } else {
          // Upload file using the executor, capture returned etag
          const uploadResult = await this.fileOperationExecutor.uploadFile(
            sharepointFilePath,
            localFilePath
          );
          return { etag: uploadResult.etag };
        }
      }

      case 'download': {
        if (operation.isFolder) {
          // Create local folder
          await fs.mkdir(localFilePath, { recursive: true });
        } else {
          // Download file
          await this.fileOperationExecutor.downloadFile(sharepointFilePath, localFilePath);
        }
        break;
      }

      case 'delete_local': {
        if (operation.isFolder) {
          // Delete local folder (only if empty)
          try {
            await fs.rmdir(localFilePath);
            // After successful deletion, cleanup any empty parent directories
            await this.cleanupEmptyParentDirectories(localFilePath, localBasePath);
          } catch (error) {
            // If folder is not empty, ignore error (it has files that need to be synced)
            if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
              throw error;
            }
            console.log(`${ts()} 📁 Skipped folder deletion (not empty): ${localFilePath}`);
          }
        } else {
          // Delete file
          await fs.unlink(localFilePath);
          // After successful deletion, cleanup any empty parent directories
          await this.cleanupEmptyParentDirectories(localFilePath, localBasePath);
        }
        break;
      }

      case 'delete_remote': {
        // Delete remote file or folder
        await this.fileOperationExecutor.deleteRemoteFile(sharepointFilePath);
        break;
      }

      case 'conflict': {
        if (operation.isFolder) {
          // Folders don't have conflicts
          break;
        }
        // Download remote version to Conflicts folder
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = path.basename(operation.path);
        const conflictPath = path.join(localBasePath, 'Conflicts', `${timestamp}_${fileName}`);
        await this.fileOperationExecutor.downloadFile(sharepointFilePath, conflictPath);
        break;
      }

      case 'skip':
        // No action needed
        break;
    }
    return {};
  }

  /**
   * Check if directory contains only special files (.sync-state.json, Conflicts/)
   * @param {string[]} entries - Directory entries from readdir
   * @returns {boolean} True if directory is effectively empty
   * @private
   */
  private isDirectoryEffectivelyEmpty(entries: string[]): boolean {
    return entries.every((e) => e === SYNC_STATE_FILENAME || e === 'Conflicts');
  }

  /**
   * Recursively cleanup empty parent directories after deleting content.
   * Walks up the directory tree from the deleted path, removing empty directories
   * until reaching basePath or a non-empty directory.
   * @param {string} deletedPath - Full path of the file/folder that was just deleted
   * @param {string} basePath - Root sync directory (stop cleanup here)
   * @private
   */
  private async cleanupEmptyParentDirectories(
    deletedPath: string,
    basePath: string
  ): Promise<void> {
    let parentDir = path.dirname(deletedPath);

    // Walk up the tree until we reach basePath
    while (parentDir.length > basePath.length && parentDir.startsWith(basePath)) {
      try {
        // Check if directory is empty
        const entries = await fs.readdir(parentDir);

        if (this.isDirectoryEffectivelyEmpty(entries)) {
          // Directory is empty (or only has .sync-state.json/Conflicts)
          // Remove special entries first before rmdir
          for (const entry of entries) {
            const entryPath = path.join(parentDir, entry);
            if (entry === SYNC_STATE_FILENAME) {
              // Remove sync state file
              await fs.unlink(entryPath).catch((err) => {
                console.warn(`${ts()} ⚠️  Failed to remove sync state file: ${entryPath}`, {
                  error: err instanceof Error ? err.message : String(err),
                  code: (err as NodeJS.ErrnoException).code,
                });
              });
            } else if (entry === 'Conflicts') {
              // Remove empty Conflicts directory
              await fs.rmdir(entryPath).catch((err) => {
                console.warn(`${ts()} ⚠️  Failed to remove Conflicts directory: ${entryPath}`, {
                  error: err instanceof Error ? err.message : String(err),
                  code: (err as NodeJS.ErrnoException).code,
                });
              });
            }
          }

          // Now remove the parent directory itself
          await fs.rmdir(parentDir);

          // Move up to next parent
          parentDir = path.dirname(parentDir);
        } else {
          // Directory has content - stop cleanup
          break;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // Directory already doesn't exist - continue up
          parentDir = path.dirname(parentDir);
        } else if (code === 'ENOTEMPTY') {
          // Race condition - directory got content - stop
          break;
        } else {
          // Other error - stop (don't throw, cleanup is best-effort)
          console.warn(`${ts()} ⚠️  Unexpected error during cleanup: ${parentDir}`, {
            error: error instanceof Error ? error.message : String(error),
            code,
          });
          break;
        }
      }
    }
  }

  /**
   * List files recursively from local filesystem
   * @param {string} localPath - Local directory path
   * @param {string} basePath - Base path for relative path calculation
   * @param {object} options - Options
   * @param {boolean} options.includeEmptyFolders - Whether to include empty folders
   * @returns {Promise<SyncFileEntry[]>} Array of file entries
   */
  async listLocalFilesRecursive(
    localPath: string,
    basePath: string = localPath,
    options?: { includeEmptyFolders?: boolean }
  ): Promise<SyncFileEntry[]> {
    const files: SyncFileEntry[] = [];
    const includeEmptyFolders = options?.includeEmptyFolders ?? false;

    const processDirectory = async (dirPath: string): Promise<void> => {
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          const relativePath = path.relative(basePath, fullPath);

          // Skip Conflicts directory and sync state file
          if (
            relativePath === SYNC_STATE_FILENAME ||
            relativePath.startsWith('Conflicts/') ||
            relativePath === 'Conflicts'
          ) {
            continue;
          }

          if (entry.isDirectory()) {
            const childrenCountBefore = files.length;
            await processDirectory(fullPath);
            const childrenCountAfter = files.length;

            // Empty directory (no children added) - add it if option enabled
            if (childrenCountAfter === childrenCountBefore && includeEmptyFolders) {
              const stat = await fs.stat(fullPath);
              files.push({
                path: relativePath,
                size: 0,
                lastModified: stat.mtime.toISOString(),
                isFolder: true,
              });
            }
          } else if (entry.isFile()) {
            const stat = await fs.stat(fullPath);
            files.push({
              path: relativePath,
              size: stat.size,
              lastModified: stat.mtime.toISOString(),
              isFolder: false,
            });
          }
        }

        // Note: We don't add the current directory itself as empty
        // because we only track leaf empty directories (those without any children)
      } catch (error) {
        // Directory doesn't exist or not readable - return empty
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(
            `Failed to list files in ${dirPath}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        // Warn about missing directory for visibility
        console.warn(`${ts()} ⚠️  Directory not found: ${dirPath} (will be treated as empty)`);
      }
    };

    await processDirectory(localPath);
    return files;
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Utility Functions
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Build sync state from sync results.
 * Handles etag updates from uploads and mtime updates from downloads.
 * @param localFiles - Local files before sync
 * @param remoteFiles - Remote files before sync
 * @param executedOps - Operations that were executed
 * @param sharepointPath - SharePoint base path
 * @returns New sync state
 */
export function buildSyncStateFromResults(
  localFiles: SyncFileEntry[],
  remoteFiles: SyncFileEntry[],
  executedOps: SyncOperation[],
  sharepointPath: string
): SyncState {
  const files: Record<string, SyncStateEntry> = {};
  const now = new Date().toISOString();

  // Create maps for efficient lookup
  const localMap = new Map(localFiles.map((f) => [f.path, f]));
  const remoteMap = new Map(remoteFiles.map((f) => [f.path, f]));

  // Create map of path → new etag from upload operations
  // After upload, SharePoint returns a new etag - we MUST use this, not the old one
  const uploadEtagMap = new Map<string, string>();
  // Track downloaded files - their local mtime changed to NOW
  const downloadedPaths = new Set<string>();
  for (const op of executedOps) {
    if (op.action === 'upload' && op.resultEtag) {
      uploadEtagMap.set(op.path, op.resultEtag);
    } else if (op.action === 'download') {
      downloadedPaths.add(op.path);
    }
  }

  // Get all unique paths
  const allPaths = new Set([...localMap.keys(), ...remoteMap.keys()]);

  // Add all files that exist after sync with MAX timestamp
  for (const filePath of allPaths) {
    if (!filePath) continue;

    const localFile = localMap.get(filePath);
    const remoteFile = remoteMap.get(filePath);

    // Use MAX(local, remote) timestamp to prevent ping-pong
    const localTime = localFile ? new Date(localFile.lastModified).getTime() : 0;
    const remoteTime = remoteFile ? new Date(remoteFile.lastModified).getTime() : 0;
    const maxTime = Math.max(localTime, remoteTime);
    const file = localFile || remoteFile;

    if (file) {
      // Use new etag from upload if available, otherwise use existing
      const newEtag = uploadEtagMap.get(filePath) || remoteFile?.etag || file.etag;
      // For downloaded files, use NOW as lastModified (local mtime changed during download)
      const effectiveLastModified = downloadedPaths.has(filePath)
        ? now
        : new Date(maxTime).toISOString();
      files[filePath] = {
        path: filePath,
        size: file.size,
        lastModified: effectiveLastModified,
        etag: newEtag,
        syncedAt: now,
        isFolder: file.isFolder,
      };
    }
  }

  // Remove files that were deleted
  for (const op of executedOps) {
    if (op.action === 'delete_local' || op.action === 'delete_remote') {
      delete files[op.path];
    }
  }

  return {
    version: '1.0',
    lastSyncTime: now,
    sharepointPath,
    files,
  };
}
