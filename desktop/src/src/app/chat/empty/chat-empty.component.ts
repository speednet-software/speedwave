import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Empty-conversation placeholder shown when the chat has no messages.
 * Mirrors the mockup (lines 929–933): dashed-border card, mono uppercase
 * "empty" kicker, plain-prose hint underneath.
 */
@Component({
  selector: 'app-chat-empty',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block my-2',
    role: 'region',
    'aria-label': 'Empty conversation',
  },
  template: `<div
    data-testid="chat-empty"
    class="rounded border border-dashed border-[var(--line)] p-8 text-center"
  >
    <div class="mono text-[11px] uppercase tracking-widest text-[var(--ink-mute)]">empty</div>
    <div data-testid="chat-empty-hint" class="mt-2 text-[13px] text-[var(--ink-dim)]">
      {{ hint() }}
    </div>
  </div>`,
})
export class ChatEmptyComponent {
  /** Hint text shown under the `empty` kicker. */
  readonly hint = input('No messages yet — ask speedwave anything.');
}
