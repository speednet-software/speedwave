import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal, type Signal } from '@angular/core';
import type { UnlistenFn } from '@tauri-apps/api/event';

import { TauriService } from './tauri.service';

export const WINDOW_FOCUSED_EVENT = 'window_focused';

/** Whether the app window holds the system focus, i.e. whether the user can see the active chat tab. */
@Injectable({ providedIn: 'root' })
export class WindowFocusService {
  private readonly document = inject(DOCUMENT);
  private readonly tauri = inject(TauriService);
  private readonly focusedSignal = signal(this.document.hasFocus());

  /** False while the window is hidden, minimized or behind another window. */
  readonly focused: Signal<boolean> = this.focusedSignal.asReadonly();

  /** Follows the webview's focus and visibility events, and re-reads them on the backend's focus event. */
  constructor() {
    const view = this.document.defaultView;
    const onFocus = (): void => this.focusedSignal.set(true);
    const onBlur = (): void => this.focusedSignal.set(false);
    const readFocus = (): void =>
      this.focusedSignal.set(
        this.document.visibilityState === 'visible' && this.document.hasFocus()
      );
    view?.addEventListener('focus', onFocus);
    view?.addEventListener('blur', onBlur);
    this.document.addEventListener('visibilitychange', readFocus);
    const backend: Promise<UnlistenFn | null> = this.tauri
      .listen(WINDOW_FOCUSED_EVENT, readFocus)
      .catch(() => null);
    inject(DestroyRef).onDestroy(() => {
      view?.removeEventListener('focus', onFocus);
      view?.removeEventListener('blur', onBlur);
      this.document.removeEventListener('visibilitychange', readFocus);
      void backend.then((stop) => stop?.());
    });
  }
}
