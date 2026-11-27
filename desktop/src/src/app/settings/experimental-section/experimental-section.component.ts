import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';

import { FeatureFlagsService } from '../../services/feature-flags.service';
import type { FeatureFlag } from '../../models/feature-flags';
import { ToggleComponent } from '../../shared/toggle.component';

/** One switch row; `flag` is the key `set_feature_flag` takes. */
interface FlagRow {
  flag: FeatureFlag;
  label: string;
  hint: string;
}

const FLAG_ROWS: readonly FlagRow[] = [
  { flag: 'office', label: 'Office integration', hint: 'Shows Office in Integrations.' },
  {
    flag: 'telemetry_settings',
    label: 'Telemetry settings',
    hint: 'Shows the Telemetry section.',
  },
];

/** Settings → Experimental features (ADR-058): one switch per feature flag, effective at once. */
@Component({
  selector: 'app-experimental-section',
  imports: [ToggleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section
      id="section-experimental"
      class="border-t border-[var(--line)] pt-6"
      data-testid="settings-section-experimental"
    >
      <h2 class="view-title view-title-section text-[var(--ink)]">Experimental features</h2>
      <p class="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
        Features still in development. A switch takes effect at once.
      </p>

      @for (row of rows; track row.flag) {
        <div class="mt-4 flex items-center justify-between gap-3">
          <div>
            <div class="text-[12px] text-[var(--ink)]">{{ row.label }}</div>
            <div class="text-[11px] text-[var(--ink-mute)]">{{ row.hint }}</div>
          </div>
          <app-toggle
            [testId]="'experimental-' + row.flag + '-toggle'"
            [ariaLabel]="row.label"
            [checked]="flags.enabled(row.flag)"
            (changed)="onToggle(row.flag, $event)"
          />
        </div>
      }
    </section>
  `,
})
export class ExperimentalSectionComponent {
  /** Emits a user-facing message when saving a flag fails. */
  readonly errorOccurred = output<string>();

  readonly rows = FLAG_ROWS;
  protected readonly flags = inject(FeatureFlagsService);

  /**
   * Saves one flag; a failed save puts the switch back and reports the error.
   * @param flag - The flag that changed.
   * @param event - The toggle's change event.
   * @returns Resolves once the save has finished.
   */
  async onToggle(flag: FeatureFlag, event: Event): Promise<void> {
    const box = event.target as HTMLInputElement;
    try {
      await this.flags.set(flag, box.checked);
    } catch (e: unknown) {
      box.checked = this.flags.enabled(flag);
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
  }
}
