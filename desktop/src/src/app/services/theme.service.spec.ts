import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { NativeThemeAdapter } from './native-theme-adapter';
import {
  ThemeService,
  THEME_MODES,
  THEME_STORAGE_KEY,
  MODE_STORAGE_KEY,
  applyPersistedThemeOnStartup,
  type ThemeId,
  type ThemeMode,
} from './theme.service';

/**
 * Installs a controllable `matchMedia` on `window`; returns `fireChange` to simulate OS
 * theme toggles and `restore` to remove the stub.
 * @param prefersDark - Initial `matches` for `(prefers-color-scheme: dark)`.
 */
function mockMatchMedia(prefersDark: boolean): {
  fireChange: (prefersDarkNow: boolean) => void;
  restore: () => void;
} {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mq = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (
      _: string,
      fn: (e: MediaQueryListEvent) => void,
      options?: { signal?: AbortSignal }
    ) => {
      listeners.add(fn);
      options?.signal?.addEventListener('abort', () => listeners.delete(fn));
    },
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    addListener: (fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeListener: (fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => mq,
  });
  return {
    fireChange: (prefersDarkNow: boolean) => {
      (mq as unknown as { matches: boolean }).matches = prefersDarkNow;
      for (const fn of listeners) fn({ matches: prefersDarkNow } as MediaQueryListEvent);
    },
    restore: () => {
      if (original) {
        Object.defineProperty(window, 'matchMedia', original);
      } else {
        Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
      }
    },
  };
}

/** Build a fresh in-memory `Storage`-shaped object for each test. */
function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    key: (index: number) => Array.from(data.keys())[index] ?? null,
  };
}

