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
 * Tells the user to run `speedwave auth login` in the terminal,
 * then polls auth status to detect when login completes.
 */
@Component({
  selector: 'app-auth-terminal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bg-sw-bg-darkest border border-sw-border rounded-lg p-4 mt-3">
      <p class="text-[13px] text-sw-text m-0 mb-3 leading-relaxed">
        Open Claude Code in a terminal, then type <code>/login</code> to authenticate:
      </p>
      <div class="flex gap-2 mb-3">
        <button
          class="px-4 py-1.5 bg-sw-accent text-sw-bg-abyss border-none rounded text-[13px] font-mono font-bold cursor-pointer transition-colors duration-200 hover:bg-sw-accent-hover"
          data-testid="auth-open-terminal"
          tabindex="0"
          (click)="openTerminal()"
          (keydown.enter)="openTerminal()"
        >
          Open Terminal
        </button>
      </div>
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

  /** Error message displayed when terminal launch fails. */
  error = '';

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private pollTimer?: ReturnType<typeof setInterval>;

  /** Starts polling for auth status. */
  ngOnInit(): void {
    this.startPolling();
  }

  /** Opens a native terminal running speedwave (Claude Code). */
  openTerminal(): void {
    this.error = '';
    this.tauri.invoke('open_auth_terminal', { project: this.project }).catch((err: string) => {
      this.error = err;
      this.cdr.markForCheck();
    });
  }

  /** Cleans up polling timer. */
  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
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
