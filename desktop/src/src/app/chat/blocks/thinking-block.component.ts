import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

/** Collapsible block showing Claude's thinking/reasoning process. */
@Component({
  selector: 'app-thinking-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="thinking-block">
      <div
        class="thinking-toggle"
        role="button"
        tabindex="0"
        (click)="collapsed = !collapsed"
        (keydown.enter)="collapsed = !collapsed"
      >
        {{ collapsed ? '> Thinking...' : 'v Thinking' }}
      </div>
      @if (!collapsed) {
        <div class="thinking-content">{{ content }}</div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      margin: 8px 0;
    }
    .thinking-block {
      background: #1e1e3a;
      border-left: 3px solid #7c3aed;
      padding: 8px 12px;
      border-radius: 4px;
    }
    .thinking-toggle {
      cursor: pointer;
      color: #7c3aed;
      font-size: 12px;
      user-select: none;
    }
    .thinking-content {
      margin-top: 8px;
      color: #a0a0c0;
      font-size: 13px;
      white-space: pre-wrap;
    }
  `,
})
export class ThinkingBlockComponent {
  @Input({ required: true }) content!: string;
  @Input() collapsed = true;
}
