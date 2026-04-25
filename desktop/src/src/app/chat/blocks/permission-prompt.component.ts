import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

/** Decision emitted by the permission prompt. */
export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny';

/**
 * Amber callout asking the user to authorise a potentially dangerous tool invocation.
 * Renders the command in a monospaced code block and three buttons: allow once (primary),
 * allow always (secondary), deny (destructive).
 *
 * ARIA: `role="dialog"` plus `aria-labelledby` pointing at the "permission required"
 * header, so screen readers announce the prompt as a modal-style interruption.
 * Focus management is left to the parent — typical usage mounts one prompt at a time
 * inside the chat list, and the parent handles focus after decision.
 *
 * Note on API shape: classical `@Input` / `@Output` decorators are used so the
 * current `npx vitest run` harness can resolve inputs without the Angular
 * compiler plugin. See the `AskUserBlockComponent` docstring for context.
 *
 * Wave 1 design-system tokens (`--amber`, `--line`, `--line-strong`, `--bg-1`,
 * `--bg-2`, `--bg-3`, `--accent`, `--on-accent`, `--ink`, `--ink-dim`) may not yet
 * be merged into the global stylesheet — fallback hex values keep the component
 * usable in isolation.
 */
@Component({
  selector: 'app-permission-prompt',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block my-2' },
  styles: [
    `
      :host {
        display: block;
      }
      .pp-wrapper {
        border-radius: 0.25rem;
        box-shadow: 0 0 0 1px color-mix(in oklab, var(--amber, #f5b942) 40%, transparent);
        background-color: color-mix(in oklab, var(--amber, #f5b942) 6%, transparent);
        padding: 0.75rem;
      }
      .pp-header {
        color: var(--amber, #f5b942);
      }
      .pp-description {
        color: var(--ink-dim, #9aa3ba);
      }
      .pp-code {
        border: 1px solid var(--line, #1a2030);
        background-color: var(--bg-1, #0b0e18);
        color: var(--ink-dim, #9aa3ba);
      }
      .pp-primary {
        background-color: var(--accent, #ff4d6d);
        color: var(--on-accent, #07090f);
      }
      .pp-primary:hover {
        opacity: 0.9;
      }
      .pp-secondary {
        border: 1px solid var(--line-strong, #252c42);
        background-color: var(--bg-2, #10141f);
        color: var(--ink, #e8edf7);
      }
      .pp-secondary:hover {
        background-color: var(--bg-3, #161b2a);
      }
      .pp-deny {
        border: 1px solid color-mix(in oklab, #ef4444 40%, transparent);
        background-color: color-mix(in oklab, #ef4444 5%, transparent);
        color: #fca5a5;
      }
      .pp-deny:hover {
        background-color: color-mix(in oklab, #ef4444 10%, transparent);
      }
    `,
  ],
  template: `
    <div
      data-testid="permission-prompt"
      class="pp-wrapper"
      role="dialog"
      aria-modal="false"
      [attr.aria-labelledby]="headerId"
    >
      <div
        [id]="headerId"
        data-testid="permission-header"
        class="pp-header mono mb-2 flex items-center gap-2 text-[11px]"
      >
        <span aria-hidden="true">&#9888;</span>
        <span>permission required</span>
      </div>

      @if (description) {
        <div data-testid="permission-description" class="pp-description mb-2 text-[12.5px]">
          {{ description }}
        </div>
      }

      <pre
        data-testid="permission-command"
        class="pp-code mono mb-3 overflow-x-auto rounded p-2 text-[11.5px]"
        >{{ command }}</pre
      >

      <div class="flex flex-wrap gap-2" role="group" aria-label="Permission decision">
        <button
          type="button"
          data-testid="permission-allow-once"
          class="pp-primary mono rounded px-3 py-1 text-[12px] font-medium"
          (click)="decide('allow_once')"
        >
          allow once
        </button>
        <button
          type="button"
          data-testid="permission-allow-always"
          class="pp-secondary mono rounded px-3 py-1 text-[12px]"
          (click)="decide('allow_always')"
        >
          allow always
        </button>
        <button
          type="button"
          data-testid="permission-deny"
          class="pp-deny mono rounded px-3 py-1 text-[12px]"
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
  @Input({ required: true }) command!: string;

  /** Optional human-readable description shown above the command block. */
  @Input() description = '';

  /** Parent receives the user's typed decision. */
  @Output() decided = new EventEmitter<PermissionDecision>();

  /** Stable DOM id for `aria-labelledby` on the dialog wrapper. */
  readonly headerId = `permission-header-${Math.random().toString(36).slice(2, 9)}`;

  /**
   * Forwards a button click as a typed decision event.
   * @param decision - Which button the user pressed (allow-once, allow-always, or deny).
   */
  decide(decision: PermissionDecision): void {
    this.decided.emit(decision);
  }
}
