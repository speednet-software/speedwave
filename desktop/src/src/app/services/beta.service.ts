import { Injectable, inject, signal, type Signal } from '@angular/core';
import { TauriService } from './tauri.service';

/**
 * Beta-features toggle (ADR-055). Reads the persisted state from user-config
 * on startup and tracks live toggles emitted by the tray menu via the
 * `beta-changed` Tauri event. UI surfaces gate hidden / work-in-progress
 * sections on `enabled()`. Default = `false` when running outside Tauri
 * (e.g. Karma/Vitest unit tests).
 */
@Injectable({ providedIn: 'root' })
export class BetaService {
  private readonly tauri = inject(TauriService);
  private readonly state = signal<boolean>(false);

  /** Read-only signal of the active beta-features state. */
  readonly enabled: Signal<boolean> = this.state.asReadonly();

  /** Seeds the state from `get_beta_enabled` and subscribes to `beta-changed`. */
  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      const value = await this.tauri.invoke<boolean>('get_beta_enabled');
      this.state.set(value);
    } catch {
      // No Tauri host (web tests) or command not registered yet — stay off.
    }
    try {
      await this.tauri.listen<boolean>('beta-changed', (event) => {
        this.state.set(event.payload);
      });
    } catch {
      // Ignore — listen() throws only when the Tauri event bus is absent.
    }
  }
}
