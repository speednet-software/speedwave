import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DeviceCodeInfo, IntegrationStatusEntry, OAuthFlowStatus } from '../../models/integration';
import { OauthConnectComponent } from '../../shared/oauth-connect/oauth-connect.component';
import { ToggleComponent } from '../../shared/toggle.component';

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
  imports: [OauthConnectComponent, ToggleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="rounded ring-1 ring-[var(--line)] bg-[var(--bg-1)] mb-3 overflow-hidden"
      [attr.data-testid]="'integrations-service-' + svc().service"
      [attr.data-status-dot]="statusDotKey()"
    >
      <div class="flex justify-between items-center px-5 py-4">
        <button
          class="flex items-center gap-3 flex-1 cursor-pointer bg-transparent border-none text-inherit font-inherit text-left p-0"
          type="button"
          data-testid="card-header-btn"
          (click)="toggleExpand.emit(svc().service)"
        >
          <span
            class="mono inline-block h-2 w-2 flex-shrink-0 rounded-full"
            [style.background-color]="statusDotColor()"
            [attr.data-testid]="'status-dot-' + svc().service"
            aria-hidden="true"
          ></span>
          <span class="mono text-[13px] text-[var(--ink)]" data-testid="service-name">{{
            svc().display_name
          }}</span>
          @if (svc().badge) {
            <span
              class="mono text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide ring-1 ring-[var(--amber)]/40 text-[var(--amber)]"
              data-testid="service-badge"
            >
              {{ svc().badge }}
            </span>
          }
          <span
            class="mono text-[10px] px-2 py-0.5 rounded font-medium uppercase tracking-widest"
            data-testid="badge"
            [attr.data-status]="svc().configured ? 'configured' : 'not-configured'"
            [style.color]="svc().configured ? 'var(--green)' : 'var(--ink-mute)'"
          >
            {{ svc().configured ? 'Configured' : 'Not Configured' }}
          </span>
        </button>
        <div class="flex items-center gap-3">
          <app-toggle
            [checked]="svc().enabled"
            [testId]="'integrations-toggle-' + svc().service"
            [ariaLabel]="'Enable ' + svc().service"
            (changed)="onToggle($event)"
          />
        </div>
      </div>
      <p
        class="px-5 pb-3 mono text-[12px] text-[var(--ink-dim)] m-0"
        data-testid="card-description"
      >
        {{ svc().description }}
      </p>

      @if (!svc().configured && !expanded() && hasConfigurableFields) {
        <p
          class="px-5 pb-3 mono text-[var(--accent)] text-[11px] m-0 cursor-pointer"
          data-testid="setup-hint"
          role="button"
          tabindex="0"
          (click)="toggleExpand.emit(svc().service)"
          (keydown.enter)="toggleExpand.emit(svc().service)"
          (keydown.space)="$event.preventDefault(); toggleExpand.emit(svc().service)"
        >
          Click to set up credentials
        </p>
      }

      @if (expanded() && hasConfigurableFields) {
        <div class="px-5 pb-5 pt-2" data-testid="card-body">
          <form (submit)="onSave($event)">
            @for (field of svc().auth_fields; track field.key) {
              @if (!field.oauth_flow) {
                <div class="my-4">
                  <label
                    class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                    [for]="svc().service + '-' + field.key"
                    >{{ field.label }}{{ field.optional ? ' (optional)' : '' }}</label
                  >
                  <input
                    [id]="svc().service + '-' + field.key"
                    [type]="field.field_type === 'password' ? 'password' : 'text'"
                    [placeholder]="field.placeholder"
                    [value]="getFieldValue(field.key)"
                    (input)="onFieldInput(field.key, $event)"
                    class="mono w-full rounded ring-1 ring-[var(--line)] bg-[var(--bg-2)] px-2 py-1.5 text-[12px] text-[var(--ink)] focus:outline-none focus:ring-[var(--accent-dim)]"
                    data-testid="auth-field-input"
                    [attr.aria-describedby]="
                      field.hint ? svc().service + '-' + field.key + '-hint' : null
                    "
                    [required]="!field.optional"
                  />
                  @if (field.hint) {
                    <p
                      [id]="svc().service + '-' + field.key + '-hint'"
                      class="mono mt-1 text-[11px] leading-snug text-[var(--ink-dim)]"
                      data-testid="auth-field-hint"
                    >
                      {{ field.hint }}
                    </p>
                  }
                </div>
              }
            }

            @if (hasOAuthFields()) {
              <app-oauth-connect
                [providerLabel]="oauthProviderLabel()"
                [configured]="svc().configured"
                [status]="oauthStatus()"
                [deviceCode]="deviceCodeInfo()"
                [redirectUri]="redirectUri()"
                [statusMessage]="oauthStatusMessage()"
                [prerequisitesMet]="oauthPrerequisitesMet()"
                [prerequisitesMissingMessage]="oauthPrerequisitesMissingMessage()"
                (authorize)="onStartOAuth()"
                (cancelFlow)="cancelOAuth.emit()"
                (openUrl)="openVerificationUrl.emit($event)"
              />
              @if (svc().oauth_identity; as identity) {
                <p class="mono mt-2 text-[11px] text-[var(--ink-dim)]" data-testid="oauth-identity">
                  Connected to {{ identity }}
                </p>
              }
            }

            <div class="flex gap-3 mt-4">
              @if (hasNonOAuthFields() && !hasOAuthFields()) {
                <button
                  type="submit"
                  class="mono rounded bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:opacity-50"
                  [attr.data-testid]="'integrations-save-' + svc().service"
                >
                  Save
                </button>
              }
              @if (svc().configured) {
                <button
                  type="button"
                  class="mono rounded ring-1 ring-red-500/40 px-3 py-1 text-[11px] text-red-300 hover:bg-red-500/10"
                  [attr.data-testid]="'integrations-remove-' + svc().service"
                  (click)="deleteCredentials.emit(svc())"
                >
                  Remove Credentials
                </button>
              }
            </div>
          </form>
        </div>
      }
    </div>
  `,
})
export class ServiceCardComponent {
  readonly svc = input.required<IntegrationStatusEntry>();
  readonly expanded = input(false);
  readonly oauthStatus = input<OAuthFlowStatus | null>(null);
  readonly deviceCodeInfo = input<DeviceCodeInfo | null>(null);
  readonly oauthStatusMessage = input('');
  readonly redirectUri = input<string | null>(null);

  readonly toggleExpand = output<string>();
  readonly toggleService = output<{ svc: IntegrationStatusEntry; event: Event }>();
  readonly saveCredentials = output<SaveCredentialsEvent>();
  readonly deleteCredentials = output<IntegrationStatusEntry>();
  readonly startOAuth = output<{
    svc: IntegrationStatusEntry;
    credentials: Record<string, string>;
  }>();
  readonly cancelOAuth = output<void>();
  readonly openVerificationUrl = output<string>();

  editedValues: Record<string, string> = {};

  /**
   * Provider label for the OAuth button.
   * @returns the IdP brand name (e.g. "Microsoft", "Slack").
   */
  oauthProviderLabel(): string {
    return this.svc().oauth_provider_label ?? 'provider';
  }

  /** Semantic status dot key — drives both the tinted dot colour and a `data-status-dot` attribute used by tests and AXE. */
  statusDotKey(): ServiceStatusDot {
    const oauth = this.oauthStatus();
    if (oauth === 'error' || oauth === 'expired') return 'error';
    const svc = this.svc();
    if (svc.enabled && svc.configured) return 'connected';
    if (this.expanded() || oauth === 'starting' || oauth === 'polling') {
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

  /** Whether this service has any configurable auth fields. */
  get hasConfigurableFields(): boolean {
    return this.svc().auth_fields.length > 0;
  }

  /**
   * Returns whether any auth fields use the OAuth flow.
   */
  hasOAuthFields(): boolean {
    return this.svc().auth_fields.some((f) => f.oauth_flow);
  }

  /** Typed prerequisites for the OAuth button. */
  private oauthPrerequisiteFields() {
    return this.svc().auth_fields.filter((f) => !f.oauth_flow && !f.optional);
  }

  /** True when every typed prerequisite has a non-blank value. */
  oauthPrerequisitesMet(): boolean {
    return this.oauthPrerequisiteFields().every((f) => this.getFieldValue(f.key).trim() !== '');
  }

  /** Hint listing the typed prerequisites still missing, empty when all set. */
  oauthPrerequisitesMissingMessage(): string {
    const missing = this.oauthPrerequisiteFields()
      .filter((f) => this.getFieldValue(f.key).trim() === '')
      .map((f) => f.label);
    if (missing.length === 0) return '';
    return `Fill in ${missing.join(', ')} above to enable sign-in.`;
  }

  /** Whether any auth fields are NOT OAuth-driven. */
  hasNonOAuthFields(): boolean {
    return this.svc().auth_fields.some((f) => !f.oauth_flow);
  }

  /**
   * Returns the current value for a credential field, preferring edited values.
   * @param key - the field key to look up
   */
  getFieldValue(key: string): string {
    return this.editedValues[key] ?? this.svc().current_values[key] ?? '';
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
   * Toggles service on/off or expands form if not configured.
   * @param event - checkbox change event
   */
  onToggle(event: Event): void {
    const svc = this.svc();
    if (!svc.configured) {
      (event.target as HTMLInputElement).checked = false;
      this.toggleExpand.emit(svc.service);
      return;
    }
    this.toggleService.emit({ svc, event });
  }

  /**
   * Emits startOAuth with fresh form values (non-oauth fields only).
   */
  onStartOAuth(): void {
    const svc = this.svc();
    const credentials: Record<string, string> = {};
    for (const field of svc.auth_fields) {
      if (field.oauth_flow) continue;
      const value = this.editedValues[field.key] ?? svc.current_values[field.key] ?? '';
      if (value !== '') {
        credentials[field.key] = value;
      }
    }
    this.startOAuth.emit({ svc, credentials });
  }

  /**
   * Collects edited credentials and emits the saveCredentials event.
   * @param event - the form submit event
   */
  onSave(event: Event): void {
    event.preventDefault();
    const svc = this.svc();
    const credentials: Record<string, string> = {};

    for (const field of svc.auth_fields) {
      const value = this.editedValues[field.key];
      if (value !== undefined && value !== '') {
        credentials[field.key] = value;
      } else if (value === '' && field.optional) {
        // Explicit empty string persists backend config change (omitting key leaves stale value).
        credentials[field.key] = '';
      }
    }

    if (Object.keys(credentials).length === 0) return;

    this.saveCredentials.emit({
      svc,
      credentials,
      mappings: null,
    });

    this.editedValues = {};
  }
}
