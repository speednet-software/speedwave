import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ManagedLamp } from '../models/management';

/**
 * The mark of what the organisation manages (inline SVG, `currentColor`); with a `lamp`, whether
 * its policy lets the project, service, integration, plugin or agent beside it run.
 */
@Component({
  selector: 'app-managed-mark',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'img',
    '[attr.aria-label]': 'label()',
    '[attr.title]': 'label()',
    class: 'relative inline-block shrink-0',
  },
  template: `
    <svg viewBox="0 0 24 24" class="h-full w-full" xmlns="http://www.w3.org/2000/svg">
      <path
        fill="currentColor"
        d="M12 1.8 20.6 5v6.2c0 5.3-3.6 9.9-8.6 11-5-1.1-8.6-5.7-8.6-11V5L12 1.8Zm0 2.1L5.4 6.4v4.8c0 4.2 2.8 7.9 6.6 8.9 3.8-1 6.6-4.7 6.6-8.9V6.4L12 3.9Z"
      />
    </svg>
    @if (lamp(); as l) {
      <span
        data-testid="managed-lamp"
        [attr.data-lamp]="l"
        class="absolute -bottom-px -right-px h-[45%] w-[45%] rounded-full"
        [style.background]="l === 'allowed' ? 'var(--green)' : 'var(--red)'"
        [style.box-shadow]="'0 0 0 1px var(--bg-1)'"
      ></span>
    }
  `,
})
export class ManagedMarkComponent {
  /** Allowed or not by the organisation's policy; none for the bare mark. */
  readonly lamp = input<ManagedLamp | null>(null);
  /** The management provider's name, for the label. */
  readonly provider = input<string | null>(null);

  protected readonly label = computed(() => {
    const by = this.provider() || 'your organisation';
    const l = this.lamp();
    if (l === 'allowed') return `Managed by ${by} · allowed`;
    if (l === 'not-allowed') return `Managed by ${by} · not allowed`;
    return 'Managed by your organisation';
  });
}
