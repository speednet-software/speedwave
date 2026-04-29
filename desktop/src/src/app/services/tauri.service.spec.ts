import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { TauriService } from './tauri.service';

/**
 * Verifies the thin wrapper around `@tauri-apps/api/*` by simulating the
 * Tauri runtime via a stubbed `__TAURI_INTERNALS__` object on `window`.
 * `vi.mock` of `@tauri-apps/api/core` is unreliable under
 * `@angular/build:unit-test` (the warning "is not at the top level of the
 * module" surfaces and the mock factory is occasionally applied AFTER the
 * SUT has imported the real module), so the test exercises the
 * production code path that the runtime actually executes.
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

      // Tauri's runtime normalises a missing args object to `{}` before
      // forwarding to `__TAURI_INTERNALS__.invoke`.
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
      // The event channel is registered through plugin:event|listen which
      // resolves via the stubbed __TAURI_INTERNALS__.invoke. The first
      // resolved value is the event id used to build the unlisten callback.
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

      // `@tauri-apps/api/app` calls the plugin command with no args; the
      // Tauri runtime normalises that to `{}`.
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
      // beforeEach already installs the stub; assert the detection picks it up.
      expect(service.isRunningInTauri()).toBe(true);
    });
  });
});
