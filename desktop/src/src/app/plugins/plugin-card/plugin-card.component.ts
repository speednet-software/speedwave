import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PluginStatusEntry } from '../../models/plugin';

/** Payload emitted when the user saves credentials for a plugin. */
export interface SavePluginCredentialsEvent {
  plugin: PluginStatusEntry;
  credentials: Record<string, string>;
}

/** Reusable card for a single installed plugin. */
@Component({
  selector: 'app-plugin-card',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card" [attr.data-testid]="'plugin-card-' + plugin.slug">
      <div class="card-header">
        <button class="card-header-btn" type="button" (click)="toggleExpand.emit(plugin.slug)">
          <span class="service-name">{{ plugin.name }}</span>
          <span class="version-badge">v{{ plugin.version }}</span>
          @if (plugin.service_id) {
            <span
              class="badge"
              [class.configured]="plugin.configured"
              [class.not-configured]="!plugin.configured"
            >
              {{ plugin.configured ? 'Configured' : 'Not Configured' }}
            </span>
          }
        </button>
        <div class="card-actions">
          @if (plugin.service_id) {
            <label
              class="toggle"
              [class.disabled]="!plugin.configured"
              [title]="plugin.configured ? '' : 'Configure credentials to enable'"
            >
              <input
                type="checkbox"
                [checked]="plugin.enabled"
                [disabled]="!plugin.configured"
                (change)="onToggle($event)"
                [attr.data-testid]="'plugin-toggle-' + plugin.slug"
              />
              <span class="slider"></span>
            </label>
          }
        </div>
      </div>
      <p class="card-description">{{ plugin.description }}</p>

      @if (expanded) {
        <div class="card-body">
          @if (plugin.auth_fields.length > 0) {
            <form (submit)="onSave($event)">
              @for (field of plugin.auth_fields; track field.key) {
                <div class="form-group">
                  <label [for]="plugin.slug + '-' + field.key">{{ field.label }}</label>
                  <input
                    [id]="plugin.slug + '-' + field.key"
                    [type]="field.field_type === 'password' ? 'password' : 'text'"
                    [placeholder]="field.placeholder"
                    [value]="getFieldValue(field.key)"
                    (input)="onFieldInput(field.key, $event)"
                    class="form-input"
                  />
                </div>
              }

              <div class="form-actions">
                <button
                  type="submit"
                  class="btn-save"
                  [attr.data-testid]="'plugin-save-' + plugin.slug"
                >
                  Save
                </button>
                <button
                  type="button"
                  class="btn-cancel"
                  [attr.data-testid]="'plugin-delete-creds-' + plugin.slug"
                  (click)="deleteCredentials.emit(plugin)"
                >
                  Remove Credentials
                </button>
              </div>
            </form>
          }

          @if (plugin.token_mount.startsWith('rw')) {
            <p class="token-mount-info">Token mount: {{ plugin.token_mount }}</p>
          }

          <div class="form-actions">
            <button
              type="button"
              class="btn-remove"
              [attr.data-testid]="'plugin-remove-' + plugin.slug"
              (click)="removePlugin.emit(plugin)"
            >
              Uninstall Plugin
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styleUrl: './plugin-card.component.css',
})
export class PluginCardComponent {
  @Input({ required: true }) plugin!: PluginStatusEntry;
  @Input() expanded = false;

  @Output() toggleExpand = new EventEmitter<string>();
  @Output() togglePlugin = new EventEmitter<{ plugin: PluginStatusEntry; event: Event }>();
  @Output() saveCredentials = new EventEmitter<SavePluginCredentialsEvent>();
  @Output() deleteCredentials = new EventEmitter<PluginStatusEntry>();
  @Output() removePlugin = new EventEmitter<PluginStatusEntry>();

  editedValues: Record<string, string> = {};

  /**
   * Returns the current value for a credential field, preferring edited values.
   * @param key - the field key to look up
   */
  getFieldValue(key: string): string {
    return this.editedValues[key] ?? this.plugin.current_values[key] ?? '';
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
   * Emits the togglePlugin event with the plugin and DOM event.
   * @param event - the checkbox change event
   */
  onToggle(event: Event): void {
    this.togglePlugin.emit({ plugin: this.plugin, event });
  }

  /**
   * Collects edited credentials and emits the saveCredentials event.
   * @param event - the form submit event
   */
  onSave(event: Event): void {
    event.preventDefault();
    const credentials: Record<string, string> = {};

    for (const field of this.plugin.auth_fields) {
      const value = this.editedValues[field.key];
      if (value !== undefined && value !== '') {
        credentials[field.key] = value;
      }
    }

    if (Object.keys(credentials).length === 0) return;

    this.saveCredentials.emit({
      plugin: this.plugin,
      credentials,
    });

    this.editedValues = {};
  }
}
