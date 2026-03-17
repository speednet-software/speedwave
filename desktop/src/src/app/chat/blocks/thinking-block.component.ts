import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

/** Collapsible block showing Claude's thinking/reasoning process. */
@Component({
  selector: 'app-thinking-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block my-2' },
  template: `
    <div class="bg-sw-thinking-bg border-l-3 border-sw-purple px-3 py-2 rounded">
      <div
        data-testid="thinking-toggle"
        class="cursor-pointer text-sw-purple text-xs select-none"
        role="button"
        tabindex="0"
        (click)="collapsed = !collapsed"
        (keydown.enter)="collapsed = !collapsed"
      >
        {{ collapsed ? '> Thinking...' : 'v Thinking' }}
      </div>
      @if (!collapsed) {
        <div
          data-testid="thinking-content"
          class="mt-2 text-sw-text-lavender text-[13px] whitespace-pre-wrap"
        >
          {{ content }}
        </div>
      }
    </div>
  `,
})
export class ThinkingBlockComponent {
  @Input({ required: true }) content!: string;
  @Input() collapsed = true;
}
