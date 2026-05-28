import { Injectable, OnDestroy, signal, type Signal } from '@angular/core';

/** Identifiers for every accent theme exposed in Settings → Appearance. */
export type ThemeId = 'crimson' | 'mint' | 'amber' | 'iris' | 'cyan' | 'sand';

/** Display order for the ⌘T cycle and the Appearance picker. */
export const THEME_IDS: readonly ThemeId[] = [
  'crimson',
  'mint',
  'amber',
  'iris',
  'cyan',
  'sand',
] as const;

/** Appearance modes — light/dark are explicit, auto follows `prefers-color-scheme`. */
export type ThemeMode = 'light' | 'dark' | 'auto';

/** Display order for the MODE picker in Appearance. */
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'auto'] as const;

/** localStorage keys — kept out of the public API to avoid drift between read/write. */
const THEME_STORAGE_KEY = 'speedwave-theme';
const MODE_STORAGE_KEY = 'speedwave-theme-mode';

/**
 * Applies a theme to <html> and persists it. Crimson is the default → no attr written.
 * @param id Theme to activate and persist to localStorage.
 */
function writeTheme(id: ThemeId): void {
  const html = document.documentElement;
  if (id === 'crimson') {
    html.removeAttribute('data-theme');
  } else {
    html.setAttribute('data-theme', id);
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    /* private mode / disabled storage — ignore. */
  }
}

/** Reads the persisted theme, falling back to crimson on unknown / missing values. */
function readInitialTheme(): ThemeId {
  let saved: string | null;
  try {
    saved = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    saved = null;
  }
  return (THEME_IDS as readonly string[]).includes(saved ?? '') ? (saved as ThemeId) : 'crimson';
}

/** Defensive matchMedia accessor — undefined in SSR and some test environments. */
function getDarkMQ(): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolves `auto` to the effective mode via `prefers-color-scheme`; light/dark pass through.
 * @param mode User-selected appearance mode.
 */
function resolveEffectiveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  return getDarkMQ()?.matches ? 'dark' : 'light';
}

/**
 * Pushes the effective mode to the native window so macOS system glyphs
 * (traffic lights) match the app theme. Dynamically imported so test
 * runners without the Tauri runtime (jsdom) don't pull in the module.
 * @param effective Resolved light/dark mode to apply to the native window.
 */
function syncNativeWindowTheme(effective: 'light' | 'dark'): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(effective))
    .catch(() => {
      /* setTheme is best-effort — silently ignore platform/version errors. */
    });
}

/**
 * Toggles `.dark` on <html> to match the effective mode and persists the choice.
 * @param mode Mode to activate and persist to localStorage.
 */
function writeMode(mode: ThemeMode): void {
  const html = document.documentElement;
  const effective = resolveEffectiveMode(mode);
  if (effective === 'dark') {
    html.classList.add('dark');
  } else {
    html.classList.remove('dark');
  }
  syncNativeWindowTheme(effective);
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* private mode / disabled storage — ignore. */
  }
}

/** Reads the persisted mode, falling back to dark for first-run / unknown values. */
function readInitialMode(): ThemeMode {
  let saved: string | null;
  try {
    saved = localStorage.getItem(MODE_STORAGE_KEY);
  } catch {
    saved = null;
  }
  return (THEME_MODES as readonly string[]).includes(saved ?? '') ? (saved as ThemeMode) : 'dark';
}

/**
 * SSOT for the active accent theme and appearance mode.
 *
 * Two orthogonal axes:
 * - **Accent** ({@link theme}) — six named variants selected by `[data-theme]`
 *   on <html>. ⌘T cycles through them.
 * - **Mode** ({@link mode}) — light/dark/auto, toggling `.dark` on <html>.
 *   `auto` reacts to `prefers-color-scheme` changes at runtime.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService implements OnDestroy {
  private readonly themeSignal = signal<ThemeId>(readInitialTheme());
  private readonly modeSignal = signal<ThemeMode>(readInitialMode());

  /** Read-only signal of the current accent theme id. */
  readonly theme: Signal<ThemeId> = this.themeSignal.asReadonly();
  /** Read-only signal of the current appearance mode (light/dark/auto). */
  readonly mode: Signal<ThemeMode> = this.modeSignal.asReadonly();

  private readonly mediaQuery = getDarkMQ();
  private readonly mediaListener = (): void => {
    if (this.modeSignal() === 'auto') writeMode('auto');
  };
  private readonly abortController = new AbortController();

  /**
   * Reflects the persisted theme + mode onto the DOM and subscribes to system
   * theme changes (active only while {@link mode} === `'auto'`).
   */
  constructor() {
    writeTheme(this.themeSignal());
    writeMode(this.modeSignal());

    if (this.mediaQuery) {
      if (typeof this.mediaQuery.addEventListener === 'function') {
        this.mediaQuery.addEventListener('change', this.mediaListener, {
          signal: this.abortController.signal,
        });
      } else if (typeof (this.mediaQuery as MediaQueryList).addListener === 'function') {
        // Legacy WebView fallback — addListener is deprecated but still required
        // on older WebKit builds shipped in some Tauri targets.
        (this.mediaQuery as MediaQueryList).addListener(this.mediaListener);
      }
    }
  }

  /** Removes the matchMedia listener when the root service is torn down. */
  ngOnDestroy(): void {
    this.abortController.abort();
    if (
      this.mediaQuery &&
      typeof (this.mediaQuery as MediaQueryList).removeListener === 'function'
    ) {
      (this.mediaQuery as MediaQueryList).removeListener(this.mediaListener);
    }
  }

  /**
   * Switches to a specific accent theme and persists the choice.
   * @param id Accent theme to activate; no-op if already active.
   */
  setTheme(id: ThemeId): void {
    if (this.themeSignal() === id) return;
    this.themeSignal.set(id);
    writeTheme(id);
  }

  /** Advances to the next theme in {@link THEME_IDS}, wrapping at the end. ⌘T binds here. */
  cycle(): void {
    const current = this.themeSignal();
    const next = THEME_IDS[(THEME_IDS.indexOf(current) + 1) % THEME_IDS.length];
    this.setTheme(next);
  }

  /**
   * Switches the appearance mode and persists the choice.
   * @param mode Mode to activate; no-op if already active.
   */
  setMode(mode: ThemeMode): void {
    if (this.modeSignal() === mode) return;
    this.modeSignal.set(mode);
    writeMode(mode);
  }
}
