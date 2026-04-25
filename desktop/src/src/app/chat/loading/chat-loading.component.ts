import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

/** Loading indicator: border-spinner + mono label, design-system standard. */
@Component({
  standalone: true,
  selector: 'app-chat-loading',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block my-2',
    role: 'status',
    'aria-live': 'polite',
  },
  template: `<div
    data-testid="chat-loading"
    class="mono flex items-center justify-center gap-2 rounded border border-line p-4 text-[12px] text-ink-dim"
  >
    <div
      data-testid="chat-loading-spinner"
      class="h-3 w-3 rounded-full border-2 border-sw-border-dark border-t-sw-accent animate-sw-spin"
      aria-hidden="true"
    ></div>
    <span data-testid="chat-loading-label">{{ label }}</span>
  </div>`,
})
export class ChatLoadingComponent {
  @Input() label = 'Loading conversation history...';
}
