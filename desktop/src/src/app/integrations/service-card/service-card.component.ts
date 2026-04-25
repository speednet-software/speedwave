import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DeviceCodeInfo, IntegrationStatusEntry } from '../../models/integration';

/** Semantic states the header status dot can reflect. */
export type ServiceStatusDot = 'connected' | 'configuring' | 'error' | 'disabled';

/** Payload emitted when the user saves credentials for a service. */
export interface SaveCredentialsEvent {
  svc: IntegrationStatusEntry;
  credentials: Record<string, string>;
  mappings: Record<string, number> | null;
}

/** Reusable card for a single MCP integration service. */
@Component({
  selector: 'app-service-card',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="rounded ring-1 ring-[var(--line)] bg-[var(--bg-1)] mb-3 overflow-hidden"
      [attr.data-testid]="'integrations-service-' + svc.service"
      [attr.data-status-dot]="statusDotKey()"
    >
      <div class="flex justify-between items-center px-5 py-4">
        <button
          class="flex items-center gap-3 flex-1 cursor-pointer bg-transparent border-none text-inherit font-inherit text-left p-0"
          type="button"
          data-testid="card-header-btn"
          (click)="toggleExpand.emit(svc.service)"
        >
          <span
            class="mono inline-block h-2 w-2 flex-shrink-0 rounded-full"
            [style.background-color]="statusDotColor()"
            [attr.data-testid]="'status-dot-' + svc.service"
            aria-hidden="true"
          ></span>
          <span class="mono text-[13px] text-[var(--ink)]" data-testid="service-name">{{
            svc.display_name
          }}</span>
          @if (svc.badge) {
            <span
              class="mono text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide ring-1 ring-[var(--amber)]/40 text-[var(--amber)]"
              data-testid="service-badge"
            >
              {{ svc.badge }}
            </span>
          }
          <span
            class="mono text-[10px] px-2 py-0.5 rounded font-medium uppercase tracking-widest"
            data-testid="badge"
            [attr.data-status]="svc.configured ? 'configured' : 'not-configured'"
            [style.color]="svc.configured ? 'var(--green)' : 'var(--ink-mute)'"
          >
            {{ svc.configured ? 'Configured' : 'Not Configured' }}
          </span>
        </button>
        <div class="flex items-center gap-3">
          <label class="relative inline-block w-[44px] h-[24px]" data-testid="toggle">
            <input
              type="checkbox"
              class="peer sr-only"
              [checked]="svc.enabled"
              (change)="onToggle($event)"
              [attr.data-testid]="'integrations-toggle-' + svc.service"
            />
            <span
              class="absolute inset-0 bg-[var(--line-strong)] rounded-full cursor-pointer transition-all duration-300 peer-checked:bg-[var(--accent)] before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[3px] before:bottom-[3px] before:bg-white before:rounded-full before:transition-all before:duration-300 peer-checked:before:translate-x-[20px]"
            ></span>
          </label>
        </div>
      </div>
      <p
        class="px-5 pb-3 mono text-[12px] text-[var(--ink-dim)] m-0"
        data-testid="card-description"
      >
        {{ svc.description }}
      </p>

      @if (!svc.configured && !expanded && hasConfigurableFields) {
        <p
          class="px-5 pb-3 mono text-[var(--accent)] text-[11px] m-0 cursor-pointer"
          data-testid="setup-hint"
          role="button"
          tabindex="0"
          (click)="toggleExpand.emit(svc.service)"
          (keydown.enter)="toggleExpand.emit(svc.service)"
          (keydown.space)="$event.preventDefault(); toggleExpand.emit(svc.service)"
        >
          Click to set up credentials
        </p>
      }

      @if (expanded && hasConfigurableFields) {
        <div class="px-5 pb-5 pt-2" data-testid="card-body">
          <form (submit)="onSave($event)">
            @for (field of svc.auth_fields; track field.key) {
              @if (!field.oauth_flow) {
                <div class="my-4">
                  <label
                    class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                    [for]="svc.service + '-' + field.key"
                    >{{ field.label }}{{ field.optional ? ' (optional)' : '' }}</label
                  >
                  <input
                    [id]="svc.service + '-' + field.key"
                    [type]="field.field_type === 'password' ? 'password' : 'text'"
                    [placeholder]="field.placeholder"
                    [value]="getFieldValue(field.key)"
                    (input)="onFieldInput(field.key, $event)"
                    class="mono w-full rounded ring-1 ring-[var(--line)] bg-[var(--bg-2)] px-2 py-1.5 text-[12px] text-[var(--ink)] focus:outline-none focus:ring-[var(--accent-dim)]"
                    data-testid="auth-field-input"
                    [required]="!field.optional"
                  />
                </div>
              }
            }

            @if (hasOAuthFields()) {
              <div
                class="my-4 rounded ring-1 ring-[var(--line)] bg-[var(--bg-2)] p-4"
                data-testid="oauth-section"
              >
                @if (!deviceCodeInfo && oauthStatus !== 'polling' && oauthStatus !== 'starting') {
                  <button
                    type="button"
                    class="mono rounded ring-1 ring-[var(--accent-dim)] bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90"
                    (click)="onStartOAuth()"
                  >
                    Sign in with Microsoft
                  </button>
                }
                @if (oauthStatus === 'starting') {
                  <p
                    class="mono text-[12px] text-[var(--ink-dim)] my-2"
                    data-testid="polling-status"
                  >
                    Connecting to Microsoft...
                  </p>
                  <button
                    type="button"
                    class="mono rounded ring-1 ring-red-500/40 px-3 py-1 text-[11px] text-red-300 hover:bg-red-500/10 mt-2"
                    data-testid="btn-cancel-oauth"
                    (click)="cancelOAuth.emit()"
                  >
                    Cancel
                  </button>
                }
                @if (deviceCodeInfo) {
                  <p class="mono text-[12px] text-[var(--ink-dim)]">Enter this code:</p>
                  <div
                    class="mono text-[24px] font-bold tracking-[4px] text-[var(--accent)] my-3 text-center"
                    data-testid="user-code"
                  >
                    {{ deviceCodeInfo.user_code }}
                  </div>
                  <div class="flex items-center gap-2.5 my-2 flex-wrap">
                    <button
                      type="button"
                      class="mono rounded ring-1 ring-[var(--accent-dim)] bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90"
                      data-testid="btn-link"
                      (click)="openVerificationUrl.emit(deviceCodeInfo.verification_uri)"
                    >
                      Open Microsoft Sign-in
                    </button>
                    <span
                      class="mono text-[11px] text-[var(--ink-dim)] select-all break-all"
                      data-testid="verification-url"
                      >{{ deviceCodeInfo.verification_uri }}</span
                    >
                  </div>
                  @if (oauthStatus === 'polling') {
                    <p
                      class="mono text-[12px] text-[var(--ink-dim)] my-2"
                      data-testid="polling-status"
                    >
                      Waiting for sign-in...
                    </p>
                  }
                  <button
                    type="button"
                    class="mono rounded ring-1 ring-red-500/40 px-3 py-1 text-[11px] text-red-300 hover:bg-red-500/10 mt-2"
                    data-testid="btn-cancel-oauth"
                    (click)="cancelOAuth.emit()"
                  >
                    Cancel
                  </button>
                }
                @if (oauthStatus === 'success') {
                  <p class="mono text-[12px] text-[var(--green)]" data-testid="oauth-success">
                    Authentication successful
                  </p>
                }
                @if (oauthStatus === 'error' || oauthStatus === 'expired') {
                  <p class="mono text-[12px] text-red-300" data-testid="oauth-error">
                    {{ oauthStatusMessage }}
                  </p>
                }
              </div>
            }

            <div class="flex gap-3 mt-4">
              <button
                type="submit"
                class="mono rounded bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:opacity-50"
                [attr.data-testid]="'integrations-save-' + svc.service"
              >
                Save
              </button>
              <button
                type="button"
                class="mono rounded ring-1 ring-red-500/40 px-3 py-1 text-[11px] text-red-300 hover:bg-red-500/10"
                [attr.data-testid]="'integrations-remove-' + svc.service"
                (click)="deleteCredentials.emit(svc)"
              >
                Remove Credentials
              </button>
            </div>
          </form>
        </div>
      }
    </div>
  `,
})
export class ServiceCardComponent {
  @Input({ required: true }) svc!: IntegrationStatusEntry;
  @Input() expanded = false;
  @Input() oauthStatus: string | null = null;
  @Input() deviceCodeInfo: DeviceCodeInfo | null = null;
  @Input() oauthStatusMessage = '';

  @Output() toggleExpand = new EventEmitter<string>();
  @Output() toggleService = new EventEmitter<{ svc: IntegrationStatusEntry; event: Event }>();
  @Output() saveCredentials = new EventEmitter<SaveCredentialsEvent>();
  @Output() deleteCredentials = new EventEmitter<IntegrationStatusEntry>();
  @Output() startOAuth = new EventEmitter<{
    svc: IntegrationStatusEntry;
    credentials: Record<string, string>;
  }>();
  @Output() cancelOAuth = new EventEmitter<void>();
  @Output() openVerificationUrl = new EventEmitter<string>();

  editedValues: Record<string, string> = {};

  /**
   * Semantic status dot key — drives both the tinted dot colour and a
   * `data-status-dot` attribute used by tests and AXE.
   */
  statusDotKey(): ServiceStatusDot {
    if (this.oauthStatus === 'error' || this.oauthStatus === 'expired') return 'error';
    if (this.svc.enabled && this.svc.configured) return 'connected';
    if (this.expanded || this.oauthStatus === 'starting' || this.oauthStatus === 'polling') {
      return 'configuring';
    }
    return 'disabled';
  }

  /** CSS colour token for the dot, tied to `statusDotKey()`. */
  statusDotColor(): string {
    switch (this.statusDotKey()) {
      case 'connected':
        return 'var(--green)';
      case 'configuring':
        return 'var(--amber)';
      case 'error':
        return 'var(--red)';
      case 'disabled':
      default:
        return 'var(--ink-mute)';
    }
  }

  /**
   * Whether this service has anything the user can configure in the card body.
   * Services with an empty `auth_fields` list (e.g. Playwright, which only
   * reaches public URLs) have nothing to enter — the toggle header is the
   * entire UI surface, so we hide the form, setup hint, and the Save / Remove
   * Credentials buttons to avoid nonsensical empty prompts.
   */
  get hasConfigurableFields(): boolean {
    return this.svc.auth_fields.length > 0;
  }

  /**
   * Returns whether any auth fields use the OAuth flow.
   */
  hasOAuthFields(): boolean {
    return this.svc.auth_fields.some((f) => f.oauth_flow);
  }

  /**
   * Returns the current value for a credential field, preferring edited values.
   * @param key - the field key to look up
   */
  getFieldValue(key: string): string {
    return this.editedValues[key] ?? this.svc.current_values[key] ?? '';
  }

  /**
   * Stores a field value change in the local edit buffer.
   * @param key - the field key
   * @param event - the DOM input event
   */
  onFieldInput(key: string, event: Event): void {
    this.editedValues[key] = (event.target as HTMLInputElement).value;
  }

  /**
   * Emits the toggleService event with the service and DOM event.
   * If the service is not configured, expands the form instead.
   * @param event - the checkbox change event
   */
  onToggle(event: Event): void {
    if (!this.svc.configured) {
      (event.target as HTMLInputElement).checked = false;
      this.toggleExpand.emit(this.svc.service);
      return;
    }
    this.toggleService.emit({ svc: this.svc, event });
  }

  /**
   * Emits startOAuth with fresh form values (non-oauth fields only).
   */
  onStartOAuth(): void {
    const credentials: Record<string, string> = {};
    for (const field of this.svc.auth_fields) {
      if (field.oauth_flow) continue;
      const value = this.editedValues[field.key] ?? this.svc.current_values[field.key] ?? '';
      if (value !== '') {
        credentials[field.key] = value;
      }
    }
    this.startOAuth.emit({ svc: this.svc, credentials });
  }

  /**
   * Collects edited credentials and emits the saveCredentials event.
   * @param event - the form submit event
   */
  onSave(event: Event): void {
    event.preventDefault();
    const credentials: Record<string, string> = {};

    for (const field of this.svc.auth_fields) {
      const value = this.editedValues[field.key];
      if (value !== undefined && value !== '') {
        credentials[field.key] = value;
      } else if (value === '' && field.optional) {
        // Send empty string explicitly so the backend overwrites any
        // previously-saved value in config.json (omitting the key would
        // leave the stale value intact).
        credentials[field.key] = '';
      }
    }

    if (Object.keys(credentials).length === 0) return;

    this.saveCredentials.emit({
      svc: this.svc,
      credentials,
      mappings: null,
    });

    this.editedValues = {};
  }
}
