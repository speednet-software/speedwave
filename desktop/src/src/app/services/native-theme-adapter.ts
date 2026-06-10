import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';

/** Effective (resolved) appearance — `auto` has already been collapsed to one of these. */
export type EffectiveMode = 'light' | 'dark';

/**
 * Bridges the resolved appearance mode to the native window chrome.
 *
 * Isolated from {@link ThemeService} so the service owns only signal state and
 * DOM/localStorage writes — the Tauri platform call lives here and can be
 * swapped or stubbed in tests. On macOS this drives the traffic-light glyph
 * appearance; on non-Tauri hosts (web preview, jsdom) it is a no-op.
 */
@Injectable({ providedIn: 'root' })
export class NativeThemeAdapter {
  private log = inject(LoggerService);

  /**
   * Pushes the effective mode to the native window. Dynamically imports the
   * Tauri window API so test runners without the runtime don't load the module.
   * Best-effort: failures are logged, never thrown.
   * @param effective Resolved light/dark mode to apply to the native window.
   */
  syncWindowTheme(effective: EffectiveMode): void {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(effective))
      .catch((err: unknown) => {
        // Best-effort native chrome sync; log so bundle/IPC failures stay diagnosable.
        this.log.warn(`NativeThemeAdapter: setTheme failed: ${String(err)}`);
      });
  }
}
