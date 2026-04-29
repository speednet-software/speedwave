import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';

/** Decision emitted by the permission prompt. */
export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny';

/**
 * Amber callout asking the user to authorise a tool invocation.
 *
 * Matches the terminal-minimal mockup (lines 796–808): rounded amber-bordered
 * box with a 4% amber wash, mono header (warning glyph + label + tool name),
 * monospaced command preview, and three action buttons (allow-once primary
 * accent, allow-always neutral bordered, deny red bordered).
 */
@Component({
  selector: 'app-permission-prompt',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block my-2' },
  template: `
    <div
      data-testid="permission-prompt"
      role="alertdialog"
      [attr.aria-labelledby]="headerId"
      [attr.aria-describedby]="commandId"
      class="rounded border border-[var(--amber)]/40 bg-[var(--amber)]/[0.04] p-3"
    >
      <div
        [id]="headerId"
        data-testid="permission-header"
        class="mono mb-2 flex items-center gap-2 text-[11px] text-[var(--amber)]"
      >
        <app-icon name="alert-triangle" [strokeWidth]="2" class="h-3 w-3" />
        <span>permission required</span>
      </div>

      @if (description()) {
        <div data-testid="permission-description" class="mb-2 text-[12.5px] text-[var(--ink-dim)]">
          {{ description() }}
        </div>
      }

      <pre
        [id]="commandId"
        data-testid="permission-command"
        class="mono mb-3 overflow-x-auto rounded border border-[var(--line)] bg-[var(--bg-1)] p-2 text-[11.5px] text-[var(--ink-dim)]"
        >{{ command() }}</pre
      >

      <div class="flex flex-wrap gap-2" role="group" aria-label="Permission decision">
        <button
          type="button"
          data-testid="permission-allow-once"
          class="mono rounded bg-[var(--accent)] px-3 py-1 text-[12px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:opacity-50"
          [disabled]="hasDecided()"
          (click)="decide('allow_once')"
        >
          allow once
        </button>
        <button
          type="button"
          data-testid="permission-allow-always"
          class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[12px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-50"
          [disabled]="hasDecided()"
          (click)="decide('allow_always')"
        >
          allow always
        </button>
        <button
          type="button"
          data-testid="permission-deny"
          class="mono rounded border border-red-500/40 bg-red-500/5 px-3 py-1 text-[12px] text-red-300 hover:bg-red-500/10 disabled:opacity-50"
          [disabled]="hasDecided()"
          (click)="decide('deny')"
        >
          deny
        </button>
      </div>
    </div>
  `,
})
export class PermissionPromptComponent {
  /** The command/operation the user is being asked to authorise. */
  readonly command = input.required<string>();

  /** Optional human-readable description shown above the command block. */
  readonly description = input('');

  /** Parent receives the user's typed decision. */
  readonly decided = output<PermissionDecision>();

  /**
   * Stable DOM id for `aria-labelledby` on the dialog wrapper. Generated once
   * at construction so re-renders don't break the ARIA pairing — uses an
   * incrementing counter rather than `Math.random` so test fixtures get
   * deterministic ids.
   */
  private static instanceCounter = 0;
  private readonly instanceId = ++PermissionPromptComponent.instanceCounter;
  readonly headerId = `permission-header-${this.instanceId}`;
  readonly commandId = `permission-command-${this.instanceId}`;

  /** Self-protection: once a decision is emitted, all buttons go disabled to absorb double-clicks. */
  readonly hasDecided = signal(false);

  /**
   * Forwards a button click as a typed decision event.
   * @param decision - Which button the user pressed (allow-once, allow-always, or deny).
   */
  decide(decision: PermissionDecision): void {
    if (this.hasDecided()) return;
    this.hasDecided.set(true);
    this.decided.emit(decision);
  }
}
