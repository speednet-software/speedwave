import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SpinIconComponent } from '../../shared/spin-icon.component';

/** Loading indicator shown while a transcript is being fetched. */
@Component({
  selector: 'app-chat-loading',
  imports: [SpinIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block my-2',
    role: 'status',
    'aria-live': 'polite',
  },
  template: `<div
    data-testid="chat-loading"
    class="mono flex items-center justify-center gap-2 rounded border border-[var(--line)] p-4 text-[12px] text-[var(--ink-mute)]"
  >
    <app-spin-icon testId="chat-loading-spinner" />
    <span data-testid="chat-loading-label">{{ label() }}</span>
  </div>`,
})
export class ChatLoadingComponent {
  readonly label = input('loading conversation history...');
}
