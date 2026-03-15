/**
 * Sync State Module - Persists sync state for OneDrive-like deletion tracking
 * @module sharepoint/sync-state
 */

import fs from 'fs/promises';
import path from 'path';
import { ts } from '@speedwave/mcp-shared';

//═══════════════════════════════════════════════════════════════════════════════
// Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Entry for a single file in the sync state
 * @interface SyncStateEntry
 */
export interface SyncStateEntry {
  /** Relative path from sync root */
  path: string;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp (ISO 8601) */
  lastModified: string;
  /** ETag for CAS (SharePoint only) */
  etag?: string;
  /** When this file was last synced (ISO 8601) */
  syncedAt: string;
  /** Whether this entry represents an empty folder (optional for backward compatibility) */
  isFolder?: boolean;
}

/**
 * Complete sync state manifest
 * @interface SyncState
 */
export interface SyncState {
  /** State file version for migrations */
  version: '1.0';
  /** When the last sync completed (ISO 8601) */
  lastSyncTime: string;
  /** SharePoint path that was synced */
  sharepointPath: string;
  /** Map of file paths to their sync state entries */
  files: Record<string, SyncStateEntry>;
}

//═══════════════════════════════════════════════════════════════════════════════
// Sync State Store
//═══════════════════════════════════════════════════════════════════════════════

/** Name of the sync state file */
export const SYNC_STATE_FILENAME = '.sync-state.json';

/**
 * Handles persistence of sync state to enable OneDrive-like deletion tracking
 * @class SyncStateStore
 */
export class SyncStateStore {
  private statePath: string;

  /**
   * Create a SyncStateStore
   * @param {string} localBasePath - Local directory path for sync
   */
  constructor(localBasePath: string) {
    this.statePath = path.join(localBasePath, SYNC_STATE_FILENAME);
  }

  /**
   * Load previous sync state from disk
   * @returns {Promise<SyncState | null>} Previous state or null if first sync/corrupted
   */
  async load(): Promise<SyncState | null> {
    try {
      const content = await fs.readFile(this.statePath, 'utf-8');
      const state = JSON.parse(content) as SyncState;

      // Validate version
      if (state.version !== '1.0') {
        console.warn(
          `${ts()} ⚠️  Sync state version mismatch (expected 1.0, got ${state.version}). Treating as first sync.`
        );
        return null;
      }

      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist - first sync
        return null;
      }
      // Corrupted JSON or other error
      console.warn(`${ts()} ⚠️  Failed to load sync state: ${error}. Treating as first sync.`);
      return null;
    }
  }

  /**
   * Save sync state to disk
   * @param {SyncState} state - State to persist
   */
  async save(state: SyncState): Promise<void> {
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  /**
   * Get the path to the state file
   * @returns {string} Path to .sync-state.json
   */
  getStatePath(): string {
    return this.statePath;
  }
}
