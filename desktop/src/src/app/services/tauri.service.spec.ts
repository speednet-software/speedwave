import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { TauriService } from './tauri.service';

/**
 * Simulates Tauri runtime via stubbed __TAURI_INTERNALS__ object on window.
 */
describe('TauriService', () => {
  let service: TauriService;
  let mockInternals: {
    invoke: ReturnType<typeof vi.fn>;
    transformCallback: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockInternals = {
      invoke: vi.fn(),
      transformCallback: vi.fn().mockReturnValue(1),
    };
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = mockInternals;
    service = new TauriService();
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  });

  describe('invoke()', () => {
    it('delegates to core invoke with cmd and args', async () => {
      mockInternals.invoke.mockResolvedValue({ ok: true });

      const result = await service.invoke('my_command', { key: 'value' });

      expect(mockInternals.invoke).toHaveBeenCalledWith('my_command', { key: 'value' }, undefined);
      expect(result).toEqual({ ok: true });
    });

    it('delegates to core invoke without args', async () => {
      mockInternals.invoke.mockResolvedValue('result');

      const result = await service.invoke('simple_cmd');

      expect(mockInternals.invoke).toHaveBeenCalledWith('simple_cmd', {}, undefined);
      expect(result).toBe('result');
    });

    it('propagates errors from core invoke', async () => {
      mockInternals.invoke.mockRejectedValue(new Error('backend error'));

      await expect(service.invoke('failing_cmd')).rejects.toThrow('backend error');
    });
  });

  describe('listen()', () => {
    it('delegates to event listen and returns unlisten function', async () => {
      mockInternals.invoke.mockResolvedValue(42);
      const handler = vi.fn();

      const unlisten = await service.listen('my_event', handler);

      expect(mockInternals.invoke).toHaveBeenCalledWith(
        'plugin:event|listen',
        expect.objectContaining({ event: 'my_event' }),
        undefined
      );
      expect(typeof unlisten).toBe('function');
    });
  });

  describe('getVersion()', () => {
    it('delegates to app getVersion', async () => {
      mockInternals.invoke.mockResolvedValue('1.2.3');

      const result = await service.getVersion();

      expect(mockInternals.invoke).toHaveBeenCalledWith('plugin:app|version', {}, undefined);
      expect(result).toBe('1.2.3');
    });
  });

  describe('isRunningInTauri()', () => {
    it('returns false when __TAURI_INTERNALS__ is absent', () => {
      delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
      expect(service.isRunningInTauri()).toBe(false);
    });

    it('returns true when __TAURI_INTERNALS__ is present', () => {
      expect(service.isRunningInTauri()).toBe(true);
    });
  });
});
