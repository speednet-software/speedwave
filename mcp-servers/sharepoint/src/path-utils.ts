/**
 * Path Utilities Module - Common path manipulation functions
 * @module sharepoint/path-utils
 */

import { SYNC_STATE_FILENAME } from './sync-state.js';

/**
 * Result of splitting a path into parent directory and name
 * @interface SplitPathResult
 */
export interface SplitPathResult {
  /** Parent directory path */
  parentDir: string;
  /** File or folder name */
  name: string;
}

/**
 * Split a path into parent directory and name
 * @param {string} fullPath - Full path to split
 * @returns {SplitPathResult} Parent directory and name
 */
export function splitPath(fullPath: string): SplitPathResult {
  const parts = fullPath.split('/');
  const name = parts.pop() || '';
  return { parentDir: parts.join('/'), name };
}

/** List of protected files that should never be uploaded to SharePoint */
export const PROTECTED_FILES = [SYNC_STATE_FILENAME];

/**
 * Validate that a file is not protected (internal metadata)
 * @param {string} sharepointPath - SharePoint path to validate
 * @param {string} operation - Operation being performed (upload/download/delete)
 * @throws {Error} If file is protected
 */
export function validateNotProtectedFile(
  sharepointPath: string,
  operation: 'upload' | 'download' | 'delete'
): void {
  const filename = sharepointPath.split('/').pop() || '';
  if (PROTECTED_FILES.includes(filename)) {
    throw new Error(`Cannot ${operation} ${filename} to SharePoint (internal metadata)`);
  }
}

/**
 * Parse error message from Graph API response
 * @param {Response} response - Fetch response object
 * @param {string} defaultMessage - Default message if parsing fails
 * @returns {Promise<string>} Error message
 */
export async function parseGraphErrorMessage(
  response: Response,
  defaultMessage: string
): Promise<string> {
  try {
    const text = await response.text();
    if (!text) {
      return defaultMessage;
    }
    try {
      const data = JSON.parse(text) as { error?: { message?: string } };
      return data.error?.message || defaultMessage;
    } catch {
      // JSON parsing failed, return raw text
      return text;
    }
  } catch {
    return defaultMessage;
  }
}
