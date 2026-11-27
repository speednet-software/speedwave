import { Injectable, inject, signal } from '@angular/core';
import { TauriService } from './tauri.service';
import {
  FEATURE_FLAGS_CHANGED_EVENT,
  type FeatureFlag,
  type FeatureFlags,
} from '../models/feature-flags';

const ALL_OFF: FeatureFlags = { office: false, telemetry_settings: false };

/**
 * Feature flags (ADR-058): seeds from `get_feature_flags`, follows `feature-flags-changed`;
 * UI gates on `enabled(flag)`. Every flag is off outside Tauri (e.g. Vitest).
 */
@Injectable({ providedIn: 'root' })
export class FeatureFlagsService {
  private readonly tauri = inject(TauriService);
  private readonly state = signal<FeatureFlags>(ALL_OFF);

  /** Seeds the state from `get_feature_flags` and subscribes to `feature-flags-changed`. */
  constructor() {
    void this.init();
  }

  /**
   * Reads one flag; inside a template or computed it tracks the flag map.
   * @param flag - The flag to read.
   * @returns Whether the flag is on.
   */
  enabled(flag: FeatureFlag): boolean {
    return this.state()[flag];
  }

  /**
   * Persists one flag through the backend and shows the new state at once.
   * @param flag - The flag to change.
   * @param enabled - The new state.
   * @returns Resolves when the backend has saved the flag; rejects with its error.
   */
  async set(flag: FeatureFlag, enabled: boolean): Promise<void> {
    await this.tauri.invoke('set_feature_flag', { flag, enabled });
    this.state.update((flags) => ({ ...flags, [flag]: enabled }));
  }

  /** Re-reads every flag from the backend, e.g. after a failed save. */
  async refresh(): Promise<void> {
    try {
      const flags = await this.tauri.invoke<Partial<FeatureFlags> | undefined>('get_feature_flags');
      this.state.update((current) => ({ ...current, ...flags }));
    } catch {}
  }

  private async init(): Promise<void> {
    await this.refresh();
    try {
      await this.tauri.listen<FeatureFlags>(FEATURE_FLAGS_CHANGED_EVENT, (event) => {
        this.state.update((current) => ({ ...current, ...event.payload }));
      });
    } catch {}
  }
}
