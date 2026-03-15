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
    <div class="oauth-card">
      <p class="instructions">
        Open Claude Code in a terminal, then type <code>/login</code> to authenticate:
      </p>
      <div class="actions">
        <button
          class="btn-primary"
          data-testid="auth-open-terminal"
          tabindex="0"
          (click)="openTerminal()"
          (keydown.enter)="openTerminal()"
        >
          Open Terminal
        </button>
      </div>
      @if (error) {
        <div class="error-banner" data-testid="auth-error">{{ error }}</div>
      }
      <p class="hint">This page updates automatically when authentication completes.</p>
      <div class="status-row">
        <span class="spinner"></span>
        <span>Waiting for authentication...</span>
      </div>
    </div>
  `,
  styles: [
    `
      .oauth-card {
        background: #0a0a1a;
        border: 1px solid #0f3460;
        border-radius: 8px;
        padding: 16px;
        margin-top: 12px;
      }
      .instructions {
        font-size: 13px;
        color: #e0e0e0;
        margin: 0 0 12px 0;
        line-height: 1.5;
      }
      .actions {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
      }
      .btn-primary {
        padding: 6px 16px;
        background: #e94560;
        color: #1a1a2e;
        border: none;
        border-radius: 4px;
        font-size: 13px;
        font-family: monospace;
        font-weight: bold;
        cursor: pointer;
        transition: background 0.2s;
      }
      .btn-primary:hover {
        background: #ff6b81;
      }
      .cmd {
        color: #e94560;
        font-size: 14px;
        font-family: monospace;
        font-weight: bold;
      }
      .btn-copy {
        padding: 4px 12px;
        background: transparent;
        color: #e0e0e0;
        border: 1px solid #0f3460;
        border-radius: 4px;
        font-size: 12px;
        font-family: monospace;
        cursor: pointer;
        transition: all 0.2s;
        white-space: nowrap;
      }
      .btn-copy:hover {
        border-color: #e94560;
        color: #e94560;
      }
      .hint {
        font-size: 12px;
        color: #666;
        margin: 0 0 12px 0;
        line-height: 1.5;
      }
      .status-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: #888;
      }
      .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid #0f3460;
        border-top-color: #e94560;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        flex-shrink: 0;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      .error-banner {
        background: rgba(233, 69, 96, 0.15);
        border: 1px solid #e94560;
        border-radius: 4px;
        padding: 8px 12px;
        margin-bottom: 12px;
        color: #ff6b81;
        font-size: 13px;
        line-height: 1.4;
      }
    `,
  ],
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
