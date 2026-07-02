import { inject, Injectable, OnDestroy, signal, type Signal } from '@angular/core';
import { warn as pluginLogWarn } from '@tauri-apps/plugin-log';
import { NativeThemeAdapter, type EffectiveMode } from './native-theme-adapter';

export type { EffectiveMode } from './native-theme-adapter';

/** Identifiers for every accent theme exposed in Settings → Appearance. */
export type ThemeId = 'ember' | 'crimson' | 'mint' | 'iris' | 'cyan' | 'sand';

/** Display order for the Appearance accent picker. Ember is first and default. */
export const THEME_IDS: readonly ThemeId[] = [
  'ember',
  'crimson',
  'mint',
  'iris',
  'cyan',
  'sand',
] as const;

/** Appearance modes — light/dark are explicit, auto follows `prefers-color-scheme`. */
export type ThemeMode = 'light' | 'dark' | 'auto';

/** Display order for the MODE picker in Appearance. */
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'auto'] as const;

/** localStorage key for the accent theme. Exported so tests assert the real key (no drift). */
export const THEME_STORAGE_KEY = 'speedwave-theme';
/** localStorage key for the appearance mode. Exported so tests assert the real key (no drift). */
export const MODE_STORAGE_KEY = 'speedwave-theme-mode';

/**
 * Persists a value to localStorage, tolerating private-mode / quota failures.
 * @param key localStorage key to write.
 * @param value Value to store.
 */
function safePersist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / disabled storage — ignore. */
  }
}

/**
 * Reads a persisted choice, validating it against an allowlist.
 * @param key localStorage key to read.
 * @param allowlist Permitted values; anything else falls back.
 * @param fallback Value returned for missing / unknown / unreadable entries.
 */
function readStoredChoice<T extends string>(key: string, allowlist: readonly T[], fallback: T): T {
  let saved: string | null;
  try {
    saved = localStorage.getItem(key);
  } catch {
    saved = null;
  }
  return (allowlist as readonly string[]).includes(saved ?? '') ? (saved as T) : fallback;
}

/**
 * Applies a theme to <html> and persists it. Ember is the default → no attr written.
 * @param id Accent theme to activate and persist.
 */
function writeTheme(id: ThemeId): void {
  const html = document.documentElement;
  if (id === 'ember') {
    html.removeAttribute('data-theme');
  } else {
    html.setAttribute('data-theme', id);
  }
  safePersist(THEME_STORAGE_KEY, id);
}

/** Defensive matchMedia accessor — undefined in SSR and some test environments. */
function getDarkMQ(): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
  } catch (err) {
    pluginLogWarn(`ThemeService: matchMedia unavailable: ${String(err)}`).catch(() => {});
    return null;
  }
}

/**
 * Resolves `auto` to the effective mode via `prefers-color-scheme`; light/dark pass through.
 * @param mode User-selected appearance mode.
 */
function resolveEffectiveMode(mode: ThemeMode): EffectiveMode {
  if (mode === 'light' || mode === 'dark') return mode;
  return getDarkMQ()?.matches ? 'dark' : 'light';
}

/**
 * Toggles `.dark` on <html> to match the effective mode.
 * @param effective Resolved light/dark mode.
 */
function applyModeClass(effective: EffectiveMode): void {
  const html = document.documentElement;
  if (effective === 'dark') {
    html.classList.add('dark');
  } else {
    html.classList.remove('dark');
  }
}

/**
 * SSOT for the active accent theme and appearance mode.
 *
 * Two orthogonal axes:
 * - **Accent** ({@link theme}) — six named variants selected by `[data-theme]`
 *   on <html>, chosen from the Appearance picker.
 * - **Mode** ({@link mode}) — light/dark/auto, toggling `.dark` on <html>.
 *   `auto` reacts to `prefers-color-scheme` changes at runtime.
 *
 * Native window chrome sync is delegated to {@link NativeThemeAdapter}.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService implements OnDestroy {
  private readonly native = inject(NativeThemeAdapter);

  private readonly themeSignal = signal<ThemeId>(
    readStoredChoice(THEME_STORAGE_KEY, THEME_IDS, 'ember')
  );
  private readonly modeSignal = signal<ThemeMode>(
    readStoredChoice(MODE_STORAGE_KEY, THEME_MODES, 'dark')
  );

  /** Read-only signal of the current accent theme id. */
  readonly theme: Signal<ThemeId> = this.themeSignal.asReadonly();
  /** Read-only signal of the current appearance mode (light/dark/auto). */
  readonly mode: Signal<ThemeMode> = this.modeSignal.asReadonly();

  private readonly mediaQuery = getDarkMQ();
  private readonly mediaListener = (): void => {
    if (this.modeSignal() === 'auto') this.applyMode('auto');
  };
  private readonly abortController = new AbortController();

  /**
   * Reflects the persisted theme + mode onto the DOM and subscribes to system
   * theme changes (active only while {@link mode} === `'auto'`).
   */
  constructor() {
    writeTheme(this.themeSignal());
    this.applyMode(this.modeSignal());

    if (this.mediaQuery) {
      if (typeof this.mediaQuery.addEventListener === 'function') {
        this.mediaQuery.addEventListener('change', this.mediaListener, {
          signal: this.abortController.signal,
        });
      } else if (typeof this.mediaQuery.addListener === 'function') {
        // Legacy WebView fallback; cleaned up in ngOnDestroy
        this.mediaQuery.addListener(this.mediaListener);
      }
    }
  }

  /** Removes the matchMedia listener when the root service is torn down. */
  ngOnDestroy(): void {
    this.abortController.abort();
    // Legacy fallback teardown (only when addEventListener unavailable)
    if (this.mediaQuery && typeof this.mediaQuery.addEventListener !== 'function') {
      try {
        this.mediaQuery.removeListener?.(this.mediaListener);
      } catch {
        /* removeListener may be a hard error on some legacy hosts — ignore. */
      }
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

  /**
   * Switches the appearance mode and persists the choice.
   * @param mode Mode to activate; no-op if already active.
   */
  setMode(mode: ThemeMode): void {
    if (this.modeSignal() === mode) return;
    this.modeSignal.set(mode);
    this.applyMode(mode);
    safePersist(MODE_STORAGE_KEY, mode);
  }

  /**
   * Resolves effective mode, applies DOM class, syncs native chrome.
   * Does NOT persist; persistence is in {@link setMode} (explicit user intent only).
   * @param mode Mode to apply (light/dark/auto).
   */
  private applyMode(mode: ThemeMode): void {
    const effective = resolveEffectiveMode(mode);
    applyModeClass(effective);
    this.native.syncWindowTheme(effective);
  }
}
