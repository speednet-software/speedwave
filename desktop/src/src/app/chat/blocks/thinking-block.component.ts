import { ChangeDetectionStrategy, Component, Input, OnInit, signal } from '@angular/core';

let nextId = 0;

/** Collapsible block showing Claude's internal reasoning (timeline-event styling). */
@Component({
  selector: 'app-thinking-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block my-2' },
  template: `
    <div
      class="border-l-2 pl-4"
      style="border-color: color-mix(in srgb, var(--violet, #a78bfa) 50%, transparent);"
    >
      <button
        type="button"
        data-testid="thinking-toggle"
        class="mono flex cursor-pointer items-center gap-2 text-[11px] bg-transparent p-0 border-0"
        [style.color]="'var(--violet, #a78bfa)'"
        [attr.aria-expanded]="!collapsed()"
        [attr.aria-controls]="panelId"
        (click)="toggle()"
      >
        <span aria-hidden="true">{{ collapsed() ? '▶' : '▼' }}</span>
        <span>Thinking</span>
      </button>
      @if (!collapsed()) {
        <div
          [id]="panelId"
          data-testid="thinking-content"
          class="mt-2 text-[13px] leading-relaxed whitespace-pre-wrap"
          [style.color]="'var(--ink-dim, #9aa3ba)'"
        >
          {{ content }}
        </div>
      }
    </div>
  `,
})
export class ThinkingBlockComponent implements OnInit {
  /** Raw reasoning text (rendered as plain text, not markdown). */
  @Input({ required: true }) content!: string;
  /** Initial collapsed state. Defaults to collapsed. */
  @Input() collapsedDefault = true;

  /** Stable DOM id so aria-controls on the toggle pairs with the content region. */
  readonly panelId = `thinking-panel-${++nextId}`;

  /** Reactive collapsed state; seeded from collapsedDefault, toggled on click. */
  readonly collapsed = signal<boolean>(true);

  /** Seeds the collapsed signal from the collapsedDefault input. */
  ngOnInit(): void {
    this.collapsed.set(this.collapsedDefault);
  }

  /** Toggles the collapsed state. */
  toggle(): void {
    this.collapsed.update((c) => !c);
  }
}
