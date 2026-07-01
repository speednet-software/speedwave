import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Seamless Material-style SVG spinner. Stroke colour follows `currentColor`,
 * sizing follows the host Tailwind classes.
 */
@Component({
  selector: 'app-spin-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // `block` (not inline-block) so the SVG box has no baseline gap — inline-block
  // makes the small spinner rotate on an ellipse in WKWebView. 14px default size.
  host: { class: 'block h-3.5 w-3.5' },
  template: `
    <svg
      [attr.data-testid]="testId() || null"
      class="spin-svg block h-full w-full"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        class="spin-circle"
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
        pathLength="100"
      />
    </svg>
  `,
})
export class SpinIconComponent {
  readonly testId = input<string>('');
}
