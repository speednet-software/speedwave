import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

/** Renders an error message with a red accent border. */
@Component({
  selector: 'app-error-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="error-block">{{ content }}</div>`,
  styles: `
    :host {
      display: block;
      margin: 8px 0;
    }
    .error-block {
      background: rgba(239, 68, 68, 0.1);
      border-left: 3px solid #ef4444;
      padding: 8px 12px;
      color: #fca5a5;
      border-radius: 4px;
    }
  `,
})
export class ErrorBlockComponent {
  @Input({ required: true }) content!: string;
}
