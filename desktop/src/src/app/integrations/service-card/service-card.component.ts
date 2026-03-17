import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DeviceCodeInfo, IntegrationStatusEntry } from '../../models/integration';

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
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="bg-sw-bg-dark border border-sw-border rounded-lg mb-3 overflow-hidden"
      [attr.data-testid]="'integrations-service-' + svc.service"
    >
      <div class="flex justify-between items-center px-5 py-4">
        <button
          class="card-header-btn flex items-center gap-3 flex-1 cursor-pointer bg-transparent border-none text-inherit font-inherit text-left p-0"
          type="button"
          data-testid="card-header-btn"
          (click)="toggleExpand.emit(svc.service)"
        >
          <span class="service-name font-semibold text-base" data-testid="service-name">{{
            svc.display_name
          }}</span>
          <span
            class="badge text-[11px] px-2 py-0.5 rounded font-medium"
            data-testid="badge"
            [attr.data-status]="svc.configured ? 'configured' : 'not-configured'"
            [class.configured]="svc.configured"
            [class.not-configured]="!svc.configured"
            [ngClass]="
              svc.configured
                ? 'bg-sw-success-dark text-sw-success-text'
                : 'bg-sw-error-badge text-sw-error-text'
            "
          >
            {{ svc.configured ? 'Configured' : 'Not Configured' }}
          </span>
        </button>
        <div class="card-actions flex items-center gap-3">
          <label
            class="toggle relative inline-block w-[44px] h-[24px]"
            data-testid="toggle"
            [attr.data-disabled]="!svc.configured"
            [class.disabled]="!svc.configured"
            [ngClass]="!svc.configured ? 'opacity-40 cursor-not-allowed' : ''"
            [title]="svc.configured ? '' : 'Configure credentials to enable'"
          >
            <input
              type="checkbox"
              class="peer sr-only"
              [checked]="svc.enabled"
              [disabled]="!svc.configured"
              (change)="onToggle($event)"
              [attr.data-testid]="'integrations-toggle-' + svc.service"
              [ngClass]="!svc.configured ? 'cursor-not-allowed' : ''"
            />
            <span
              class="slider absolute inset-0 bg-sw-slider rounded-full cursor-pointer transition-all duration-300 peer-checked:bg-sw-accent before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[3px] before:bottom-[3px] before:bg-white before:rounded-full before:transition-all before:duration-300 peer-checked:before:translate-x-[20px]"
            ></span>
          </label>
        </div>
      </div>
      <p
        class="card-description px-5 pb-3 text-sw-text-faint text-[13px] m-0"
        data-testid="card-description"
      >
        {{ svc.description }}
      </p>

      @if (expanded) {
        <div class="card-body px-5 pb-5 border-t border-sw-border" data-testid="card-body">
          <form (submit)="onSave($event)">
            @for (field of svc.auth_fields; track field.key) {
              @if (!field.oauth_flow) {
                <div class="my-4">
                  <label
                    class="block mb-1.5 text-[13px] text-sw-text-dim"
                    [for]="svc.service + '-' + field.key"
                    >{{ field.label }}</label
                  >
                  <input
                    [id]="svc.service + '-' + field.key"
                    [type]="field.field_type === 'password' ? 'password' : 'text'"
                    [placeholder]="field.placeholder"
                    [value]="getFieldValue(field.key)"
                    (input)="onFieldInput(field.key, $event)"
                    class="form-input w-full px-3 py-2.5 bg-sw-bg-darkest border border-sw-border rounded text-sw-text text-sm font-mono box-border focus:border-sw-accent focus:outline-none"
                    required
                  />
                </div>
              }
            }

            @if (hasOAuthFields()) {
              <div
                class="oauth-section my-4 p-4 bg-sw-bg-darkest border border-sw-border rounded"
                data-testid="oauth-section"
              >
                @if (!deviceCodeInfo && oauthStatus !== 'polling' && oauthStatus !== 'starting') {
                  <button
                    type="button"
                    class="btn-oauth px-5 py-2 bg-transparent text-sw-accent border border-sw-accent rounded text-sm font-mono cursor-pointer transition-all duration-200 hover:bg-sw-accent hover:text-sw-bg-darkest"
                    (click)="onStartOAuth()"
                  >
                    Sign in with Microsoft
                  </button>
                }
                @if (oauthStatus === 'starting') {
                  <p
                    class="polling-status text-sw-text-dim text-[13px] my-2"
                    data-testid="polling-status"
                  >
                    Connecting to Microsoft...
                  </p>
                  <button
                    type="button"
                    class="btn-cancel-oauth px-4 py-1.5 bg-transparent text-sw-error-text border border-sw-error-text rounded text-[13px] font-mono cursor-pointer mt-2"
                    data-testid="btn-cancel-oauth"
                    (click)="cancelOAuth.emit()"
                  >
                    Cancel
                  </button>
                }
                @if (deviceCodeInfo) {
                  <p>Enter this code:</p>
                  <div
                    class="user-code text-[28px] font-mono font-bold tracking-[4px] text-sw-accent my-3 text-center"
                    data-testid="user-code"
                  >
                    {{ deviceCodeInfo.user_code }}
                  </div>
                  <div class="verification-url-row flex items-center gap-2.5 my-2 flex-wrap">
                    <button
                      type="button"
                      class="btn-link px-4 py-1.5 bg-transparent text-sw-accent border border-sw-accent rounded text-[13px] font-mono cursor-pointer inline-block shrink-0"
                      data-testid="btn-link"
                      (click)="openVerificationUrl.emit(deviceCodeInfo.verification_uri)"
                    >
                      Open Microsoft Sign-in
                    </button>
                    <span
                      class="verification-url text-xs font-mono text-sw-text-dim select-all break-all"
                      data-testid="verification-url"
                      >{{ deviceCodeInfo.verification_uri }}</span
                    >
                  </div>
                  @if (oauthStatus === 'polling') {
                    <p
                      class="polling-status text-sw-text-dim text-[13px] my-2"
                      data-testid="polling-status"
                    >
                      Waiting for sign-in...
                    </p>
                  }
                  <button
                    type="button"
                    class="btn-cancel-oauth px-4 py-1.5 bg-transparent text-sw-error-text border border-sw-error-text rounded text-[13px] font-mono cursor-pointer mt-2"
                    data-testid="btn-cancel-oauth"
                    (click)="cancelOAuth.emit()"
                  >
                    Cancel
                  </button>
                }
                @if (oauthStatus === 'success') {
                  <p class="oauth-success text-sw-success-text text-sm" data-testid="oauth-success">
                    Authentication successful
                  </p>
                }
                @if (oauthStatus === 'error' || oauthStatus === 'expired') {
                  <p class="oauth-error text-sw-error-text text-sm" data-testid="oauth-error">
                    {{ oauthStatusMessage }}
                  </p>
                }
              </div>
            }

            @if (svc.service === 'redmine') {
              <div class="mappings-section mt-4" data-testid="mappings-section">
                <h4 class="text-sw-text-dim text-[13px] mb-2">ID Mappings</h4>
                @for (entry of getMappingEntries(); track entry.key) {
                  <div class="mapping-row flex gap-2 mb-2 items-center">
                    <input
                      class="mapping-key flex-[2] p-2 bg-sw-bg-darkest border border-sw-border rounded text-sw-text text-[13px] font-mono"
                      [value]="entry.key"
                      (input)="onUpdateMappingKey(entry.key, $event)"
                      placeholder="Key"
                    />
                    <input
                      class="mapping-value flex-1 p-2 bg-sw-bg-darkest border border-sw-border rounded text-sw-text text-[13px] font-mono"
                      type="number"
                      [value]="entry.value"
                      (input)="onUpdateMappingValue(entry.key, $event)"
                      placeholder="ID"
                    />
                    <button
                      type="button"
                      class="remove-mapping-btn px-2.5 py-1.5 text-xs bg-transparent text-sw-error-text border border-sw-error-text rounded cursor-pointer font-mono"
                      (click)="onRemoveMapping(entry.key)"
                    >
                      x
                    </button>
                  </div>
                }
                <button
                  type="button"
                  class="add-mapping-btn bg-transparent text-sw-accent border border-dashed border-sw-accent px-3 py-1.5 rounded cursor-pointer text-xs font-mono"
                  (click)="onAddMapping()"
                >
                  + Add Mapping
                </button>
              </div>
            }

            <div class="form-actions flex gap-3 mt-4">
              <button
                type="submit"
                class="btn-save px-5 py-1.5 bg-transparent text-sw-accent border border-sw-accent rounded text-[13px] font-mono cursor-pointer transition-all duration-200 hover:not-disabled:bg-sw-accent hover:not-disabled:text-sw-bg-darkest"
                [attr.data-testid]="'integrations-save-' + svc.service"
              >
                Save
              </button>
              <button
                type="button"
                class="btn-cancel px-5 py-1.5 bg-transparent text-sw-error-text border border-sw-error-text rounded text-[13px] font-mono cursor-pointer"
                data-testid="btn-cancel"
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
  editedMappings: Record<string, number> | null = null;
  private nextMappingId = 0;

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
   * @param event - the checkbox change event
   */
  onToggle(event: Event): void {
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
      }
    }

    if (Object.keys(credentials).length === 0) return;

    this.saveCredentials.emit({
      svc: this.svc,
      credentials,
      mappings: this.svc.service === 'redmine' ? this.editedMappings : null,
    });

    this.editedValues = {};
  }

  /** Returns the current Redmine mapping entries as key-value pairs. */
  getMappingEntries(): { key: string; value: number }[] {
    const source = this.editedMappings ?? (this.svc.mappings as Record<string, number>) ?? {};
    return Object.entries(source).map(([key, value]) => ({ key, value: Number(value) }));
  }

  /**
   * Renames a mapping key while preserving its value.
   * @param oldKey - the current key name
   * @param event - the DOM input event with the new key name
   */
  onUpdateMappingKey(oldKey: string, event: Event): void {
    const newKey = (event.target as HTMLInputElement).value;
    this.ensureEditedMappings();
    const value = this.editedMappings![oldKey];
    delete this.editedMappings![oldKey];
    this.editedMappings![newKey] = value;
  }

  /**
   * Updates the numeric value for a mapping key.
   * @param key - the mapping key to update
   * @param event - the DOM input event with the new value
   */
  onUpdateMappingValue(key: string, event: Event): void {
    const value = parseInt((event.target as HTMLInputElement).value, 10);
    this.ensureEditedMappings();
    this.editedMappings![key] = value;
  }

  /** Adds a new empty mapping entry. */
  onAddMapping(): void {
    this.ensureEditedMappings();
    this.editedMappings![`mapping_${++this.nextMappingId}`] = 0;
  }

  /**
   * Removes a mapping entry by key.
   * @param key - the mapping key to remove
   */
  onRemoveMapping(key: string): void {
    this.ensureEditedMappings();
    delete this.editedMappings![key];
  }

  /** Initializes editedMappings from the service mappings if not yet set. */
  private ensureEditedMappings(): void {
    if (!this.editedMappings) {
      this.editedMappings = {
        ...((this.svc.mappings as Record<string, number>) ?? {}),
      };
    }
  }
}
