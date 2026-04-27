import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Seamless Material-style SVG spinner. Two rotations layered with
 * mismatched periods (root SVG: 2s, dash growth: 1.4s) so the seam
 * where the dash pattern wraps never lines up with the same frame
 * twice — eliminating the visible "jump" of a single-rotation
 * dashoffset spinner. Pattern from Glenn McComb's article on pure-CSS
 * SVG spinners. Stroke colour follows `currentColor`, sizing follows
 * the host Tailwind classes.
 */
@Component({
  selector: 'app-spin-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.data-testid]="testId() || null"
      class="spin-svg h-3.5 w-3.5"
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
