import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

/** Renders an error message with a red accent border. */
@Component({
  selector: 'app-error-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block my-2' },
  template: `<div
    data-testid="error-block"
    class="bg-[rgba(239,68,68,0.1)] border-l-[3px] border-sw-error px-3 py-2 text-sw-code-red rounded"
  >
    {{ content }}
  </div>`,
})
export class ErrorBlockComponent {
  @Input({ required: true }) content!: string;
}
