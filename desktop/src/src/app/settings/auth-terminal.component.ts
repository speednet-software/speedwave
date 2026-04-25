import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  inject,
  Input,
  OnDestroy,
  OnInit,
  Output,
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
  template: `
    <div class="bg-sw-bg-darkest border border-sw-border rounded-lg p-4 mt-3">
      <p class="text-[13px] text-sw-text m-0 mb-3 leading-relaxed">
        Open a terminal and run the following command, then type <code>/login</code> to
        authenticate:
      </p>
      @if (command) {
        <div
          class="flex items-center gap-2 mb-3 bg-sw-bg-dark border border-sw-border rounded px-3 py-2"
        >
          <code
            class="text-[13px] text-sw-accent font-mono flex-1 select-all break-all"
            data-testid="auth-command"
            >{{ command }}</code
          >
          <button
            class="px-3 py-1 bg-sw-accent text-sw-bg-abyss border-none rounded text-[12px] font-mono cursor-pointer transition-colors duration-200 hover:bg-sw-accent-hover shrink-0"
            data-testid="auth-copy-command"
            (click)="copyCommand()"
          >
            {{ copied ? 'Copied!' : 'Copy' }}
          </button>
        </div>
      }
      @if (isWindows) {
        <p class="text-xs text-sw-text-faint m-0 mb-2 leading-relaxed">
          On Windows, run this in a WSL or bash terminal.
        </p>
      }
      @if (error) {
        <div
          class="bg-sw-error-bg border border-sw-error rounded px-3 py-2 mb-3 text-sw-error-text text-[13px] leading-snug"
          data-testid="auth-error"
        >
          {{ error }}
        </div>
      }
      <p class="text-xs text-sw-text-faint m-0 mb-3 leading-relaxed">
        This page updates automatically when authentication completes.
      </p>
      <div class="flex items-center gap-2 text-[13px] text-sw-text-muted">
        <span
          class="w-3.5 h-3.5 border-2 border-sw-border border-t-sw-accent rounded-full animate-sw-spin shrink-0"
        ></span>
        <span>Waiting for authentication...</span>
      </div>
    </div>
  `,
})
export class AuthTerminalComponent implements OnInit, OnDestroy {
  /** Project name for auth status polling. */
  @Input() project = '';
  /** Emits when the OAuth session finishes. */
  @Output() done = new EventEmitter<boolean>();

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
      .invoke<string>('get_auth_command', { project: this.project })
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
            project: this.project,
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
