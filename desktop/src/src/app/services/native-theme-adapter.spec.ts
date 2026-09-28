import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { NativeThemeAdapter } from './native-theme-adapter';
import { LoggerService } from './logger.service';
import { makeMockLogger } from '../testing/mock-logger';

const setThemeMock = vi.hoisted(() => vi.fn<(theme: 'light' | 'dark' | null) => Promise<void>>());

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTheme: setThemeMock }),
}));

describe('NativeThemeAdapter', () => {
  let adapter: NativeThemeAdapter;
  let mockLogger: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    setThemeMock.mockReset();
    setThemeMock.mockResolvedValue(undefined);
    mockLogger = makeMockLogger();
    TestBed.configureTestingModule({
      providers: [NativeThemeAdapter, { provide: LoggerService, useValue: mockLogger }],
    });
    adapter = TestBed.inject(NativeThemeAdapter);
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  });

  function enterTauri(): void {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = { invoke: vi.fn() };
  }

  it('is a no-op outside Tauri (no native call, no log)', async () => {
    expect(() => adapter.syncWindowTheme('dark')).not.toThrow();
    await Promise.resolve();
    expect(setThemeMock).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('pins the native window to an explicit mode', async () => {
    enterTauri();
    adapter.syncWindowTheme('light');
    await vi.waitFor(() => expect(setThemeMock).toHaveBeenCalledWith('light'));
  });

  it('hands the native window back to the OS for null (auto mode)', async () => {
    enterTauri();
    adapter.syncWindowTheme(null);
    await vi.waitFor(() => expect(setThemeMock).toHaveBeenCalledWith(null));
  });

  it('logs a rejected native call instead of throwing', async () => {
    enterTauri();
    setThemeMock.mockRejectedValue(new Error('window.set_theme not allowed'));
    expect(() => adapter.syncWindowTheme('dark')).not.toThrow();
    await vi.waitFor(() =>
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('window.set_theme not allowed')
      )
    );
  });
});
