import { Injectable, signal, type Signal } from '@angular/core';

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

/** localStorage key — kept out of the public API to avoid drift between read/write. */
const STORAGE_KEY = 'speedwave-theme';

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
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* private mode / disabled storage — ignore. */
  }
}

/** Reads the persisted theme, falling back to crimson on unknown / missing values. */
function readInitialTheme(): ThemeId {
  let saved: string | null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    saved = null;
  }
  return (THEME_IDS as readonly string[]).includes(saved ?? '') ? (saved as ThemeId) : 'crimson';
}

/**
 * SSOT for the active accent theme.
 *
 * The mockup ships six themes (`crimson` default + five named variants) selected
 * by `data-theme` on the document element. Backgrounds stay neutral; only the
 * accent family rotates. Persistence lives in localStorage so the choice
 * survives reloads.
 *
 * Consumers:
 * - `SettingsComponent → Appearance` renders a card grid bound to {@link theme}
 *   and calls {@link setTheme}.
 * - `ShellComponent` registers the ⌘T keyboard shortcut and calls {@link cycle}.
 * - `CommandPaletteComponent` exposes "change accent color..." which routes to
 *   the same setter.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly themeSignal = signal<ThemeId>(readInitialTheme());

  /** Read-only signal of the current theme id. */
  readonly theme: Signal<ThemeId> = this.themeSignal.asReadonly();

  /**
   * Reflects the persisted theme choice on the DOM at app startup.
   */
  constructor() {
    // Reflect the persisted choice to the DOM on app startup.
    writeTheme(this.themeSignal());
  }

  /**
   * Switches to a specific theme and persists the choice.
   * @param id Theme to activate; no-op if already active.
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
}
