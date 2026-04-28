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
import { TauriService } from '../services/tauri.service';

/**
 * OAuth login instructions card.
 * Displays a copyable CLI command for the user to paste into their terminal,
 * then polls auth status to detect when login completes.
 */
@Component({
  selector: 'app-auth-terminal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  template: `
    <div class="mt-3 rounded border border-[var(--line)] bg-[var(--bg-1)] p-4">
      <p class="text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
        Open a terminal and run the following command. Claude Code will launch its interactive setup
        and walk you through the login flow.
      </p>
      @if (command) {
        <div
          class="mt-3 flex items-center gap-2 rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-2"
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
          On Windows, run this in a WSL or bash terminal.
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

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
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
    this.tauri.invoke<string>('get_platform').then((platform) => {
      this.isWindows = platform === 'windows';
      this.cdr.markForCheck();
    });
    this.startPolling();
  }

  /** Copies the CLI command to the clipboard. */
  async copyCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.command);
      this.copied = true;
      this.cdr.markForCheck();
      this.copyTimer = setTimeout(() => {
        this.copied = false;
        this.cdr.markForCheck();
      }, 2000);
    } catch {
      this.error = 'Failed to copy to clipboard';
      this.cdr.markForCheck();
    }
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
      } catch {
        // Container may not be running — keep polling
      }
    }, 3000);
  }
}
