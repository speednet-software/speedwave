/**
 * Alignment guard: the anti-FOUC inline script in index.html hardcodes the mode storage
 * key and the first-run default; both must match theme.service.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSrcRoot } from './testing/src-root';
import { MODE_STORAGE_KEY } from './services/theme.service';

const SRC_ROOT = findSrcRoot();
const INDEX_HTML = readFileSync(join(SRC_ROOT, 'index.html'), 'utf-8');
const THEME_SERVICE = readFileSync(join(SRC_ROOT, 'app', 'services', 'theme.service.ts'), 'utf-8');

/**
 * Extracts a single-quoted literal assigned to an exported const in theme.service.ts.
 * @param constName - Name of the exported const.
 * @returns The literal's value.
 */
function serviceLiteral(constName: string): string {
  const match = new RegExp(`export const ${constName}[^=]*=\\s*'([^']+)'`).exec(THEME_SERVICE);
  if (!match) throw new Error(`theme.service.ts: no single-quoted literal for ${constName}`);
  return match[1];
}

describe('anti-FOUC script ↔ theme.service.ts alignment', () => {
  it('reads the storage key the service writes', () => {
    expect(INDEX_HTML).toContain(`localStorage.getItem('${serviceLiteral('MODE_STORAGE_KEY')}')`);
  });

  it('falls back to the same first-run default as the service', () => {
    expect(INDEX_HTML).toContain(`: '${serviceLiteral('DEFAULT_THEME_MODE')}'`);
  });

  it('resolves auto against the OS preference before the app boots', () => {
    expect(INDEX_HTML).toContain("window.matchMedia('(prefers-color-scheme: dark)').matches");
  });

  it('fails loudly when a const literal is missing', () => {
    expect(() => serviceLiteral('NO_SUCH_CONST')).toThrow(/no single-quoted literal/);
  });
});

/**
 * Extracts the inline `<script>` body from index.html.
 * @returns The script source, without the surrounding tags.
 */
function inlineScriptSource(): string {
  const match = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/i.exec(INDEX_HTML);
  if (!match) throw new Error('index.html: no inline anti-FOUC script found');
  return match[1];
}

/** Executes the real anti-FOUC source against the current DOM and globals. */
function runAntiFoucScript(): void {
  new Function(inlineScriptSource())();
}

/**
 * Stubs `window.matchMedia` with a fixed `(prefers-color-scheme: dark)` answer.
 * @param prefersDark - Value the stub reports as `matches`.
 * @returns Callback restoring the previous `matchMedia`.
 */
function stubMatchMedia(prefersDark: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: prefersDark }) as unknown as MediaQueryList,
  });
  return () => {
    if (original) {
      Object.defineProperty(window, 'matchMedia', original);
    } else {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
    }
  };
}

describe('anti-FOUC script behavior', () => {
  let restoreMedia: () => void = () => undefined;
  let originalLocalStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    restoreMedia();
    restoreMedia = () => undefined;
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    }
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  // Happy paths — first run (empty storage) follows the OS, both directions.
  it('paints light on a first run under a light system', () => {
    restoreMedia = stubMatchMedia(false);
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('paints dark on a first run under a dark system', () => {
    restoreMedia = stubMatchMedia(true);
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('never persists a mode the user did not choose', () => {
    restoreMedia = stubMatchMedia(true);
    runAntiFoucScript();
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBeNull();
  });

  it('honours a stored light choice on a dark system', () => {
    localStorage.setItem(MODE_STORAGE_KEY, 'light');
    restoreMedia = stubMatchMedia(true);
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('honours a stored dark choice on a light system', () => {
    localStorage.setItem(MODE_STORAGE_KEY, 'dark');
    restoreMedia = stubMatchMedia(false);
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('resolves a stored auto against the system preference', () => {
    localStorage.setItem(MODE_STORAGE_KEY, 'auto');
    restoreMedia = stubMatchMedia(true);
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    restoreMedia();
    document.documentElement.classList.remove('dark');
    restoreMedia = stubMatchMedia(false);
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  // Edge cases
  it('treats an empty stored value as the first-run default', () => {
    localStorage.setItem(MODE_STORAGE_KEY, '');
    restoreMedia = stubMatchMedia(true);
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  // Only light/dark are explicit user choices; anything else is the auto default,
  // matching readStoredChoice's allowlist in theme.service.ts.
  it('treats an unknown stored value as auto and follows the system', () => {
    localStorage.setItem(MODE_STORAGE_KEY, 'sepia');
    restoreMedia = stubMatchMedia(true);
    runAntiFoucScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  // Error paths — the catch branch must leave the document light, never throw.
  it('stays light and silent when localStorage reads throw', () => {
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
    restoreMedia = stubMatchMedia(true);
    expect(() => runAntiFoucScript()).not.toThrow();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('stays light and silent when matchMedia is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
    restoreMedia = () => {
      if (original) Object.defineProperty(window, 'matchMedia', original);
    };
    expect(() => runAntiFoucScript()).not.toThrow();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
