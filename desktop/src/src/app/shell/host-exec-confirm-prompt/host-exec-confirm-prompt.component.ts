import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { TauriService } from '../../services/tauri.service';
import { LoggerService } from '../../services/logger.service';
import {
  HOST_EXEC_CONFIRM_EVENT,
  type HostExecConfirmDecision,
  type HostExecConfirmRequest,
} from '../../models/host-exec';

/** A pending per-recipe confirmation prompt (one per worker request). */
interface PendingConfirm extends HostExecConfirmRequest {
  /** The rendered argv string for display. */
  readonly argvText: string;
}

/**
 * Shell-level prompt for per-recipe `host_exec` confirmations. Mounted in the
 * shell (not the Integrations card) so it works wherever the user is — Claude
 * invokes recipes from the chat, so the dialog must show there too. Subscribes
 * to the `host-exec://confirm-request` event, queues requests (one dialog at a
 * time), and answers via `host_exec_confirm_reply` (allow / allow-session /
 * deny). On a non-answer the worker fails closed on its own (ADR-054).
 */
@Component({
  selector: 'app-host-exec-confirm-prompt',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (active) {
      <div
        class="fixed inset-0 z-[1260] flex items-center justify-center bg-black/75 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm host command"
        data-testid="host-exec-confirm"
        tabindex="-1"
      >
        <div
          class="w-[min(30rem,calc(100vw-2rem))] rounded border border-amber-500/40 bg-[var(--bg-1)] p-5"
          role="document"
        >
          <div class="mono text-[11px] uppercase tracking-widest text-amber-300">
            claude wants to run a host command
          </div>
          <h3
            class="view-title view-title-section mt-1 text-[var(--ink)]"
            data-testid="host-exec-confirm-title"
          >
            Run <span class="mono">{{ active.recipe }}</span
            >?
          </h3>
          <p class="mt-2 text-[13px] text-[var(--ink-dim)]">
            In <span class="mono">{{ active.cwd }}</span> on this machine (project
            <span class="mono">{{ active.project }}</span
            >):
          </p>
          <pre
            class="mono mt-2 overflow-x-auto rounded border border-[var(--line)] bg-[var(--bg)] p-2 text-[11.5px] text-[var(--ink)]"
            data-testid="host-exec-confirm-argv"
            >{{ active.argvText }}</pre
          >
          <div class="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              class="mono rounded border border-red-500/40 bg-red-500/10 px-3 py-1 text-[12px] text-red-300 hover:bg-red-500/20"
              data-testid="host-exec-confirm-deny"
              (click)="reply('deny')"
            >
              deny
            </button>
            <button
              type="button"
              class="mono rounded border border-[var(--line)] px-3 py-1 text-[12px] text-[var(--ink-dim)] hover:text-[var(--ink)]"
              data-testid="host-exec-confirm-session"
              (click)="reply('allow-session')"
            >
              allow for this session
            </button>
            <button
              type="button"
              class="mono rounded border border-[var(--accent-dim)] bg-[var(--accent-soft)] px-3 py-1 text-[12px] text-[var(--accent)] hover:opacity-90"
              data-testid="host-exec-confirm-allow"
              (click)="reply('allow')"
            >
              allow once
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class HostExecConfirmPromptComponent implements OnInit, OnDestroy {
  /** FIFO queue of pending prompts. */
  private queue: PendingConfirm[] = [];
  /** The prompt currently shown, or `null`. */
  active: PendingConfirm | null = null;

  private tauri = inject(TauriService);
  private logger = inject(LoggerService);
  private cdr = inject(ChangeDetectorRef);
  private unlisten: (() => void) | null = null;

  /** Subscribes to the worker's confirm-request event. */
  async ngOnInit(): Promise<void> {
    try {
      this.unlisten = await this.tauri.listen<HostExecConfirmRequest>(
        HOST_EXEC_CONFIRM_EVENT,
        (event) => this.onRequest((event as { payload: HostExecConfirmRequest }).payload)
      );
    } catch (e: unknown) {
      this.logger.warn(
        `[host-exec] failed to subscribe to confirm events: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Unsubscribes. */
  ngOnDestroy(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  /**
   * Enqueue a confirm-request and show it (one at a time).
   * @param req - The confirm-request payload from the worker.
   */
  private onRequest(req: HostExecConfirmRequest): void {
    this.queue.push({ ...req, argvText: req.argv.join(' ') });
    if (!this.active) this.dequeue();
    this.cdr.markForCheck();
  }

  private dequeue(): void {
    this.active = this.queue.shift() ?? null;
    this.cdr.markForCheck();
  }

  /**
   * Answer the active prompt — reply to the worker, then show the next.
   * @param decision - `allow` / `allow-session` / `deny`.
   */
  async reply(decision: HostExecConfirmDecision): Promise<void> {
    const c = this.active;
    if (!c) return;
    this.active = null;
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('host_exec_confirm_reply', {
        project: c.project,
        id: c.id,
        decision,
      });
    } catch (e: unknown) {
      // If the reply fails the worker fails closed on its own; just log.
      this.logger.warn(
        `[host-exec] confirm reply failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    this.dequeue();
  }
}
