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
   * Validate SharePoint path: rejects traversal, absolute paths, colons, null bytes, invalid URL
   * encoding, and URL encoding nested more than five levels deep.
   * @param pathStr - path to validate
   * @returns true if the path is safe, false otherwise
   */
  validatePath(pathStr: string): boolean {
    if (!pathStr || typeof pathStr !== 'string') {
      return this.blockPath({
        attemptedPath: pathStr,
        attackType: 'invalid_path_type',
        reason: 'Path is empty or not a string',
      });
    }

    const pathsToCheck = [pathStr];
    let current = pathStr;
    const maxIterations = 5;

    for (let i = 0; i <= maxIterations; i++) {
      try {
        const decoded = decodeURIComponent(current);
        if (decoded === current) break;
        if (i === maxIterations) {
          return this.blockPath({
            attemptedPath: pathStr,
            attackType: 'excessive_url_encoding',
            reason: `Path is URL-encoded more than ${maxIterations} times`,
          });
        }
        pathsToCheck.push(decoded);
        current = decoded;
      } catch {
        return this.blockPath({
          attemptedPath: pathStr,
          attackType: 'invalid_url_encoding',
          reason: 'Path contains invalid URL encoding',
        });
      }
    }

    for (const p of pathsToCheck) {
      const decodedPath = p !== pathStr ? p : undefined;
      if (p.includes('../') || p.includes('..\\')) {
        return this.blockPath({
          attemptedPath: pathStr,
          decodedPath,
          attackType: 'path_traversal',
          reason: 'Path contains traversal sequence (../ or ..\\)',
        });
      }
      if (/(^|[/\\])\.\.([/\\]|$)/.test(p)) {
        return this.blockPath({
          attemptedPath: pathStr,
          decodedPath,
          attackType: 'path_traversal',
          reason: 'Path contains directory traversal pattern (..)',
        });
      }
      if (p.startsWith('/') || p.startsWith('\\')) {
        return this.blockPath({
          attemptedPath: pathStr,
          decodedPath,
          attackType: 'absolute_path',
          reason: 'Absolute paths are not allowed',
        });
      }
      if (p.includes(':')) {
        return this.blockPath({
          attemptedPath: pathStr,
          decodedPath,
          attackType: 'invalid_character',
          reason: 'Path contains a colon (drive letter or Graph path syntax)',
        });
      }
      if (p.indexOf('\0') !== -1) {
        return this.blockPath({
          attemptedPath: pathStr,
          decodedPath,
          attackType: 'null_byte_injection',
          reason: 'Path contains null byte character',
        });
      }
    }

    return true;
  }

  private blockPath(details: {
    attemptedPath: string;
    decodedPath?: string;
    attackType: string;
    reason: string;
  }): false {
    console.warn(`${ts()} 🔒 Security: Path validation blocked potential attack:`, details);
    return false;
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

    const resolved = path.resolve(localPath);

    const allowedPrefix = '/workspace';

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

    for (const denied of DENYLIST) {
      if (denied === '/workspace/.env') {
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
