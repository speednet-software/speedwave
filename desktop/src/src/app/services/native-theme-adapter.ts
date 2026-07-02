import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';

/** Effective (resolved) appearance — `auto` has already been collapsed to one of these. */
export type EffectiveMode = 'light' | 'dark';

/** Bridges the resolved appearance mode to the native window chrome (no-op on non-Tauri hosts). */
@Injectable({ providedIn: 'root' })
export class NativeThemeAdapter {
  private log = inject(LoggerService);

  /**
   * Pushes the effective mode to the native window; best-effort, never throws.
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
