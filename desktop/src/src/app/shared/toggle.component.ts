import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * The one on/off switch used across the app (integrations, settings). Single
 * source for the toggle's size and look; call sites pass state + a change handler.
 */
@Component({
  selector: 'app-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <label
      class="relative inline-block h-[20px] w-[36px] shrink-0"
      data-testid="toggle"
      [attr.data-disabled]="disabled() ? '' : null"
      [class.opacity-40]="disabled()"
      [class.cursor-not-allowed]="disabled()"
      [attr.title]="disabled() && disabledTitle() ? disabledTitle() : null"
    >
      <input
        type="checkbox"
        role="switch"
        class="peer sr-only"
        [checked]="checked()"
        [disabled]="disabled()"
        [attr.aria-label]="ariaLabel() || null"
        (change)="changed.emit($event)"
        [attr.data-testid]="testId() || null"
      />
      <span
        class="absolute inset-0 rounded-full bg-[var(--line-strong)] transition-all duration-300 peer-checked:bg-[var(--accent)] before:absolute before:bottom-[3px] before:left-[3px] before:h-[14px] before:w-[14px] before:rounded-full before:bg-white before:transition-all before:duration-300 before:content-[''] peer-checked:before:translate-x-[16px]"
        [class.cursor-pointer]="!disabled()"
      ></span>
    </label>
  `,
})
export class ToggleComponent {
  /** Whether the switch is on. */
  readonly checked = input(false);
  /** Greys the switch and blocks interaction. */
  readonly disabled = input(false);
  /** `data-testid` forwarded onto the inner checkbox (e.g. `telemetry-enabled`). */
  readonly testId = input<string | undefined>(undefined);
  /** Tooltip shown while disabled (e.g. "Configure credentials to enable"). */
  readonly disabledTitle = input('');
  /** Accessible name for the switch when no adjacent visible label names it. */
  readonly ariaLabel = input('');

  /** The raw DOM change event; callers read `event.target` for state/reset. */
  readonly changed = output<Event>();
}
