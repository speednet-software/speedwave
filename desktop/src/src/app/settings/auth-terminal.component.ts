import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
  input,
  output,
} from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { TauriService } from '../services/tauri.service';
import { LoggerService } from '../services/logger.service';

/**
 * OAuth login instructions card.
 * Displays a copyable CLI command and polls auth status for completion.
 */
@Component({
  selector: 'app-auth-terminal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  template: `
    <div class="mt-3 rounded border border-[var(--line)] bg-[var(--bg-1)] p-4">
      <p class="text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
        Click the button below — Speedwave opens a terminal, runs Claude Code, and you type
        <code>/login</code> at the prompt. Claude Code saves your credentials inside the container
        so the next start skips the login flow.
      </p>
      <div class="mt-3 flex items-center gap-2">
        <button
          type="button"
          class="rounded bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:opacity-50"
          data-testid="auth-open-terminal"
          [disabled]="opening"
          (click)="openTerminal()"
        >
          {{ opening ? 'Opening…' : 'Open terminal and log in' }}
        </button>
      </div>
      @if (command) {
        <p class="mt-4 text-[12px] leading-relaxed text-[var(--ink-dim)]">
          Or run this command yourself in any terminal:
        </p>
        <div
          class="mt-2 flex items-center gap-2 rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-2"
        >
          <code
            class="mono flex-1 select-all break-all text-[12px] text-[var(--accent)]"
            data-testid="auth-command"
            >{{ command }}</code
          >
          <button
            type="button"
            class="mono shrink-0 rounded bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90"
            data-testid="auth-copy-command"
            (click)="copyCommand()"
          >
            {{ copied ? 'copied!' : 'copy' }}
          </button>
        </div>
      }
      @if (isWindows) {
        <p class="mono mt-2 text-[10px] leading-relaxed text-[var(--ink-mute)]">
          On Windows, run this in a PowerShell terminal (where the speedwave command is on PATH).
        </p>
      }
      @if (error) {
        <div
          class="mt-3 rounded border border-red-500/40 bg-red-500/5 px-3 py-2 text-[12px] leading-snug text-red-300"
          data-testid="auth-error"
        >
          {{ error }}
        </div>
      }
    </div>
  `,
})
export class AuthTerminalComponent implements OnInit, OnDestroy {
  /** Project name for auth status polling. */
  readonly project = input('');
  /** Emits when the OAuth session finishes. */
  readonly done = output<boolean>();

  /** CLI command to display for the user to copy. */
  command = '';
  /** Whether the "Copied!" feedback is showing. */
  copied = false;
  /** Error message displayed when command fetch or clipboard fails. */
  error = '';
  /** Whether the current platform is Windows (for WSL terminal hint). */
  isWindows = false;
  /** True while the host terminal-open Tauri call is in flight. */
  opening = false;

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private clipboard = inject(Clipboard);
  private log = inject(LoggerService);
  private pollTimer?: ReturnType<typeof setInterval>;
  private copyTimer?: ReturnType<typeof setTimeout>;

  /** Fetches the CLI command, detects platform, and starts polling for auth status. */
  ngOnInit(): void {
    this.tauri
      .invoke<string>('get_auth_command', { project: this.project() })
      .then((cmd) => {
        this.command = cmd;
        this.cdr.markForCheck();
      })
      .catch((err: string) => {
        this.error = err;
        this.cdr.markForCheck();
      });
    this.tauri
      .invoke<string>('get_platform')
      .then((platform) => {
        this.isWindows = platform === 'windows';
        this.cdr.markForCheck();
      })
      .catch((err: unknown) => {
        // Non-fatal: the Windows PowerShell hint just won't show.
        this.log.warn(`auth-terminal: get_platform failed: ${String(err)}`);
      });
    this.startPolling();
  }

  /**
   * Spawns the host terminal running `speedwave login`.
   * Polling continues to detect login completion.
   */
  openTerminal(): void {
    this.opening = true;
    this.error = '';
    this.cdr.markForCheck();
    this.tauri
      .invoke<void>('start_oauth_login', { project: this.project() })
      .catch((err: string) => {
        this.error = err || 'Failed to open terminal';
      })
      .finally(() => {
        this.opening = false;
        this.cdr.markForCheck();
      });
  }

  /** Copies the CLI command to the clipboard. */
  copyCommand(): void {
    if (!this.clipboard.copy(this.command)) {
      this.error = 'Failed to copy to clipboard';
      this.cdr.markForCheck();
      return;
    }
    this.copied = true;
    this.cdr.markForCheck();
    this.copyTimer = setTimeout(() => {
      this.copied = false;
      this.cdr.markForCheck();
    }, 2000);
  }

  /** Cleans up timers. */
  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    if (this.copyTimer) {
      clearTimeout(this.copyTimer);
    }
  }

  /** Polls auth status every 3s to detect successful login. */
  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      try {
        const result = await this.tauri.invoke<{ oauth_authenticated: boolean }>(
          'get_auth_status',
          {
            project: this.project(),
          }
        );
        if (result.oauth_authenticated) {
          if (this.pollTimer) {
            clearInterval(this.pollTimer);
          }
          this.done.emit(true);
        }
      } catch (err: unknown) {
        // Expected while the container is still starting; log anything else.
        const msg = typeof err === 'string' ? err : String(err);
        if (!/container|not running|starting/i.test(msg)) {
          this.log.debug(`auth-terminal: get_auth_status poll error: ${msg}`);
        }
      }
    }, 3000);
  }
}
