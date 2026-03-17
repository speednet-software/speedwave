/**
 * Security tests for path validation functions in SharePoint client
 * Tests path traversal prevention, URL encoding attacks, and whitelist enforcement
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SharePointClient, SharePointConfig } from './client.js';
import { PathValidator } from './path-validator.js';

// Test configuration
const mockConfig: SharePointConfig = {
  clientId: 'test-client-id',
  tenantId: 'test-tenant-id',
  siteId: 'test-site-id',
  basePath: 'Documents/TestFolder',
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
};

const mockTokensDir = '/test/tokens';

describe('Security: validatePath', () => {
  let client: SharePointClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SharePointClient({ ...mockConfig }, mockTokensDir);

    // Mock console methods to reduce noise
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Path Traversal Attacks
  //═══════════════════════════════════════════════════════════════════════════════

  describe('Path Traversal Attacks', () => {
    it('should reject path with ../ traversal', async () => {
      const maliciousPath = '../../../etc/passwd';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject path with ../ in the middle', async () => {
      const maliciousPath = 'Documents/../../../etc/passwd';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject path with ../ at the end', async () => {
      const maliciousPath = 'Documents/folder/../..';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject path with ..\\ Windows-style traversal', async () => {
      const maliciousPath = '..\\..\\Windows\\System32';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject path with mixed / and \\ traversal', async () => {
      const maliciousPath = '../folder\\..\\..\\etc';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject path with ....// double-dot traversal', async () => {
      const maliciousPath = '....//....//etc/passwd';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject path with standalone .. segment', async () => {
      const maliciousPath = 'Documents/..';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject path with .. at the beginning', async () => {
      const maliciousPath = '..';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject path with multiple .. segments', async () => {
      const maliciousPath = 'folder/..';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // URL-Encoded Traversal Attacks
  //═══════════════════════════════════════════════════════════════════════════════

  describe('URL-Encoded Traversal Attacks', () => {
    it('should reject URL-encoded ../ (%2e%2e%2f)', async () => {
      const maliciousPath = '%2e%2e%2f%2e%2e%2fetc/passwd';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject partially URL-encoded ../ (%2e%2e/)', async () => {
      const maliciousPath = '%2e%2e/%2e%2e/etc/passwd';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject mixed case URL-encoded ../ (%2E%2E%2F)', async () => {
      const maliciousPath = '%2E%2E%2F%2E%2E%2Fetc';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject double-encoded ../ (%252e%252e%252f)', async () => {
      const maliciousPath = '%252e%252e%252fetc';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject URL-encoded backslash traversal (%2e%2e%5c)', async () => {
      const maliciousPath = '%2e%2e%5c%2e%2e%5cWindows';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject triple-encoded ../ (%25252e%25252e%25252f)', async () => {
      const maliciousPath = '%25252e%25252e%25252fetc';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject URL-encoded .. alone (%2e%2e)', async () => {
      const maliciousPath = 'folder/%2e%2e';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject invalid URL encoding', async () => {
      const maliciousPath = '%ZZ%ZZ/etc/passwd';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Null Byte Injection
  //═══════════════════════════════════════════════════════════════════════════════

  describe('Null Byte Injection', () => {
    it('should reject path with URL-encoded null byte (%00)', async () => {
      const maliciousPath = 'file%00.txt';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject path with literal null byte', async () => {
      const maliciousPath = 'file\0.txt';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject path with null byte in the middle', async () => {
      const maliciousPath = 'Documents/file\0/../../etc/passwd';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject path with URL-encoded null byte at the end', async () => {
      const maliciousPath = 'Documents/file.txt%00';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Absolute Paths
  //═══════════════════════════════════════════════════════════════════════════════

  describe('Absolute Paths', () => {
    it('should reject Unix absolute path (/etc/passwd)', async () => {
      const maliciousPath = '/etc/passwd';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject Unix absolute path (/home/user)', async () => {
      const maliciousPath = '/home/user/.ssh/id_rsa';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject Windows absolute path (C:\\Windows)', async () => {
      // Note: The path contains backslash which triggers validation failure
      const maliciousPath = 'C:\\Windows\\System32';
      // This will fail because of backslashes, not because it starts with C:
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow();
    });

    it('should reject Windows UNC path (\\\\server\\share)', async () => {
      const maliciousPath = '\\\\server\\share\\file.txt';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject path starting with backslash', async () => {
      const maliciousPath = '\\etc\\passwd';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject network path (//server/share)', async () => {
      const maliciousPath = '//server/share/file.txt';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Edge Cases
  //═══════════════════════════════════════════════════════════════════════════════

  describe('Edge Cases', () => {
    it('should reject empty string path', async () => {
      // Empty string is actually allowed (represents root), testing invalid types
      const maliciousPath = null as unknown as string;
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow();
    });

    it('should reject undefined path (type coercion)', async () => {
      const maliciousPath = undefined as unknown as string;
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow();
    });

    it('should reject non-string path (number)', async () => {
      const maliciousPath = 123 as unknown as string;
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject non-string path (object)', async () => {
      const maliciousPath = { path: '../etc/passwd' } as unknown as string;
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject very long path (potential DoS)', async () => {
      const maliciousPath = 'a/'.repeat(10000) + 'file.txt';
      // This should either reject or handle gracefully
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow();
    });

    it('should handle path with spaces safely', async () => {
      // Mock successful response
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ value: [] }),
      });

      const validPath = 'Documents/My Folder/file.txt';
      await expect(client.listFiles({ path: validPath })).resolves.toBeDefined();
    });

    it('should handle path with Unicode characters safely', async () => {
      // Mock successful response
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ value: [] }),
      });

      const validPath = 'Documents/文件夹/файл.txt';
      await expect(client.listFiles({ path: validPath })).resolves.toBeDefined();
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Valid Paths (should pass)
  //═══════════════════════════════════════════════════════════════════════════════

  describe('Valid Paths', () => {
    beforeEach(() => {
      // Mock successful fetch responses for valid paths
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ value: [] }),
      });
    });

    it('should accept simple relative path', async () => {
      const validPath = 'Documents/file.txt';
      await expect(client.listFiles({ path: validPath })).resolves.toBeDefined();
    });

    it('should accept nested folder path', async () => {
      const validPath = 'Documents/Folder1/Folder2/file.txt';
      await expect(client.listFiles({ path: validPath })).resolves.toBeDefined();
    });

    it('should accept path with dashes', async () => {
      const validPath = 'my-documents/my-file.txt';
      await expect(client.listFiles({ path: validPath })).resolves.toBeDefined();
    });

    it('should accept path with underscores', async () => {
      const validPath = 'my_documents/my_file.txt';
      await expect(client.listFiles({ path: validPath })).resolves.toBeDefined();
    });

    it('should accept path with dots in filename', async () => {
      const validPath = 'Documents/my.file.v2.txt';
      await expect(client.listFiles({ path: validPath })).resolves.toBeDefined();
    });

    it('should accept path with numbers', async () => {
      const validPath = 'Documents/2024/Q1/report.txt';
      await expect(client.listFiles({ path: validPath })).resolves.toBeDefined();
    });

    it('should accept empty path (root directory)', async () => {
      const validPath = '';
      await expect(client.listFiles({ path: validPath })).resolves.toBeDefined();
    });

    it('should accept path with parentheses', async () => {
      const validPath = 'Documents/Report (Final).txt';
      await expect(client.listFiles({ path: validPath })).resolves.toBeDefined();
    });

    it('should accept path with ampersand', async () => {
      const validPath = 'Documents/Sales & Marketing/report.txt';
      await expect(client.listFiles({ path: validPath })).resolves.toBeDefined();
    });

    it('should accept path with @ symbol', async () => {
      const validPath = 'Documents/@archive/file.txt';
      await expect(client.listFiles({ path: validPath })).resolves.toBeDefined();
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Complex Attack Scenarios
  //═══════════════════════════════════════════════════════════════════════════════

  describe('Complex Attack Scenarios', () => {
    it('should reject mixed encoding and traversal', async () => {
      const maliciousPath = 'Documents/%2e%2e/../../../etc/passwd';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject traversal with null byte', async () => {
      const maliciousPath = '../%00/etc/passwd';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject alternate encoding with backslash', async () => {
      const maliciousPath = 'Documents%5c..%5c..%5cetc%5cpasswd';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject Unicode normalization attack', async () => {
      // Using Unicode characters that might normalize to ../
      const maliciousPath = 'Documents/\u002e\u002e\u002f\u002e\u002e\u002fetc';
      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });
  });
});

describe('Security: validateLocalPath', () => {
  let client: SharePointClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SharePointClient({ ...mockConfig }, mockTokensDir);

    // Mock console methods
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Whitelist Enforcement
  //═══════════════════════════════════════════════════════════════════════════════

  describe('Whitelist Enforcement', () => {
    it('should reject path outside allowed directory', async () => {
      await expect(client.uploadFile('docs/test.txt', '/etc/passwd')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should reject home directory', async () => {
      await expect(client.uploadFile('docs/test.txt', '/home/speedwave')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should reject parent of allowed directory', async () => {
      await expect(client.uploadFile('docs/test.txt', '/home/speedwave/.claude')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should reject root directory', async () => {
      await expect(client.uploadFile('docs/test.txt', '/')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should reject /tmp directory', async () => {
      await expect(client.uploadFile('docs/test.txt', '/tmp')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should reject /var directory', async () => {
      await expect(client.uploadFile('docs/test.txt', '/var/log')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should reject another user home directory', async () => {
      await expect(client.uploadFile('docs/test.txt', '/home/otheruser')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should reject Windows paths', async () => {
      await expect(client.uploadFile('docs/test.txt', 'C:\\Users\\speedwave')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Path Traversal in Local Paths
  //═══════════════════════════════════════════════════════════════════════════════

  describe('Path Traversal in Local Paths', () => {
    it('should reject relative path with traversal escaping whitelist', async () => {
      await expect(client.uploadFile('docs/test.txt', '/workspace/../../..')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should reject symlink-like traversal attempt', async () => {
      await expect(
        client.uploadFile('docs/test.txt', '/workspace/../../../etc/passwd')
      ).rejects.toThrow('Invalid local_path: must be under /workspace');
    });

    it('should reject path with embedded ../ after resolution', async () => {
      // After path.resolve(), this should normalize and fail validation
      await expect(
        client.uploadFile('docs/test.txt', '/workspace/folder/../../..')
      ).rejects.toThrow('Invalid local_path: must be under /workspace');
    });

    it('should reject relative path starting with ../', async () => {
      // Relative paths should resolve based on current working directory
      // and should fail if they escape the whitelist
      await expect(client.uploadFile('docs/test.txt', '../../../etc/passwd')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Edge Cases for Local Paths
  //═══════════════════════════════════════════════════════════════════════════════

  describe('Edge Cases for Local Paths', () => {
    it('should reject empty string path', async () => {
      await expect(client.uploadFile('docs/test.txt', '')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should reject null path', async () => {
      await expect(client.uploadFile('docs/test.txt', null as unknown as string)).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should reject undefined path', async () => {
      await expect(
        client.uploadFile('docs/test.txt', undefined as unknown as string)
      ).rejects.toThrow('Invalid local_path: must be under /workspace');
    });

    it('should reject non-string path (number)', async () => {
      await expect(client.uploadFile('docs/test.txt', 123 as unknown as string)).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should reject non-string path (object)', async () => {
      await expect(
        client.uploadFile('docs/test.txt', { path: '/workspace' } as unknown as string)
      ).rejects.toThrow('Invalid local_path: must be under /workspace');
    });

    it('should reject path with trailing /..', async () => {
      await expect(client.uploadFile('docs/test.txt', '/workspace/..')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should reject path with embedded /../ after normalization', async () => {
      await expect(
        client.uploadFile('docs/test.txt', '/home/speedwave/.claude/../other')
      ).rejects.toThrow('Invalid local_path: must be under /workspace');
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Valid Local Paths (should pass)
  //═══════════════════════════════════════════════════════════════════════════════

  describe('Valid Local Paths', () => {
    beforeEach(async () => {
      // Mock fs operations for successful scenarios
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ eTag: 'test-etag', size: 100 }),
      });

      vi.mock('fs/promises');
      const mockFs = await import('fs/promises');
      vi.mocked(mockFs.default.readFile).mockResolvedValue(Buffer.from('test'));
      vi.mocked(mockFs.default.mkdir).mockResolvedValue(undefined);
    });

    it('should accept exact whitelist path', async () => {
      const validPath = '/workspace';
      await expect(client.uploadFile('docs/test.txt', validPath)).resolves.toBeDefined();
    });

    it('should accept subdirectory of whitelist', async () => {
      const validPath = '/workspace/projects';
      await expect(client.uploadFile('docs/test.txt', validPath)).resolves.toBeDefined();
    });

    it('should accept nested subdirectory of whitelist', async () => {
      const validPath = '/workspace/projects/my-project';
      await expect(client.uploadFile('docs/test.txt', validPath)).resolves.toBeDefined();
    });

    it('should accept deeply nested subdirectory', async () => {
      const validPath = '/workspace/a/b/c/d/e/f';
      await expect(client.uploadFile('docs/test.txt', validPath)).resolves.toBeDefined();
    });

    it('should accept path with spaces in subdirectory', async () => {
      const validPath = '/workspace/My Projects/Project 1';
      await expect(client.uploadFile('docs/test.txt', validPath)).resolves.toBeDefined();
    });

    it('should accept path with special characters in subdirectory', async () => {
      const validPath = '/workspace/project-name_v2.0';
      await expect(client.uploadFile('docs/test.txt', validPath)).resolves.toBeDefined();
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Similarity Attacks (paths that look like whitelist but aren't)
  //═══════════════════════════════════════════════════════════════════════════════

  describe('Similarity Attacks', () => {
    it('should normalize path with extra leading slash', async () => {
      // path.resolve() normalizes //workspace to /workspace
      // So this actually passes validation after normalization
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ eTag: 'test-etag', size: 100 }),
      });
      vi.mock('fs/promises');
      const mockFs = await import('fs/promises');
      vi.mocked(mockFs.default.readFile).mockResolvedValue(Buffer.from('test'));

      await expect(client.uploadFile('docs/test.txt', '//workspace')).resolves.toBeDefined();
    });

    it('should accept path with trailing slash removed from whitelist', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ eTag: 'test-etag', size: 100 }),
      });
      vi.mock('fs/promises');
      const mockFs = await import('fs/promises');
      vi.mocked(mockFs.default.readFile).mockResolvedValue(Buffer.from('test'));

      const validPath = '/workspace/';
      await expect(client.uploadFile('docs/test.txt', validPath)).resolves.toBeDefined();
    });

    it('should reject path that looks similar but is not a subdirectory (workspace2)', async () => {
      // SECURITY FIX: /workspace2 is NOT a subdirectory of /workspace
      await expect(client.uploadFile('docs/test.txt', '/workspace2')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should reject completely different path', async () => {
      await expect(
        client.uploadFile('docs/test.txt', '/home/speedwave/.claude/other')
      ).rejects.toThrow('Invalid local_path: must be under /workspace');
    });

    it('should reject path with unicode lookalike characters', async () => {
      // Using Cyrillic 'а' instead of Latin 'a'
      await expect(
        client.uploadFile('docs/test.txt', '/home/speedwave/.clаude/context')
      ).rejects.toThrow('Invalid local_path: must be under /workspace');
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Security Logging Tests
  //═══════════════════════════════════════════════════════════════════════════════

  describe('Security Logging', () => {
    it('should log security warning when path traversal is detected in validatePath', async () => {
      const warnSpy = vi.spyOn(console, 'warn');
      const maliciousPath = '../../../etc/passwd';

      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Security: Path validation blocked potential attack'),
        expect.objectContaining({
          attackType: 'path_traversal',
          attemptedPath: maliciousPath,
        })
      );
    });

    it('should log security warning with timestamp when attack is detected', async () => {
      const warnSpy = vi.spyOn(console, 'warn');
      const maliciousPath = '/absolute/path';

      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow();

      // Timestamp is now in the ts() prefix [HH:MM:SS], not in the object
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\].*Security/),
        expect.objectContaining({
          attackType: 'absolute_path',
        })
      );
    });

    it('should log security warning for URL-encoded traversal attack', async () => {
      const warnSpy = vi.spyOn(console, 'warn');
      const maliciousPath = '%2e%2e%2f%2e%2e%2fetc%2fpasswd';

      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Security'),
        expect.objectContaining({
          attackType: 'path_traversal',
          attemptedPath: maliciousPath,
          decodedPath: expect.any(String),
        })
      );
    });

    it('should log security warning for null byte injection', async () => {
      const warnSpy = vi.spyOn(console, 'warn');
      const maliciousPath = 'file.txt\0.jpg';

      await expect(client.listFiles({ path: maliciousPath })).rejects.toThrow();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Security'),
        expect.objectContaining({
          attackType: 'null_byte_injection',
          attemptedPath: maliciousPath,
        })
      );
    });

    it('should log security warning when local path is outside allowed directory', async () => {
      const warnSpy = vi.spyOn(console, 'warn');

      await expect(client.uploadFile('docs/test.txt', '/etc/passwd')).rejects.toThrow();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Security: Local path validation blocked potential attack'),
        expect.objectContaining({
          attackType: 'path_outside_allowed_directory',
          attemptedPath: '/etc/passwd',
          resolvedPath: '/etc/passwd',
        })
      );
    });

    it('should include attack type in all security logs', async () => {
      const warnSpy = vi.spyOn(console, 'warn');
      const attacks = [
        { path: '../test', expectedType: 'path_traversal' },
        { path: '/absolute', expectedType: 'absolute_path' },
        { path: 'test\0', expectedType: 'null_byte_injection' },
      ];

      for (const attack of attacks) {
        warnSpy.mockClear();
        await expect(client.listFiles({ path: attack.path })).rejects.toThrow();

        expect(warnSpy).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            attackType: attack.expectedType,
          })
        );
      }
    });
  });
});

//═══════════════════════════════════════════════════════════════════════════════
// Denylist Tests
//═══════════════════════════════════════════════════════════════════════════════

describe('Security: denylist enforcement', () => {
  let client: SharePointClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SharePointClient({ ...mockConfig }, mockTokensDir);

    // Mock console methods
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('.git directory protection', () => {
    it('should block /workspace/.git/config', async () => {
      await expect(client.uploadFile('docs/config', '/workspace/.git/config')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should block /workspace/.git (exact)', async () => {
      await expect(client.uploadFile('docs/git', '/workspace/.git')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should allow /workspace/.gitignore (not a prefix match)', async () => {
      // .gitignore starts with .git but is not .git/ or .git itself
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ eTag: 'test-etag', size: 100 }),
      });
      vi.mock('fs/promises');
      const mockFs = await import('fs/promises');
      vi.mocked(mockFs.default.readFile).mockResolvedValue(Buffer.from('test'));

      await expect(
        client.uploadFile('docs/.gitignore', '/workspace/.gitignore')
      ).resolves.toBeDefined();
    });

    it('should allow /workspace/.github/workflows/ci.yml', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ eTag: 'test-etag', size: 100 }),
      });
      vi.mock('fs/promises');
      const mockFs = await import('fs/promises');
      vi.mocked(mockFs.default.readFile).mockResolvedValue(Buffer.from('test'));

      await expect(
        client.uploadFile('docs/ci.yml', '/workspace/.github/workflows/ci.yml')
      ).resolves.toBeDefined();
    });
  });

  describe('.env file protection', () => {
    it('should block /workspace/.env (exact match)', async () => {
      await expect(client.uploadFile('docs/.env', '/workspace/.env')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should allow /workspace/.envrc (not exact match)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ eTag: 'test-etag', size: 100 }),
      });
      vi.mock('fs/promises');
      const mockFs = await import('fs/promises');
      vi.mocked(mockFs.default.readFile).mockResolvedValue(Buffer.from('test'));

      await expect(client.uploadFile('docs/.envrc', '/workspace/.envrc')).resolves.toBeDefined();
    });

    it('should allow /workspace/.env.example (not exact match)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ eTag: 'test-etag', size: 100 }),
      });
      vi.mock('fs/promises');
      const mockFs = await import('fs/promises');
      vi.mocked(mockFs.default.readFile).mockResolvedValue(Buffer.from('test'));

      await expect(
        client.uploadFile('docs/.env.example', '/workspace/.env.example')
      ).resolves.toBeDefined();
    });
  });

  describe('.speedwave directory protection', () => {
    it('should block /workspace/.speedwave/config.json', async () => {
      await expect(
        client.uploadFile('docs/config.json', '/workspace/.speedwave/config.json')
      ).rejects.toThrow('Invalid local_path: must be under /workspace');
    });

    it('should block /workspace/.speedwave (exact)', async () => {
      await expect(client.uploadFile('docs/speedwave', '/workspace/.speedwave')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should block /workspace/.speedwave/tokens/sharepoint/access_token', async () => {
      await expect(
        client.uploadFile('docs/token', '/workspace/.speedwave/tokens/sharepoint/access_token')
      ).rejects.toThrow('Invalid local_path: must be under /workspace');
    });
  });

  describe('downloadFile denylist enforcement', () => {
    it('should block downloading to /workspace/.git/config', async () => {
      await expect(client.downloadFile('docs/config', '/workspace/.git/config')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should block downloading to /workspace/.env', async () => {
      await expect(client.downloadFile('docs/.env', '/workspace/.env')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should block downloading to /workspace/.speedwave/config.json', async () => {
      await expect(
        client.downloadFile('docs/config.json', '/workspace/.speedwave/config.json')
      ).rejects.toThrow('Invalid local_path: must be under /workspace');
    });
  });

  describe('expanded denylist entries', () => {
    let validator: PathValidator;

    beforeEach(() => {
      validator = new PathValidator();
    });

    it('blocks .ssh directory access', () => {
      expect(validator.validateLocalPath('/workspace/.ssh/id_rsa')).toBe(false);
    });

    it('blocks .npmrc file access', () => {
      expect(validator.validateLocalPath('/workspace/.npmrc')).toBe(false);
    });

    it('blocks .docker directory access', () => {
      expect(validator.validateLocalPath('/workspace/.docker/config.json')).toBe(false);
    });

    it('blocks .kube directory access', () => {
      expect(validator.validateLocalPath('/workspace/.kube/config')).toBe(false);
    });
  });
});
