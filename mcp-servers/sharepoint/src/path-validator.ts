/**
 * Path Validation Module - Security validation for SharePoint and local paths
 * @module sharepoint/path-validator
 */

import path from 'path';
import { ts } from '@speedwave/mcp-shared';

/**
 * Paths that are denied within /workspace to protect sensitive project files.
 * Each entry is matched as a prefix: the path must equal the entry or start with entry + '/'.
 * Exception: '/workspace/.env' is an exact match only (blocks .env but allows .envrc).
 */
const DENYLIST: string[] = [
  '/workspace/.git',
  '/workspace/.env',
  '/workspace/.speedwave',
  '/workspace/.ssh',
  '/workspace/.npmrc',
  '/workspace/.docker',
  '/workspace/.kube',
];

/**
 * Validates paths for security to prevent path traversal attacks and unauthorized access
 * @class PathValidator
 */
export class PathValidator {
  /**
   * Validate SharePoint path (security: prevent traversal)
   * Checks for path traversal attempts, absolute paths, null bytes,
   * and URL-encoded traversal sequences (%2e%2e)
   * @param {string} pathStr - Path to validate
   * @returns {boolean} True if path is safe, false otherwise
   */
  validatePath(pathStr: string): boolean {
    if (!pathStr || typeof pathStr !== 'string') {
      console.warn(`${ts()} 🔒 Security: Path validation blocked potential attack:`, {
        attemptedPath: pathStr,
        attackType: 'invalid_path_type',
        reason: 'Path is empty or not a string',
      });
      return false;
    }

    // Recursively decode URL-encoded characters to catch double/triple encoding
    // e.g., %252e%252e → %2e%2e → ..
    const pathsToCheck = [pathStr];
    let current = pathStr;
    const maxIterations = 5; // Prevent infinite loops

    for (let i = 0; i < maxIterations; i++) {
      try {
        const decoded = decodeURIComponent(current);
        if (decoded === current) break; // No more decoding possible
        pathsToCheck.push(decoded);
        current = decoded;
      } catch {
        // Invalid URL encoding - reject
        console.warn(`${ts()} 🔒 Security: Path validation blocked potential attack:`, {
          attemptedPath: pathStr,
          attackType: 'invalid_url_encoding',
          reason: 'Path contains invalid URL encoding',
        });
        return false;
      }
    }

    // Check all decoded versions for path traversal
    for (const p of pathsToCheck) {
      if (p.includes('../') || p.includes('..\\')) {
        console.warn(`${ts()} 🔒 Security: Path validation blocked potential attack:`, {
          attemptedPath: pathStr,
          decodedPath: p !== pathStr ? p : undefined,
          attackType: 'path_traversal',
          reason: 'Path contains traversal sequence (../ or ..\\)',
        });
        return false;
      }
      // Check for .. at path boundaries (not inside filenames like foo..bar.txt)
      // Pattern matches: ^.. | /.. | \.. | ../ | ..\ | ..$ (end of string)
      if (/(^|[/\\])\.\.([/\\]|$)/.test(p)) {
        console.warn(`${ts()} 🔒 Security: Path validation blocked potential attack:`, {
          attemptedPath: pathStr,
          decodedPath: p !== pathStr ? p : undefined,
          attackType: 'path_traversal',
          reason: 'Path contains directory traversal pattern (..)',
        });
        return false;
      }
      if (p.startsWith('/') || p.startsWith('\\')) {
        console.warn(`${ts()} 🔒 Security: Path validation blocked potential attack:`, {
          attemptedPath: pathStr,
          decodedPath: p !== pathStr ? p : undefined,
          attackType: 'absolute_path',
          reason: 'Absolute paths are not allowed',
        });
        return false;
      }
      if (p.indexOf('\0') !== -1) {
        console.warn(`${ts()} 🔒 Security: Path validation blocked potential attack:`, {
          attemptedPath: pathStr,
          decodedPath: p !== pathStr ? p : undefined,
          attackType: 'null_byte_injection',
          reason: 'Path contains null byte character',
        });
        return false;
      }
    }

    return true;
  }

  /**
   * Validate local path for security.
   * Accepts paths within /workspace only (wide mount).
   * Rejects paths targeting sensitive locations via denylist (.git, .env, .speedwave).
   * Claude and MCP workers share the same mount, so no path translation needed.
   * @param {string} localPath - Local path to validate
   * @returns {boolean} True if path is safe, false otherwise
   */
  validateLocalPath(localPath: string): boolean {
    if (!localPath || typeof localPath !== 'string') {
      console.warn(`${ts()} 🔒 Security: Local path validation blocked potential attack:`, {
        attemptedPath: localPath,
        attackType: 'invalid_path_type',
        reason: 'Path is empty or not a string',
      });
      return false;
    }

    // Resolve to absolute path and normalize
    const resolved = path.resolve(localPath);

    const allowedPrefix = '/workspace';

    // Must start with allowed prefix (exact match or as directory prefix)
    const isAllowed = resolved === allowedPrefix || resolved.startsWith(allowedPrefix + '/');
    if (!isAllowed) {
      console.warn(`${ts()} 🔒 Security: Local path validation blocked potential attack:`, {
        attemptedPath: localPath,
        resolvedPath: resolved,
        attackType: 'path_outside_allowed_directory',
        reason: `Path must be within ${allowedPrefix}`,
      });
      return false;
    }

    // Check denylist: protect sensitive directories/files within /workspace
    for (const denied of DENYLIST) {
      if (denied === '/workspace/.env') {
        // Exact match only: blocks /workspace/.env but allows /workspace/.envrc
        if (resolved === denied) {
          console.warn(`${ts()} 🔒 Security: Local path validation blocked denied path:`, {
            attemptedPath: localPath,
            resolvedPath: resolved,
            attackType: 'denied_path',
            reason: `Path is on the denylist: ${denied}`,
          });
          return false;
        }
      } else {
        // Prefix match: blocks the directory and everything inside it
        if (resolved === denied || resolved.startsWith(denied + '/')) {
          console.warn(`${ts()} 🔒 Security: Local path validation blocked denied path:`, {
            attemptedPath: localPath,
            resolvedPath: resolved,
            attackType: 'denied_path',
            reason: `Path is on the denylist: ${denied}`,
          });
          return false;
        }
      }
    }

    // Additional security: check for path traversal in resolved path
    if (resolved.includes('/../') || resolved.includes('/..')) {
      console.warn(`${ts()} 🔒 Security: Local path validation blocked potential attack:`, {
        attemptedPath: localPath,
        resolvedPath: resolved,
        attackType: 'path_traversal_in_resolved_path',
        reason: 'Resolved path contains traversal sequence',
      });
      return false;
    }

    return true;
  }
}
