import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  UpdateDownloadProgress,
  downloadProgressPercent,
  downloadProgressText,
} from '../models/update';

/**
 * Progress of an app update download: a bar with the percent, or an indeterminate bar while the
 * server has not sent a total, and a line with the sizes; shown by the update banner and the
 * Settings update section.
 */
@Component({
  selector: 'app-update-progress-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex items-center gap-2' },
  template: `
    <div
      class="h-1 w-32 shrink-0 overflow-hidden rounded bg-[var(--line-strong)]"
      role="progressbar"
      aria-label="Downloading update"
      aria-valuemin="0"
      aria-valuemax="100"
      [attr.aria-valuenow]="percent()"
    >
      <div
        class="h-full bg-[var(--accent)]"
        [class.animate-pulse]="percent() === null"
        [style.width.%]="percent() ?? 100"
      ></div>
    </div>
    <span class="mono whitespace-nowrap text-[11px] text-[var(--ink-mute)]">{{ text() }}</span>
  `,
})
export class UpdateProgressBarComponent {
  readonly progress = input.required<UpdateDownloadProgress>();

  protected readonly percent = computed(() => downloadProgressPercent(this.progress()));
  protected readonly text = computed(() => downloadProgressText(this.progress()));
}
