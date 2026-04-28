import { TestBed } from '@angular/core/testing';
import { ThemeService, THEME_IDS, type ThemeId } from './theme.service';

const STORAGE_KEY = 'speedwave-theme';

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
});
