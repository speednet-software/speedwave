/**
 * Path Utilities Tests
 * Tests for common path manipulation functions
 */

import { describe, it, expect } from 'vitest';
import {
  splitPath,
  validateNotProtectedFile,
  parseGraphErrorMessage,
  PROTECTED_FILES,
} from './path-utils.js';

describe('path-utils', () => {
  describe('splitPath', () => {
    it('splits path with multiple segments', () => {
      expect(splitPath('a/b/c')).toEqual({ parentDir: 'a/b', name: 'c' });
    });

    it('splits path with two segments', () => {
      expect(splitPath('folder/file.txt')).toEqual({
        parentDir: 'folder',
        name: 'file.txt',
      });
    });

    it('handles single segment', () => {
      expect(splitPath('file.txt')).toEqual({ parentDir: '', name: 'file.txt' });
    });

    it('handles empty string', () => {
      expect(splitPath('')).toEqual({ parentDir: '', name: '' });
    });

    it('handles path with trailing slash', () => {
      expect(splitPath('a/b/c/')).toEqual({ parentDir: 'a/b/c', name: '' });
    });

    it('handles deeply nested path', () => {
      expect(splitPath('a/b/c/d/e/f/file.txt')).toEqual({
        parentDir: 'a/b/c/d/e/f',
        name: 'file.txt',
      });
    });

    it('handles path with spaces', () => {
      expect(splitPath('my folder/my file.txt')).toEqual({
        parentDir: 'my folder',
        name: 'my file.txt',
      });
    });

    it('handles path with special characters', () => {
      expect(splitPath('folder-name/file_name.txt')).toEqual({
        parentDir: 'folder-name',
        name: 'file_name.txt',
      });
    });

    it('handles root level file with slash prefix', () => {
      // Edge case: if input has leading slash
      expect(splitPath('/file.txt')).toEqual({ parentDir: '', name: 'file.txt' });
    });

    it('handles multiple trailing slashes', () => {
      // splitPath preserves intermediate empty segments
      expect(splitPath('a/b///')).toEqual({ parentDir: 'a/b//', name: '' });
    });
  });

  describe('validateNotProtectedFile', () => {
    it('throws for .sync-state.json in upload operation', () => {
      expect(() => validateNotProtectedFile('folder/.sync-state.json', 'upload')).toThrow(
        'Cannot upload .sync-state.json to SharePoint (internal metadata)'
      );
    });

    it('throws for .sync-state.json in delete operation', () => {
      expect(() => validateNotProtectedFile('.sync-state.json', 'delete')).toThrow(
        'Cannot delete .sync-state.json to SharePoint (internal metadata)'
      );
    });

    it('throws for .sync-state.json in download operation', () => {
      expect(() => validateNotProtectedFile('.sync-state.json', 'download')).toThrow(
        'Cannot download .sync-state.json to SharePoint (internal metadata)'
      );
    });

    it('throws for .sync-state.json in nested path', () => {
      expect(() => validateNotProtectedFile('a/b/c/.sync-state.json', 'upload')).toThrow(
        'Cannot upload .sync-state.json to SharePoint (internal metadata)'
      );
    });

    it('allows normal files for upload', () => {
      expect(() => validateNotProtectedFile('folder/data.json', 'upload')).not.toThrow();
    });

    it('allows normal files for download', () => {
      expect(() => validateNotProtectedFile('folder/data.json', 'download')).not.toThrow();
    });

    it('allows normal files for delete', () => {
      expect(() => validateNotProtectedFile('folder/data.json', 'delete')).not.toThrow();
    });

    it('allows files with similar names', () => {
      expect(() => validateNotProtectedFile('sync-state.json', 'upload')).not.toThrow();
      expect(() => validateNotProtectedFile('.sync-state.json.bak', 'upload')).not.toThrow();
      expect(() => validateNotProtectedFile('my.sync-state.json', 'upload')).not.toThrow();
    });

    it('handles root level protected file', () => {
      expect(() => validateNotProtectedFile('.sync-state.json', 'upload')).toThrow(
        'Cannot upload .sync-state.json to SharePoint (internal metadata)'
      );
    });

    it('handles empty path gracefully', () => {
      expect(() => validateNotProtectedFile('', 'upload')).not.toThrow();
    });

    it('handles path with trailing slash', () => {
      // This would extract empty string as filename
      expect(() => validateNotProtectedFile('folder/', 'upload')).not.toThrow();
    });
  });

  describe('parseGraphErrorMessage', () => {
    it('extracts error message from JSON response', async () => {
      const response = new Response(JSON.stringify({ error: { message: 'Test error message' } }));
      const result = await parseGraphErrorMessage(response, 'default');
      expect(result).toBe('Test error message');
    });

    it('returns default message when error object is missing', async () => {
      const response = new Response(JSON.stringify({ data: 'something' }));
      const result = await parseGraphErrorMessage(response, 'default msg');
      expect(result).toBe('default msg');
    });

    it('returns default message when error.message is missing', async () => {
      const response = new Response(JSON.stringify({ error: { code: '404' } }));
      const result = await parseGraphErrorMessage(response, 'fallback');
      expect(result).toBe('fallback');
    });

    it('falls back to text() when JSON parsing fails', async () => {
      const response = new Response('Plain text error');
      const result = await parseGraphErrorMessage(response, 'default msg');
      expect(result).toBe('Plain text error');
    });

    it('returns default message on complete parse failure', async () => {
      // Create a response that will fail both json() and text()
      const response = new Response('not json');
      // Consume the body to make subsequent reads fail
      await response.text();
      const result = await parseGraphErrorMessage(response, 'default msg');
      expect(result).toBe('default msg');
    });

    it('handles empty response body', async () => {
      const response = new Response('');
      const result = await parseGraphErrorMessage(response, 'empty fallback');
      expect(result).toBe('empty fallback');
    });

    it('handles malformed JSON gracefully', async () => {
      const response = new Response('{ invalid json }}}');
      const result = await parseGraphErrorMessage(response, 'parse error');
      expect(result).toBe('{ invalid json }}}');
    });

    it('handles nested error message structure', async () => {
      const response = new Response(
        JSON.stringify({
          error: {
            message: 'Detailed error message',
            code: 'InvalidRequest',
            innerError: { code: 'InternalError' },
          },
        })
      );
      const result = await parseGraphErrorMessage(response, 'default');
      expect(result).toBe('Detailed error message');
    });

    it('handles null error message', async () => {
      const response = new Response(JSON.stringify({ error: { message: null } }));
      const result = await parseGraphErrorMessage(response, 'null fallback');
      expect(result).toBe('null fallback');
    });

    it('handles undefined error message', async () => {
      const response = new Response(JSON.stringify({ error: { message: undefined } }));
      const result = await parseGraphErrorMessage(response, 'undefined fallback');
      expect(result).toBe('undefined fallback');
    });
  });

  describe('PROTECTED_FILES', () => {
    it('includes .sync-state.json', () => {
      expect(PROTECTED_FILES).toContain('.sync-state.json');
    });

    it('is an array', () => {
      expect(Array.isArray(PROTECTED_FILES)).toBe(true);
    });

    it('has at least one entry', () => {
      expect(PROTECTED_FILES.length).toBeGreaterThan(0);
    });
  });
});
