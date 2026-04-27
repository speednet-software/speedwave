import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * SVG spinner — a centred circle stroked with a dasharray that exposes
 * ~75% of the circumference. SVG keeps the geometry perfectly round at any
 * rendered size (CSS border + rounded-full hinted oval at fractional pixel
 * sizes). Stroke colour follows `currentColor`, sizing follows the host
 * Tailwind classes.
 */
@Component({
  selector: 'app-spin-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.data-testid]="testId() || null"
      class="spin h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
        stroke-dasharray="42 14"
      />
    </svg>
  `,
})
export class SpinIconComponent {
  readonly testId = input<string>('');
}
