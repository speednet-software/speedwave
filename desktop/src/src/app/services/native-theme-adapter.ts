import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';

/** Effective (resolved) appearance — `auto` has already been collapsed to one of these. */
export type EffectiveMode = 'light' | 'dark';

/** Bridges the appearance mode to the native window chrome (no-op on non-Tauri hosts). */
@Injectable({ providedIn: 'root' })
export class NativeThemeAdapter {
  private log = inject(LoggerService);

  /**
   * Pins the native window to `theme`, or hands it back to the OS when `theme` is null;
   * best-effort, never throws.
   * @param theme Explicit light/dark to pin, or null in auto mode so the window follows the OS.
   */
  syncWindowTheme(theme: EffectiveMode | null): void {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme))
      .catch((err: unknown) => {
        this.log.warn(`NativeThemeAdapter: setTheme failed: ${String(err)}`);
      });
  }
}
