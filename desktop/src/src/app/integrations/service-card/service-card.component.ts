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
    <div class="card" [attr.data-testid]="'integrations-service-' + svc.service">
      <div class="card-header">
        <button class="card-header-btn" type="button" (click)="toggleExpand.emit(svc.service)">
          <span class="service-name">{{ svc.display_name }}</span>
          <span
            class="badge"
            [class.configured]="svc.configured"
            [class.not-configured]="!svc.configured"
          >
            {{ svc.configured ? 'Configured' : 'Not Configured' }}
          </span>
        </button>
        <div class="card-actions">
          <label
            class="toggle"
            [class.disabled]="!svc.configured"
            [title]="svc.configured ? '' : 'Configure credentials to enable'"
          >
            <input
              type="checkbox"
              [checked]="svc.enabled"
              [disabled]="!svc.configured"
              (change)="onToggle($event)"
              [attr.data-testid]="'integrations-toggle-' + svc.service"
            />
            <span class="slider"></span>
          </label>
        </div>
      </div>
      <p class="card-description">{{ svc.description }}</p>

      @if (expanded) {
        <div class="card-body">
          <form (submit)="onSave($event)">
            @for (field of svc.auth_fields; track field.key) {
              @if (!field.oauth_flow) {
                <div class="form-group">
                  <label [for]="svc.service + '-' + field.key">{{ field.label }}</label>
                  <input
                    [id]="svc.service + '-' + field.key"
                    [type]="field.field_type === 'password' ? 'password' : 'text'"
                    [placeholder]="field.placeholder"
                    [value]="getFieldValue(field.key)"
                    (input)="onFieldInput(field.key, $event)"
                    class="form-input"
                    required
                  />
                </div>
              }
            }

            @if (hasOAuthFields()) {
              <div class="oauth-section">
                @if (!deviceCodeInfo && oauthStatus !== 'polling' && oauthStatus !== 'starting') {
                  <button type="button" class="btn-oauth" (click)="onStartOAuth()">
                    Sign in with Microsoft
                  </button>
                }
                @if (oauthStatus === 'starting') {
                  <p class="polling-status">Connecting to Microsoft...</p>
                  <button type="button" class="btn-cancel-oauth" (click)="cancelOAuth.emit()">
                    Cancel
                  </button>
                }
                @if (deviceCodeInfo) {
                  <p>Enter this code:</p>
                  <div class="user-code">{{ deviceCodeInfo.user_code }}</div>
                  <div class="verification-url-row">
                    <button
                      type="button"
                      class="btn-link"
                      (click)="openVerificationUrl.emit(deviceCodeInfo.verification_uri)"
                    >
                      Open Microsoft Sign-in
                    </button>
                    <span class="verification-url">{{ deviceCodeInfo.verification_uri }}</span>
                  </div>
                  @if (oauthStatus === 'polling') {
                    <p class="polling-status">Waiting for sign-in...</p>
                  }
                  <button type="button" class="btn-cancel-oauth" (click)="cancelOAuth.emit()">
                    Cancel
                  </button>
                }
                @if (oauthStatus === 'success') {
                  <p class="oauth-success">Authentication successful</p>
                }
                @if (oauthStatus === 'error' || oauthStatus === 'expired') {
                  <p class="oauth-error">{{ oauthStatusMessage }}</p>
                }
              </div>
            }

            @if (svc.service === 'redmine') {
              <div class="mappings-section">
                <h4>ID Mappings</h4>
                @for (entry of getMappingEntries(); track entry.key) {
                  <div class="mapping-row">
                    <input
                      class="mapping-key"
                      [value]="entry.key"
                      (input)="onUpdateMappingKey(entry.key, $event)"
                      placeholder="Key"
                    />
                    <input
                      class="mapping-value"
                      type="number"
                      [value]="entry.value"
                      (input)="onUpdateMappingValue(entry.key, $event)"
                      placeholder="ID"
                    />
                    <button
                      type="button"
                      class="remove-mapping-btn"
                      (click)="onRemoveMapping(entry.key)"
                    >
                      x
                    </button>
                  </div>
                }
                <button type="button" class="add-mapping-btn" (click)="onAddMapping()">
                  + Add Mapping
                </button>
              </div>
            }

            <div class="form-actions">
              <button
                type="submit"
                class="btn-save"
                [attr.data-testid]="'integrations-save-' + svc.service"
              >
                Save
              </button>
              <button
                type="button"
                class="btn-cancel"
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
  styleUrl: './service-card.component.css',
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
