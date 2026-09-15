import { vi } from 'vitest';

/**
 * Shared LoggerService double for Angular test files; provide it via `{ provide: LoggerService, useValue }`.
 * @returns Spies for the info/warn/error/debug methods.
 */
export function makeMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}
