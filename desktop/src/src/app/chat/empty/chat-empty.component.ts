import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

/** Empty-conversation placeholder shown when the chat has no messages. */
@Component({
  standalone: true,
  selector: 'app-chat-empty',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block my-2',
    role: 'region',
    'aria-label': 'Empty conversation',
  },
  template: `<div
    data-testid="chat-empty"
    class="rounded border border-dashed border-line-strong p-8 text-center"
  >
    <div class="mono text-[11px] uppercase tracking-widest text-ink-mute">// empty</div>
    <div data-testid="chat-empty-hint" class="mono mt-2 text-[13px] text-ink-mute">
      {{ hint }}
    </div>
  </div>`,
})
export class ChatEmptyComponent {
  /** Hint text shown under the `// empty` label. */
  @Input() hint = 'Type a message to start';
}
