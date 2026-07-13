/** Path validation for SharePoint and local paths. */

import path from 'path';
import { ts } from '@speedwave/mcp-shared';

/** Denied paths within /workspace; prefix-matched except '/workspace/.env' (exact-match only). */
const DENYLIST: string[] = [
  '/workspace/.git',
  '/workspace/.env',
  '/workspace/.speedwave',
  '/workspace/.ssh',
  '/workspace/.npmrc',
  '/workspace/.docker',
  '/workspace/.kube',
];

/** Validates paths against traversal, absolute paths, null bytes, and URL-encoded attacks. */
export class PathValidator {
  /**
   * Validate SharePoint path: rejects traversal, absolute paths, null bytes, URL-encoded input.
   * @param pathStr - path to validate
   * @returns true if the path is safe, false otherwise
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
   * Validate local path: must be within /workspace and not on the denylist.
   * @param localPath - local path to validate
   * @returns true if the path is safe, false otherwise
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

    return true;
  }
}
