import { describe, it, expect, vi, beforeEach } from 'vitest';

const pluginError = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@tauri-apps/plugin-log', () => ({ error: pluginError }));

import { GlobalErrorHandler } from './error-handler';

describe('GlobalErrorHandler', () => {
  let handler: GlobalErrorHandler;

  beforeEach(() => {
    handler = new GlobalErrorHandler();
  });

  it('logs Error instances to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('test error');
    handler.handleError(error);
    expect(spy).toHaveBeenCalledWith(error);
    spy.mockRestore();
  });

  it('logs non-Error values to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    handler.handleError('string error');
    expect(spy).toHaveBeenCalledWith('string error');
    spy.mockRestore();
  });

  it('does not throw when handling errors outside Tauri', () => {
    expect(() => handler.handleError(new Error('test'))).not.toThrow();
  });

  it('forwards the error name and stack frames to the log, never the message or a thrown string', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    pluginError.mockClear();
    const sentinel = 'SENTINEL-997-uncaught';
    handler.handleError(new SyntaxError(`Unexpected token in {"content":"${sentinel}"}`));
    handler.handleError(`thrown ${sentinel}`);
    await vi.waitFor(() => expect(pluginError).toHaveBeenCalledTimes(2));
    const logged = JSON.stringify(pluginError.mock.calls);
    expect(logged).toContain('SyntaxError');
    expect(logged).toContain('non-Error value of type string');
    expect(logged).not.toContain('SENTINEL-997');
    spy.mockRestore();
  });
});
