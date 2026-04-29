import { ChangeDetectionStrategy, Component, OnInit, input, signal } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';

/**
 * Collapsible "thinking" block — terminal-minimal timeline event with a violet
 * left border. Pure-Tailwind classes; the chevron is an inline SVG that
 * rotates 90° on open via the `rotate-90` utility (no glyph swap).
 *
 * Mockup reference: lines 591–613.
 */
@Component({
  selector: 'app-thinking-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block my-2' },
  template: `
    <details
      class="border-l-2 border-[var(--violet)]/50 pl-4"
      [open]="!collapsed()"
      (toggle)="onToggle($event)"
    >
      <summary
        data-testid="thinking-toggle"
        class="mono flex cursor-pointer items-center gap-2 text-[11px] text-[var(--violet)]/80 hover:text-[var(--violet)]"
        [attr.aria-expanded]="!collapsed()"
        [attr.aria-controls]="!collapsed() ? panelId : null"
      >
        <app-icon
          name="chevron-right"
          [strokeWidth]="2"
          class="h-3 w-3 transition-transform"
          [class.rotate-90]="!collapsed()"
        />
        thinking
      </summary>
      <div
        [id]="panelId"
        data-testid="thinking-content"
        class="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink-mute)]"
      >
        {{ content() }}
      </div>
    </details>
  `,
})
export class ThinkingBlockComponent implements OnInit {
  /** Raw reasoning text (rendered as plain text, not markdown). */
  readonly content = input.required<string>();
  /** Initial collapsed state. Defaults to collapsed. */
  readonly collapsedDefault = input(true);

  /** Incremented per-instance to generate unique panel IDs for aria-controls. */
  private static instanceCounter = 0;
  /** Stable DOM id so aria-controls on the toggle pairs with the content region. */
  readonly panelId = `thinking-panel-${++ThinkingBlockComponent.instanceCounter}`;

  readonly collapsed = signal<boolean>(true);

  /** Seeds the collapsed signal from the collapsedDefault input. */
  ngOnInit(): void {
    this.collapsed.set(this.collapsedDefault());
  }

  /**
   * Mirrors the native `<details>` open/closed state into the signal so the
   * chevron and `aria-expanded` stay in sync with the user's interaction
   * (clicks the summary toggle the disclosure natively).
   * @param event Native toggle event from the `<details>` element.
   */
  onToggle(event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    this.collapsed.set(!open);
  }
}
