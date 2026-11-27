import { signal } from '@angular/core';
import { vi } from 'vitest';
import type { FeatureFlag, FeatureFlags } from '../models/feature-flags';

/** Stand-in for `FeatureFlagsService` in component specs; flip flags with `setFlag`. */
export class FakeFeatureFlagsService {
  private readonly state = signal<FeatureFlags>({ office: false, telemetry_settings: false });

  readonly set = vi.fn(async (flag: FeatureFlag, enabled: boolean): Promise<void> => {
    this.setFlag(flag, enabled);
  });

  /**
   * Reads one flag, tracked by templates and computeds.
   * @param flag - The flag to read.
   * @returns Whether the flag is on.
   */
  enabled(flag: FeatureFlag): boolean {
    return this.state()[flag];
  }

  /**
   * Changes one flag without going through `set`.
   * @param flag - The flag to change.
   * @param enabled - The new state.
   */
  setFlag(flag: FeatureFlag, enabled: boolean): void {
    this.state.update((flags) => ({ ...flags, [flag]: enabled }));
  }
}
