import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** Device-code flow info (SharePoint, GitHub). Absent for authorization_code. */
export interface OAuthDeviceCode {
  user_code: string;
  verification_uri: string;
}

/**
 * Shared OAuth connect UI for both device-code (built-in SharePoint/GitHub) and
 * authorization_code (plugins) flows. The parent owns the flow effects and
 * passes status/info in; this component is presentational + emits user intent.
 */
@Component({
  selector: 'app-oauth-connect',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="my-4 rounded ring-1 ring-[var(--line)] bg-[var(--bg-2)] p-4"
      data-testid="oauth-section"
    >
      @if (idle()) {
        @if (configured()) {
          <button
            type="button"
            class="mono text-[11px] text-[var(--ink-dim)] underline decoration-dotted underline-offset-2 hover:text-[var(--ink)]"
            data-testid="btn-reconnect-oauth"
            (click)="authorize.emit()"
          >
            Reconnect to {{ providerLabel() }}
          </button>
        } @else {
          <button
            type="button"
            class="mono rounded ring-1 ring-[var(--accent-dim)] bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="btn-start-oauth"
            [disabled]="!prerequisitesMet()"
            [attr.title]="prerequisitesMet() ? null : prerequisitesMissingMessage()"
            (click)="authorize.emit()"
          >
            Sign in with {{ providerLabel() }}
          </button>
          @if (!prerequisitesMet()) {
            <p class="mono mt-2 text-[11px] text-[var(--ink-dim)]" data-testid="oauth-prereq-hint">
              {{ prerequisitesMissingMessage() }}
            </p>
          }
        }
      }

      @if (status() === 'starting' || status() === 'awaiting_redirect') {
        <p class="mono text-[12px] text-[var(--ink-dim)] my-2" data-testid="polling-status">
          @if (status() === 'awaiting_redirect') {
            Complete sign-in in your browser…
          } @else {
            Connecting to {{ providerLabel() }}…
          }
        </p>
        @if (redirectUri()) {
          <p class="mono text-[11px] text-[var(--ink-dim)] my-2" data-testid="oauth-redirect-uri">
            Register this redirect URI with {{ providerLabel() }} if prompted:
            <span class="select-all break-all text-[var(--ink)]">{{ redirectUri() }}</span>
          </p>
        }
        <button
          type="button"
          class="mono rounded ring-1 ring-red-500/40 px-3 py-1 text-[11px] text-red-300 hover:bg-red-500/10 mt-2"
          data-testid="btn-cancel-oauth"
          (click)="cancelFlow.emit()"
        >
          Cancel
        </button>
      }

      @if (deviceCode(); as info) {
        <p class="mono text-[12px] text-[var(--ink-dim)]">Enter this code:</p>
        <div
          class="mono text-[24px] font-bold tracking-[4px] text-[var(--accent)] my-3 text-center"
          data-testid="user-code"
        >
          {{ info.user_code }}
        </div>
        <div class="flex items-center gap-2.5 my-2 flex-wrap">
          <button
            type="button"
            class="mono rounded ring-1 ring-[var(--accent-dim)] bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90"
            data-testid="btn-link"
            (click)="openUrl.emit(info.verification_uri)"
          >
            Open {{ providerLabel() }} Sign-in
          </button>
          <span
            class="mono text-[11px] text-[var(--ink-dim)] select-all break-all"
            data-testid="verification-url"
            >{{ info.verification_uri }}</span
          >
        </div>
        @if (status() === 'polling') {
          <p class="mono text-[12px] text-[var(--ink-dim)] my-2" data-testid="polling-status">
            Waiting for sign-in…
          </p>
        }
        <button
          type="button"
          class="mono rounded ring-1 ring-red-500/40 px-3 py-1 text-[11px] text-red-300 hover:bg-red-500/10 mt-2"
          data-testid="btn-cancel-oauth"
          (click)="cancelFlow.emit()"
        >
          Cancel
        </button>
      }

      @if (status() === 'success') {
        <p class="mono text-[12px] text-[var(--green)]" data-testid="oauth-success">
          Authentication successful
        </p>
      }
      @if (status() === 'error' || status() === 'expired') {
        <p class="mono text-[12px] text-red-300" data-testid="oauth-error">
          {{ statusMessage() }}
        </p>
      }
    </div>
  `,
})
export class OauthConnectComponent {
  /** IdP brand shown in copy ("Microsoft", "GitHub", or a plugin name). */
  readonly providerLabel = input.required<string>();
  /** Whether the service already has a stored authorization (reconnect copy). */
  readonly configured = input(false);
  /** Flow status: starting | awaiting_redirect | polling | success | error | expired. */
  readonly status = input<string | null>(null);
  /** Device-code info (device flow only). */
  readonly deviceCode = input<OAuthDeviceCode | null>(null);
  /** Loopback redirect URI (authorization_code flow only). */
  readonly redirectUri = input<string | null>(null);
  readonly statusMessage = input('');
  /** Typed prerequisites satisfied (drives the Sign-in button enabled state). */
  readonly prerequisitesMet = input(true);
  readonly prerequisitesMissingMessage = input('');

  readonly authorize = output<void>();
  readonly cancelFlow = output<void>();
  readonly openUrl = output<string>();

  /** No active flow → show the Sign in / Reconnect button. */
  idle(): boolean {
    const s = this.status();
    return !this.deviceCode() && s !== 'polling' && s !== 'starting' && s !== 'awaiting_redirect';
  }
}
