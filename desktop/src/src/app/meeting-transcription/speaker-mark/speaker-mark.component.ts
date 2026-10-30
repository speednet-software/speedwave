import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { Speaker } from '../speaker-names';

/** A speaker's colour dot (speakers 1 to 4), else its initial or number in a circle. */
@Component({
  selector: 'app-speaker-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0 items-center', 'aria-hidden': 'true' },
  template: `
    @if (speaker().color; as color) {
      <span
        class="h-1.5 w-1.5 rounded-full"
        data-testid="speaker-dot"
        [style.background-color]="color"
      ></span>
    } @else {
      <span
        class="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--bg-3)] px-0.5 text-[9px] font-semibold leading-none text-[var(--ink-dim)] ring-1 ring-[var(--line-strong)]"
        data-testid="speaker-circle"
        >{{ speaker().mark }}</span
      >
    }
  `,
})
export class SpeakerMarkComponent {
  /** The speaker whose mark to draw. */
  readonly speaker = input.required<Pick<Speaker, 'color' | 'mark'>>();
}
