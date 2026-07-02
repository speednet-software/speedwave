import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { NativeThemeAdapter } from './native-theme-adapter';
import { LoggerService } from './logger.service';

function makeMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('NativeThemeAdapter', () => {
  let adapter: NativeThemeAdapter;
  let mockLogger: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    mockLogger = makeMockLogger();
    TestBed.configureTestingModule({
      providers: [NativeThemeAdapter, { provide: LoggerService, useValue: mockLogger }],
    });
    adapter = TestBed.inject(NativeThemeAdapter);
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  });

  it('is a no-op outside Tauri (no native call, no log)', () => {
    // jsdom has `window` but no `__TAURI_INTERNALS__`, so the guard returns early.
    expect(() => adapter.syncWindowTheme('dark')).not.toThrow();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('attempts the native call when running inside Tauri', () => {
    // Internals object flips the guard; dynamic import rejects under jsdom, swallowed via .catch.
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = { invoke: vi.fn() };
    expect(() => adapter.syncWindowTheme('light')).not.toThrow();
  });
});
