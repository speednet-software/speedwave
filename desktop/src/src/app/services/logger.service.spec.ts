import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { TestBed } from '@angular/core/testing';
import { LoggerService } from './logger.service';

/** Stubs `__TAURI_INTERNALS__.invoke`, which the wrapper forwards to via `invoke('plugin:log|log', …)`. */
describe('LoggerService', () => {
  let service: LoggerService;
  let invokeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeSpy = vi.fn().mockResolvedValue(undefined);
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {
      invoke: invokeSpy,
      transformCallback: vi.fn().mockReturnValue(1),
    };
    TestBed.configureTestingModule({});
    service = TestBed.inject(LoggerService);
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  });

  it('forwards the message to the Rust log pipeline as an error-level entry', async () => {
    service.error('boom');

    // Yield so the wrapper's `.catch(() => {})` chain can settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeSpy.mock.calls[0];
    expect(cmd).toBe('plugin:log|log');
    expect(args).toMatchObject({ message: 'boom', level: 5 }); // 5 = LogLevel.Error
  });

  it('swallows logging-pipeline failures so the UI never crashes', async () => {
    invokeSpy.mockRejectedValue(new Error('rust pipeline down'));

    // Should NOT throw, even though the underlying invoke rejects.
    expect(() => service.error('unreachable')).not.toThrow();

    // Allow the swallowed rejection to settle on the microtask queue.
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeSpy).toHaveBeenCalledTimes(1);
  });

  it('handles empty-string messages without raising', async () => {
    service.error('');

    await Promise.resolve();
    await Promise.resolve();

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(invokeSpy.mock.calls[0][1]).toMatchObject({ message: '' });
  });

  // -- info / warn / debug levels --
  // LogLevel: Trace=1, Debug=2, Info=3, Warn=4, Error=5.

  it('forwards info-level messages with level=3', async () => {
    service.info('hello');

    await Promise.resolve();
    await Promise.resolve();

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(invokeSpy.mock.calls[0][1]).toMatchObject({ message: 'hello', level: 3 });
  });

  it('forwards warn-level messages with level=4', async () => {
    service.warn('careful');

    await Promise.resolve();
    await Promise.resolve();

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(invokeSpy.mock.calls[0][1]).toMatchObject({ message: 'careful', level: 4 });
  });

  it('forwards debug-level messages with level=2', async () => {
    service.debug('verbose');

    await Promise.resolve();
    await Promise.resolve();

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(invokeSpy.mock.calls[0][1]).toMatchObject({ message: 'verbose', level: 2 });
  });

  it('swallows info/warn/debug failures the same way as error', async () => {
    invokeSpy.mockRejectedValue(new Error('rust pipeline down'));

    expect(() => service.info('x')).not.toThrow();
    expect(() => service.warn('x')).not.toThrow();
    expect(() => service.debug('x')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    // 3 calls, all failed at the invoke layer, none propagated to the caller.
    expect(invokeSpy).toHaveBeenCalledTimes(3);
  });
});
