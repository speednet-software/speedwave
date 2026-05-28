import { TestBed } from '@angular/core/testing';
import {
  ThemeService,
  THEME_IDS,
  THEME_MODES,
  type ThemeId,
  type ThemeMode,
} from './theme.service';

const STORAGE_KEY = 'speedwave-theme';
const MODE_STORAGE_KEY = 'speedwave-theme-mode';

/**
 * Installs a controllable `matchMedia` on `window`. Returns the mock plus a
 * `fireChange` helper that simulates a system theme toggle.
 * @param prefersDark Initial `matches` value for `(prefers-color-scheme: dark)`.
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
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
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

/**
 * Build a fresh in-memory `Storage`-shaped object for each test. Some test
 * runner / Node combinations (notably odd-numbered Node releases under the
 * `--localstorage-file` experimental flag) leave the global `localStorage`
 * accessor with an unusable shape — `getItem` / `setItem` may be missing or
 * throw. Installing our own implementation per-test removes that variance
 * and gives us deterministic state regardless of jsdom version.
 */
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

  // Happy path
  it('defaults to crimson when nothing is stored and removes data-theme', () => {
    const svc = create();
    expect(svc.theme()).toBe<ThemeId>('crimson');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('hydrates a previously persisted theme from localStorage', () => {
    localStorage.setItem(STORAGE_KEY, 'mint');
    const svc = create();
    expect(svc.theme()).toBe<ThemeId>('mint');
    expect(document.documentElement.getAttribute('data-theme')).toBe('mint');
  });

  it('writes data-theme + persists when setTheme switches to a non-default theme', () => {
    const svc = create();
    svc.setTheme('amber');
    expect(svc.theme()).toBe<ThemeId>('amber');
    expect(document.documentElement.getAttribute('data-theme')).toBe('amber');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('amber');
  });

  it('removes data-theme when switching back to the crimson default', () => {
    const svc = create();
    svc.setTheme('amber');
    svc.setTheme('crimson');
    expect(svc.theme()).toBe<ThemeId>('crimson');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('crimson');
  });

  // Edge cases
  it('treats unknown stored values as crimson', () => {
    localStorage.setItem(STORAGE_KEY, 'bogus');
    const svc = create();
    expect(svc.theme()).toBe<ThemeId>('crimson');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('treats an empty stored value as crimson', () => {
    localStorage.setItem(STORAGE_KEY, '');
    const svc = create();
    expect(svc.theme()).toBe<ThemeId>('crimson');
  });

  it('is a no-op when setTheme is called with the current theme', () => {
    const svc = create();
    svc.setTheme('mint');
    const callsBefore = localStorage.getItem(STORAGE_KEY);
    svc.setTheme('mint');
    expect(svc.theme()).toBe<ThemeId>('mint');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(callsBefore);
  });

  // State transitions — cycle()
  it('cycle() advances through THEME_IDS in order', () => {
    const svc = create();
    const seen: ThemeId[] = [svc.theme()];
    for (let i = 0; i < THEME_IDS.length; i += 1) {
      svc.cycle();
      seen.push(svc.theme());
    }
    expect(seen[0]).toBe<ThemeId>('crimson');
    expect(seen.slice(1, 1 + THEME_IDS.length)).toEqual([
      'mint',
      'amber',
      'iris',
      'cyan',
      'sand',
      'crimson',
    ] as ThemeId[]);
  });

  // Error path — corrupted localStorage
  it('survives a localStorage write failure without throwing', () => {
    // Reinstall a storage whose setItem always throws.
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
    expect(() => svc.setTheme('amber')).not.toThrow();
    expect(svc.theme()).toBe<ThemeId>('amber');
    expect(document.documentElement.getAttribute('data-theme')).toBe('amber');
  });

  // ── Mode axis (light / dark / auto) ──────────────────────────────────────

  describe('mode axis', () => {
    let media: ReturnType<typeof mockMatchMedia>;

    beforeEach(() => {
      media = mockMatchMedia(false);
    });

    afterEach(() => {
      media.restore();
    });

    // Happy paths
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

    // Edge cases
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
      svc.setMode('light');
      expect(svc.mode()).toBe<ThemeMode>('light');
    });

    // State transitions
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

    // Independence of axes
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

    // Error paths
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
  });
});
