import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { TauriService } from './tauri.service';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn() }));

describe('TauriService', () => {
  let service: TauriService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TauriService();
  });

  describe('invoke()', () => {
    it('delegates to core invoke with cmd and args', async () => {
      (invoke as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

      const result = await service.invoke('my_command', { key: 'value' });

      expect(invoke).toHaveBeenCalledWith('my_command', { key: 'value' });
      expect(result).toEqual({ ok: true });
    });

    it('delegates to core invoke without args', async () => {
      (invoke as ReturnType<typeof vi.fn>).mockResolvedValue('result');

      const result = await service.invoke('simple_cmd');

      expect(invoke).toHaveBeenCalledWith('simple_cmd', undefined);
      expect(result).toBe('result');
    });

    it('propagates errors from core invoke', async () => {
      (invoke as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('backend error'));

      await expect(service.invoke('failing_cmd')).rejects.toThrow('backend error');
    });
  });

  describe('listen()', () => {
    it('delegates to event listen and returns unlisten function', async () => {
      const unlistenFn = vi.fn();
      (listen as ReturnType<typeof vi.fn>).mockResolvedValue(unlistenFn);
      const handler = vi.fn();

      const result = await service.listen('my_event', handler);

      expect(listen).toHaveBeenCalledWith('my_event', handler);
      expect(result).toBe(unlistenFn);
    });
  });

  describe('getVersion()', () => {
    it('delegates to app getVersion', async () => {
      (getVersion as ReturnType<typeof vi.fn>).mockResolvedValue('1.2.3');

      const result = await service.getVersion();

      expect(getVersion).toHaveBeenCalled();
      expect(result).toBe('1.2.3');
    });
  });

  describe('isRunningInTauri()', () => {
    it('returns false when __TAURI_INTERNALS__ is absent', () => {
      delete (window as Record<string, unknown>)['__TAURI_INTERNALS__'];
      expect(service.isRunningInTauri()).toBe(false);
    });

    it('returns true when __TAURI_INTERNALS__ is present', () => {
      (window as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
      expect(service.isRunningInTauri()).toBe(true);
      delete (window as Record<string, unknown>)['__TAURI_INTERNALS__'];
    });
  });
});
