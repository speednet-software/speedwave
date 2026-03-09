import { describe, it, expect, vi } from 'vitest';
import { metadata, execute } from './sync.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for SharePoint Sync Tool
//
// Purpose: Test sync functionality parameter passing
// - Verify metadata (name, category, service, schema)
// - Test delete parameter passthrough (letting SharePoint MCP decide defaults)
// - Test directory mode vs file mode detection
//═══════════════════════════════════════════════════════════════════════════════

describe('sharepoint/sync', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('sync');
    });

    it('should have correct category', () => {
      expect(metadata.category).toBe('write');
    });

    it('should have correct service', () => {
      expect(metadata.service).toBe('sharepoint');
    });

    it('should have non-empty description', () => {
      expect(metadata.description).toBeTruthy();
      expect(typeof metadata.description).toBe('string');
    });
  });

  describe('execute - delete parameter passthrough', () => {
    it('should pass delete=undefined when not specified (let SharePoint MCP decide based on mode)', async () => {
      const syncDirectoryMock = vi.fn().mockResolvedValue({ success: true });
      const context = {
        sharepoint: {
          sync: vi.fn(),
          syncDirectory: syncDirectoryMock,
        },
      };

      await execute(
        {
          local_path: '/home/speedwave/.claude/context',
          mode: 'two_way',
          // delete is NOT specified
        },
        context
      );

      expect(syncDirectoryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          delete: undefined, // Should be undefined, not true or false
        })
      );
    });

    it('should pass delete=true when explicitly specified', async () => {
      const syncDirectoryMock = vi.fn().mockResolvedValue({ success: true });
      const context = {
        sharepoint: {
          sync: vi.fn(),
          syncDirectory: syncDirectoryMock,
        },
      };

      await execute(
        {
          local_path: '/home/speedwave/.claude/context',
          mode: 'pull',
          delete: true,
        },
        context
      );

      expect(syncDirectoryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          delete: true,
        })
      );
    });

    it('should pass delete=false when explicitly specified', async () => {
      const syncDirectoryMock = vi.fn().mockResolvedValue({ success: true });
      const context = {
        sharepoint: {
          sync: vi.fn(),
          syncDirectory: syncDirectoryMock,
        },
      };

      await execute(
        {
          local_path: '/home/speedwave/.claude/context',
          mode: 'two_way',
          delete: false,
        },
        context
      );

      expect(syncDirectoryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          delete: false,
        })
      );
    });

    it('should pass delete=undefined for pull mode when not specified', async () => {
      const syncDirectoryMock = vi.fn().mockResolvedValue({ success: true });
      const context = {
        sharepoint: {
          sync: vi.fn(),
          syncDirectory: syncDirectoryMock,
        },
      };

      await execute(
        {
          local_path: '/home/speedwave/.claude/context',
          mode: 'pull',
        },
        context
      );

      expect(syncDirectoryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          delete: undefined,
        })
      );
    });

    it('should pass delete=undefined for push mode when not specified', async () => {
      const syncDirectoryMock = vi.fn().mockResolvedValue({ success: true });
      const context = {
        sharepoint: {
          sync: vi.fn(),
          syncDirectory: syncDirectoryMock,
        },
      };

      await execute(
        {
          local_path: '/home/speedwave/.claude/context',
          mode: 'push',
        },
        context
      );

      expect(syncDirectoryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          delete: undefined,
        })
      );
    });
  });

  describe('execute - mode detection', () => {
    it('should use syncDirectory when mode is provided', async () => {
      const syncDirectoryMock = vi.fn().mockResolvedValue({ success: true });
      const syncMock = vi.fn();
      const context = {
        sharepoint: {
          sync: syncMock,
          syncDirectory: syncDirectoryMock,
        },
      };

      await execute(
        {
          local_path: '/home/speedwave/.claude/context',
          mode: 'two_way',
        },
        context
      );

      expect(syncDirectoryMock).toHaveBeenCalled();
      expect(syncMock).not.toHaveBeenCalled();
    });

    it('should use sync (file mode) when mode is not provided', async () => {
      const syncDirectoryMock = vi.fn();
      const syncMock = vi.fn().mockResolvedValue({ success: true });
      const context = {
        sharepoint: {
          sync: syncMock,
          syncDirectory: syncDirectoryMock,
        },
      };

      await execute(
        {
          local_path: '/home/speedwave/.claude/context/file.txt',
        },
        context
      );

      expect(syncMock).toHaveBeenCalled();
      expect(syncDirectoryMock).not.toHaveBeenCalled();
    });
  });

  describe('execute - defense-in-depth SharePoint path validation', () => {
    it('should reject file mode path starting with opportunities/ (missing context/ prefix)', async () => {
      const context = {
        sharepoint: {
          sync: vi.fn(),
          syncDirectory: vi.fn(),
        },
      };

      const result = await execute(
        {
          local_path: '/tmp/placeholder.txt',
          sharepoint_path: 'opportunities/cez/iterations/.placeholder',
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('opportunities/');
      expect(result.error).toContain('context/');
      expect(context.sharepoint.sync).not.toHaveBeenCalled();
    });

    it('should accept file mode path starting with context/opportunities/', async () => {
      const syncMock = vi.fn().mockResolvedValue({ success: true });
      const context = {
        sharepoint: {
          sync: syncMock,
          syncDirectory: vi.fn(),
        },
      };

      const result = await execute(
        {
          local_path: '/tmp/placeholder.txt',
          sharepoint_path: 'context/opportunities/cez/iterations/.placeholder',
        },
        context
      );

      expect(result.success).toBe(true);
      expect(syncMock).toHaveBeenCalled();
    });

    it('should accept file mode path not containing opportunities/', async () => {
      const syncMock = vi.fn().mockResolvedValue({ success: true });
      const context = {
        sharepoint: {
          sync: syncMock,
          syncDirectory: vi.fn(),
        },
      };

      const result = await execute(
        {
          local_path: '/tmp/file.txt',
          sharepoint_path: 'context/some-other-folder/file.txt',
        },
        context
      );

      expect(result.success).toBe(true);
      expect(syncMock).toHaveBeenCalled();
    });

    it('should reject directory mode path starting with opportunities/ (missing context/ prefix)', async () => {
      const context = {
        sharepoint: {
          sync: vi.fn(),
          syncDirectory: vi.fn(),
        },
      };

      const result = await execute(
        {
          local_path: '/home/speedwave/.claude/context',
          sharepoint_path: 'opportunities/cez',
          mode: 'push',
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('opportunities/');
      expect(context.sharepoint.syncDirectory).not.toHaveBeenCalled();
    });
  });

  describe('execute - error handling', () => {
    it('should return error when sharepoint service is not initialized', async () => {
      const result = await execute(
        {
          local_path: '/home/speedwave/.claude/context',
          mode: 'two_way',
        },
        { sharepoint: undefined as any }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('SharePoint service not initialized');
    });

    it('should return error when local_path is missing', async () => {
      const context = {
        sharepoint: {
          sync: vi.fn(),
          syncDirectory: vi.fn(),
        },
      };

      const result = await execute(
        {
          local_path: '',
          mode: 'two_way',
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required field: local_path');
    });

    it('should handle syncDirectory throwing a generic Error', async () => {
      const syncDirectoryMock = vi.fn().mockRejectedValue(new Error('Network timeout'));
      const context = {
        sharepoint: {
          sync: vi.fn(),
          syncDirectory: syncDirectoryMock,
        },
      };

      const result = await execute(
        {
          local_path: '/home/speedwave/.claude/context',
          mode: 'two_way',
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network timeout');
    });

    it('should handle syncDirectory throwing a TypeError with configuration message', async () => {
      const syncDirectoryMock = vi
        .fn()
        .mockRejectedValue(
          new TypeError("Cannot read properties of undefined (reading 'syncDirectory')")
        );
      const context = {
        sharepoint: {
          sync: vi.fn(),
          syncDirectory: syncDirectoryMock,
        },
      };

      const result = await execute(
        {
          local_path: '/home/speedwave/.claude/context',
          mode: 'two_way',
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Configuration error');
      expect(result.error).toContain('Ensure SharePoint service is properly initialized');
    });

    it('should handle sync (file mode) throwing an Error', async () => {
      const syncMock = vi.fn().mockRejectedValue(new Error('File not found'));
      const context = {
        sharepoint: {
          sync: syncMock,
          syncDirectory: vi.fn(),
        },
      };

      const result = await execute(
        {
          local_path: '/home/speedwave/.claude/context/file.txt',
          // no mode = file mode
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('File not found');
    });
  });
});
