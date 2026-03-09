import { describe, it, expect, vi, beforeEach } from 'vitest';
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
});
