/**
 * Path Validation Module - Security validation for SharePoint and local paths
 * @module sharepoint/path-validator
 */

import path from 'path';
import { minimatch } from 'minimatch';
import { ts } from '../../shared/dist/index.js';

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
   * Translate Claude container path to SharePoint MCP container path
   * Claude uses: /home/speedwave/.claude/context
   * SharePoint MCP has it mounted at: /context
   * @param {string} localPath - Path from Claude container
   * @returns {string} Translated path for SharePoint MCP container
   */
  translatePath(localPath: string): string {
    const claudePrefix = '/home/speedwave/.claude/context';
    const mcpMount = '/context';

    if (localPath.startsWith(claudePrefix)) {
      return localPath.replace(claudePrefix, mcpMount);
    }
    // Already using container path
    if (localPath.startsWith(mcpMount)) {
      return localPath;
    }
    return localPath;
  }

  /**
   * Validate local path for security
   * Accepts paths within /home/speedwave/.claude/context (Claude) or /context (MCP mount)
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

    // Whitelist: /home/speedwave/.claude/context (Claude) OR /context (MCP mount)
    const allowedPrefixes = ['/home/speedwave/.claude/context', '/context'];

    // Must start with one of allowed prefixes (exact match or as directory prefix)
    // Using prefix + '/' to prevent paths like /contextXXX matching /context
    const isAllowed = allowedPrefixes.some(
      (prefix) => resolved === prefix || resolved.startsWith(prefix + '/')
    );
    if (!isAllowed) {
      console.warn(`${ts()} 🔒 Security: Local path validation blocked potential attack:`, {
        attemptedPath: localPath,
        resolvedPath: resolved,
        attackType: 'path_outside_allowed_directory',
        reason: `Path must be within ${allowedPrefixes.join(' or ')}`,
        allowedPrefixes,
      });
      return false;
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

  /**
   * Check if a file path should be ignored based on glob patterns
   * Uses minimatch for full glob support including ** (recursive) patterns
   * Also supports simple directory names (e.g., 'node_modules') which match all files under them
   * @param {string} filePath - Relative file path to check
   * @param {string[]} patterns - Array of glob patterns to match against
   * @returns {boolean} True if file should be ignored, false otherwise
   */
  shouldIgnoreFile(filePath: string, patterns: string[]): boolean {
    if (!patterns || patterns.length === 0) {
      return false;
    }

    // Normalize path separators to forward slashes
    const normalizedPath = filePath.replace(/\\/g, '/');

    for (const pattern of patterns) {
      const normalizedPattern = pattern.replace(/\\/g, '/');

      // Use minimatch for proper glob matching including ** support
      if (minimatch(normalizedPath, normalizedPattern, { dot: true, matchBase: true })) {
        return true;
      }

      // For simple patterns without glob characters, also match as directory prefix
      // This allows 'node_modules' to match 'node_modules/express/index.js'
      if (!normalizedPattern.includes('*') && !normalizedPattern.includes('?')) {
        // Check if path starts with pattern as a directory
        if (
          normalizedPath === normalizedPattern ||
          normalizedPath.startsWith(normalizedPattern + '/')
        ) {
          return true;
        }
      }
    }

    return false;
  }
}
