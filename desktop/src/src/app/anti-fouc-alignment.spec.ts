import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSrcRoot } from './testing/src-root';
import { mockMatchMedia } from './testing/mock-match-media';
import { MODE_STORAGE_KEY, DEFAULT_THEME_MODE } from './services/theme.service';

const SRC_ROOT = findSrcRoot();
const INDEX_HTML = readFileSync(join(SRC_ROOT, 'index.html'), 'utf-8');

function inlineScriptSource(): string {
  const match = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/i.exec(INDEX_HTML);
  if (!match) throw new Error('index.html: no inline anti-FOUC script found');
  return match[1];
}

function runAntiFoucScript(): void {
  new Function(inlineScriptSource())();
}

describe('anti-FOUC script behavior', () => {
  let restoreMedia: () => void = () => undefined;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    restoreMedia();
    restoreMedia = () => undefined;
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('paints light on a first run under a light system', () => {
    restoreMedia = mockMatchMedia(false).restore;
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('paints dark on a first run under a dark system', () => {
    restoreMedia = mockMatchMedia(true).restore;
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('follows DEFAULT_THEME_MODE on first run, derived from the real constant', () => {
    for (const prefersDark of [false, true]) {
      restoreMedia = mockMatchMedia(prefersDark).restore;
      runAntiFoucScript();
      const expectedDark =
        DEFAULT_THEME_MODE === 'dark' || (DEFAULT_THEME_MODE === 'auto' && prefersDark);
      expect(document.documentElement.classList.contains('dark')).toBe(expectedDark);
      restoreMedia();
      document.documentElement.classList.remove('dark');
    }
  });

  it('honours a stored light choice on a dark system', () => {
    localStorage.setItem(MODE_STORAGE_KEY, 'light');
    restoreMedia = mockMatchMedia(true).restore;
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('honours a stored dark choice on a light system', () => {
    localStorage.setItem(MODE_STORAGE_KEY, 'dark');
    restoreMedia = mockMatchMedia(false).restore;
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('resolves a stored auto against the system preference', () => {
    localStorage.setItem(MODE_STORAGE_KEY, 'auto');
    restoreMedia = mockMatchMedia(true).restore;
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    restoreMedia();
    document.documentElement.classList.remove('dark');
    restoreMedia = mockMatchMedia(false).restore;
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('treats an empty stored value as the first-run default', () => {
    localStorage.setItem(MODE_STORAGE_KEY, '');
    restoreMedia = mockMatchMedia(true).restore;
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('treats an unknown stored value as auto and follows the system', () => {
    localStorage.setItem(MODE_STORAGE_KEY, 'sepia');
    restoreMedia = mockMatchMedia(true).restore;
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('falls back to the system preference when localStorage reads throw', () => {
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: () => {
          throw new Error('storage disabled');
        },
        setItem: () => undefined,
        removeItem: () => undefined,
        clear: () => undefined,
        key: () => null,
        length: 0,
      } satisfies Storage,
    });
    try {
      restoreMedia = mockMatchMedia(true).restore;
      expect(() => runAntiFoucScript()).not.toThrow();
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    } finally {
      if (originalLocalStorage) {
        Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
      }
    }
  });

  it('stays light and silent when matchMedia is unavailable', () => {
    expect(window.matchMedia).toBeUndefined();
    expect(() => runAntiFoucScript()).not.toThrow();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('stays light and silent when both localStorage and matchMedia are unavailable', () => {
    expect(window.matchMedia).toBeUndefined();
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: () => {
          throw new Error('storage disabled');
        },
        setItem: () => undefined,
        removeItem: () => undefined,
        clear: () => undefined,
        key: () => null,
        length: 0,
      } satisfies Storage,
    });
    try {
      expect(() => runAntiFoucScript()).not.toThrow();
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    } finally {
      if (originalLocalStorage) {
        Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
      }
    }
  });
});
