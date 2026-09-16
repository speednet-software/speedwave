import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { NativeThemeAdapter } from './native-theme-adapter';
import { LoggerService } from './logger.service';
import { makeMockLogger } from '../testing/mock-logger';

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
    expect(() => adapter.syncWindowTheme('dark')).not.toThrow();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('attempts the native call when running inside Tauri', () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = { invoke: vi.fn() };
    expect(() => adapter.syncWindowTheme('light')).not.toThrow();
  });
});