describe('ThemeService', () => {
  let originalLocalStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: makeMemoryStorage(),
    });
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis as Record<string, unknown>, 'localStorage');
    }
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.remove('dark');
  });

  function create(): ThemeService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return TestBed.inject(ThemeService);
  }

  it('defaults to ember when nothing is stored and removes data-theme', () => {
    const svc = create();
    expect(svc.theme()).toBe<ThemeId>('ember');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('hydrates a previously persisted theme from localStorage', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'mint');
    const svc = create();
    expect(svc.theme()).toBe<ThemeId>('mint');
    expect(document.documentElement.getAttribute('data-theme')).toBe('mint');
  });

  it('writes data-theme + persists when setTheme switches to a non-default theme', () => {
    const svc = create();
    svc.setTheme('crimson');
    expect(svc.theme()).toBe<ThemeId>('crimson');
    expect(document.documentElement.getAttribute('data-theme')).toBe('crimson');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('crimson');
  });

  it('removes data-theme when switching back to the ember default', () => {
    const svc = create();
    svc.setTheme('crimson');
    svc.setTheme('ember');
    expect(svc.theme()).toBe<ThemeId>('ember');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('ember');
  });

  it('treats unknown stored values as ember', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'bogus');
    const svc = create();
    expect(svc.theme()).toBe<ThemeId>('ember');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('treats a previously persisted amber (now removed) as the ember default', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'amber');
    const svc = create();
    expect(svc.theme()).toBe<ThemeId>('ember');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('treats an empty stored value as ember', () => {
    localStorage.setItem(THEME_STORAGE_KEY, '');
    const svc = create();
    expect(svc.theme()).toBe<ThemeId>('ember');
  });

  it('is a no-op when setTheme is called with the current theme', () => {
    const svc = create();
    svc.setTheme('mint');
    const callsBefore = localStorage.getItem(THEME_STORAGE_KEY);
    svc.setTheme('mint');
    expect(svc.theme()).toBe<ThemeId>('mint');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(callsBefore);
  });

  it('survives a localStorage write failure without throwing', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
        removeItem: () => undefined,
        clear: () => undefined,
        key: () => null,
        length: 0,
      } satisfies Storage,
    });

    const svc = create();
    expect(() => svc.setTheme('crimson')).not.toThrow();
    expect(svc.theme()).toBe<ThemeId>('crimson');
    expect(document.documentElement.getAttribute('data-theme')).toBe('crimson');
  });

  describe('mode axis', () => {
    let media: ReturnType<typeof mockMatchMedia>;

    beforeEach(() => {
      media = mockMatchMedia(false);
    });

    afterEach(() => {
      media.restore();
    });

    it('defaults to dark when no mode is persisted (first run)', () => {
      const svc = create();
      expect(svc.mode()).toBe<ThemeMode>('dark');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('setMode("light") removes .dark and persists the choice', () => {
      const svc = create();
      svc.setMode('light');
      expect(svc.mode()).toBe<ThemeMode>('light');
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('light');
    });

    it('setMode("dark") adds .dark and persists the choice', () => {
      const svc = create();
      svc.setMode('light');
      svc.setMode('dark');
      expect(svc.mode()).toBe<ThemeMode>('dark');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('dark');
    });

    it('hydrates persisted "light" mode at startup, beating system dark preference', () => {
      media.restore();
      media = mockMatchMedia(true);
      localStorage.setItem(MODE_STORAGE_KEY, 'light');
      const svc = create();
      expect(svc.mode()).toBe<ThemeMode>('light');
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('treats unknown stored mode as dark', () => {
      localStorage.setItem(MODE_STORAGE_KEY, 'sepia');
      const svc = create();
      expect(svc.mode()).toBe<ThemeMode>('dark');
    });

    it('setMode("auto") with prefers-color-scheme=dark adds .dark while keeping mode()==="auto"', () => {
      media.restore();
      media = mockMatchMedia(true);
      const svc = create();
      svc.setMode('auto');
      expect(svc.mode()).toBe<ThemeMode>('auto');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('setMode("auto") with prefers-color-scheme=light removes .dark while keeping mode()==="auto"', () => {
      const svc = create();
      svc.setMode('auto');
      expect(svc.mode()).toBe<ThemeMode>('auto');
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('is a no-op when setMode is called with the current mode', () => {
      const svc = create();
      svc.setMode('light');
      const persisted = localStorage.getItem(MODE_STORAGE_KEY);
      svc.setMode('light');
      expect(svc.mode()).toBe<ThemeMode>('light');
      expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe(persisted);
    });

    it('hydrates persisted "auto" mode at startup, applying system dark preference', () => {
      media.restore();
      media = mockMatchMedia(true);
      localStorage.setItem(MODE_STORAGE_KEY, 'auto');
      const svc = create();
      expect(svc.mode()).toBe<ThemeMode>('auto');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('stops reacting to prefers-color-scheme changes after ngOnDestroy', () => {
      const svc = create();
      svc.setMode('auto');
      svc.ngOnDestroy();
      media.fireChange(true);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    function createWithNative(): { svc: ThemeService; sync: ReturnType<typeof vi.fn> } {
      const sync = vi.fn();
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [{ provide: NativeThemeAdapter, useValue: { syncWindowTheme: sync } }],
      });
      return { svc: TestBed.inject(ThemeService), sync };
    }

    it('pins the native window only in explicit modes and hands it to the OS in auto', () => {
      const { svc, sync } = createWithNative();
      expect(sync).toHaveBeenLastCalledWith('dark');
      svc.setMode('light');
      expect(sync).toHaveBeenLastCalledWith('light');
      svc.setMode('auto');
      expect(sync).toHaveBeenLastCalledWith(null);
      svc.setMode('dark');
      expect(sync).toHaveBeenLastCalledWith('dark');
    });

    it('never pins the native window while auto follows prefers-color-scheme', () => {
      localStorage.setItem(MODE_STORAGE_KEY, 'auto');
      const { sync } = createWithNative();
      expect(sync).toHaveBeenLastCalledWith(null);
      media.fireChange(true);
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      media.fireChange(false);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(sync).toHaveBeenCalledTimes(3);
      for (const call of sync.mock.calls) expect(call).toEqual([null]);
    });

    it('reacts to prefers-color-scheme changes while in auto mode', () => {
      const svc = create();
      svc.setMode('auto');
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      media.fireChange(true);
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      media.fireChange(false);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('ignores prefers-color-scheme changes when mode is explicit (light)', () => {
      const svc = create();
      svc.setMode('light');
      media.fireChange(true);
      expect(svc.mode()).toBe<ThemeMode>('light');
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('setMode does not touch the accent theme', () => {
      const svc = create();
      svc.setTheme('mint');
      svc.setMode('light');
      expect(svc.theme()).toBe<ThemeId>('mint');
      expect(document.documentElement.getAttribute('data-theme')).toBe('mint');
    });

    it('setTheme does not touch the mode class or signal', () => {
      const svc = create();
      svc.setMode('light');
      svc.setTheme('iris');
      expect(svc.mode()).toBe<ThemeMode>('light');
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('survives a localStorage write failure for mode without throwing', () => {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: {
          getItem: () => null,
          setItem: () => {
            throw new Error('quota');
          },
          removeItem: () => undefined,
          clear: () => undefined,
          key: () => null,
          length: 0,
        } satisfies Storage,
      });
      const svc = create();
      expect(() => svc.setMode('light')).not.toThrow();
      expect(svc.mode()).toBe<ThemeMode>('light');
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('falls back to light when matchMedia is unavailable and mode is auto', () => {
      media.restore();
      const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
      try {
        const svc = create();
        svc.setMode('auto');
        expect(svc.mode()).toBe<ThemeMode>('auto');
        expect(document.documentElement.classList.contains('dark')).toBe(false);
      } finally {
        if (original) Object.defineProperty(window, 'matchMedia', original);
      }
    });

    it('THEME_MODES is the canonical list', () => {
      expect(THEME_MODES).toEqual(['light', 'dark', 'auto']);
    });

    it('MODE_STORAGE_KEY matches the literal used by the anti-FOUC script', () => {
      expect(MODE_STORAGE_KEY).toBe('speedwave-theme-mode');
    });

    it('does not re-persist while in auto mode on system theme changes', () => {
      const svc = create();
      svc.setMode('auto');
      localStorage.removeItem(MODE_STORAGE_KEY);
      media.fireChange(true);
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(localStorage.getItem(MODE_STORAGE_KEY)).toBeNull();
    });

    it('cleans up via removeListener when addEventListener is absent (legacy WebKit)', () => {
      media.restore();
      const listeners = new Set<(e: MediaQueryListEvent) => void>();
      const legacyMq = {
        matches: false,
        media: '(prefers-color-scheme: dark)',
        onchange: null,
        addListener: (fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
        removeListener: (fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
      const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: () => legacyMq,
      });
      try {
        const svc = create();
        svc.setMode('auto');
        expect(listeners.size).toBe(1);
        svc.ngOnDestroy();
        expect(listeners.size).toBe(0);
        for (const fn of listeners) fn({ matches: true } as MediaQueryListEvent);
        expect(document.documentElement.classList.contains('dark')).toBe(false);
      } finally {
        if (original) Object.defineProperty(window, 'matchMedia', original);
      }
    });
  });
  describe('applyPersistedThemeOnStartup', () => {
    function runInitializer(): void {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({});
      TestBed.runInInjectionContext(() => applyPersistedThemeOnStartup());
    }

    it('applies the persisted accent theme to <html> at boot without opening Settings', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'iris');
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
      runInitializer();
      expect(document.documentElement.getAttribute('data-theme')).toBe('iris');
    });

    it('leaves data-theme unset when the persisted theme is the ember default', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'ember');
      runInitializer();
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    });

    it('hydrates the root singleton so a later injection reflects the boot theme', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'cyan');
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({});
      TestBed.runInInjectionContext(() => applyPersistedThemeOnStartup());
      const svc = TestBed.inject(ThemeService);
      expect(svc.theme()).toBe<ThemeId>('cyan');
      expect(document.documentElement.getAttribute('data-theme')).toBe('cyan');
    });
  });
});
