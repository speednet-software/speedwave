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
    <div
      class="bg-sw-bg-navy border border-sw-border rounded-lg mb-3 overflow-hidden"
      [attr.data-testid]="'plugin-card-' + plugin.slug"
    >
      <div class="flex justify-between items-center px-5 py-4">
        <button
          class="flex items-center gap-3 flex-1 cursor-pointer bg-transparent border-none text-inherit font-inherit text-left p-0"
          type="button"
          data-testid="card-header-btn"
          (click)="toggleExpand.emit(plugin.slug)"
        >
          <span class="font-semibold text-base" data-testid="service-name">{{ plugin.name }}</span>
          <span class="text-[11px] text-sw-text-dim font-mono" data-testid="version-badge"
            >v{{ plugin.version }}</span
          >
          @if (plugin.auth_fields.length > 0) {
            <span
              class="text-[11px] px-2 py-0.5 rounded font-medium"
              data-testid="badge"
              [attr.data-status]="plugin.configured ? 'configured' : 'not-configured'"
              [ngClass]="
                plugin.configured
                  ? 'bg-sw-success-dark text-sw-success-text'
                  : 'bg-sw-error-badge text-sw-error-text'
              "
            >
              {{ plugin.configured ? 'Configured' : 'Not Configured' }}
            </span>
          }
        </button>
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="px-3 py-1 bg-transparent text-sw-accent border border-sw-accent rounded text-xs font-mono cursor-pointer transition-all duration-200 hover:bg-sw-accent hover:text-sw-bg-darkest"
            [attr.data-testid]="'plugin-open-' + plugin.slug"
            (click)="openPlugin.emit(plugin.slug); $event.stopPropagation()"
          >
            Open
          </button>
          <label
            class="relative inline-block w-[44px] h-[24px]"
            data-testid="toggle"
            [ngClass]="!plugin.configured ? 'opacity-40 cursor-not-allowed' : ''"
            [title]="plugin.configured ? '' : 'Configure credentials to enable'"
          >
            <input
              type="checkbox"
              class="peer sr-only"
              [checked]="plugin.enabled"
              [disabled]="!plugin.configured"
              (change)="onToggle($event)"
              [attr.data-testid]="'plugin-toggle-' + plugin.slug"
              [ngClass]="!plugin.configured ? 'cursor-not-allowed' : ''"
            />
            <span
              class="absolute inset-0 bg-sw-slider rounded-full cursor-pointer transition-all duration-300 peer-checked:bg-sw-accent before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[3px] before:bottom-[3px] before:bg-white before:rounded-full before:transition-all before:duration-300 peer-checked:before:translate-x-[20px]"
            ></span>
          </label>
        </div>
      </div>
      <p class="px-5 pb-3 text-sw-text-muted text-[13px] m-0" data-testid="card-description">
        {{ plugin.description }}
      </p>

      @if (expanded) {
        <div class="px-5 pb-5 border-t border-sw-border" data-testid="card-body">
          @if (plugin.auth_fields.length > 0) {
            <form (submit)="onSave($event)">
              @for (field of plugin.auth_fields; track field.key) {
                <div class="my-4">
                  <label
                    class="block mb-1.5 text-[13px] text-sw-text-muted"
                    [for]="plugin.slug + '-' + field.key"
                    >{{ field.label }}</label
                  >
                  <input
                    [id]="plugin.slug + '-' + field.key"
                    [type]="field.field_type === 'password' ? 'password' : 'text'"
                    [placeholder]="field.placeholder"
                    [value]="getFieldValue(field.key)"
                    (input)="onFieldInput(field.key, $event)"
                    class="w-full px-3 py-2.5 bg-sw-bg-darkest border border-sw-border rounded text-sw-text text-sm font-mono box-border focus:border-sw-accent focus:outline-none"
                    data-testid="auth-field-input"
                  />
                </div>
              }

              <div class="flex gap-3 mt-4">
                <button
                  type="submit"
                  class="px-5 py-1.5 bg-transparent text-sw-accent border border-sw-accent rounded text-[13px] font-mono cursor-pointer transition-all duration-200 hover:enabled:bg-sw-accent hover:enabled:text-sw-bg-darkest"
                  [attr.data-testid]="'plugin-save-' + plugin.slug"
                >
                  Save
                </button>
                <button
                  type="button"
                  class="px-5 py-1.5 bg-transparent text-sw-error-text border border-sw-error-text rounded text-[13px] font-mono cursor-pointer"
                  [attr.data-testid]="'plugin-delete-creds-' + plugin.slug"
                  (click)="deleteCredentials.emit(plugin)"
                >
                  Remove Credentials
                </button>
              </div>
            </form>
          }

          @if (plugin.token_mount.startsWith('rw')) {
            <p class="text-[11px] text-sw-text-dim mt-2 font-mono">
              Token mount: {{ plugin.token_mount }}
            </p>
          }

          <div class="flex gap-3 mt-4">
            @if (confirmingRemove) {
              <span
                class="text-sw-error-text text-[13px] font-semibold"
                data-testid="confirm-prompt"
                >Are you sure?</span
              >
              <button
                type="button"
                class="px-5 py-1.5 bg-transparent text-sw-error-text border border-sw-error-text rounded text-[13px] font-mono cursor-pointer"
                [attr.data-testid]="'plugin-remove-confirm-' + plugin.slug"
                (click)="onConfirmRemove()"
              >
                Yes, uninstall
              </button>
              <button
                type="button"
                class="px-5 py-1.5 bg-transparent text-sw-error-text border border-sw-error-text rounded text-[13px] font-mono cursor-pointer"
                [attr.data-testid]="'plugin-remove-cancel-' + plugin.slug"
                (click)="confirmingRemove = false"
              >
                Cancel
              </button>
            } @else {
              <button
                type="button"
                class="px-5 py-1.5 bg-transparent text-sw-error-text border border-sw-error-text rounded text-[13px] font-mono cursor-pointer"
                [attr.data-testid]="'plugin-remove-' + plugin.slug"
                (click)="confirmingRemove = true"
              >
                Uninstall Plugin
              </button>
            }
          </div>
        </div>
      }
    </div>
  `,
})
export class PluginCardComponent {
  @Input({ required: true }) plugin!: PluginStatusEntry;
  @Input() expanded = false;

  @Output() toggleExpand = new EventEmitter<string>();
  @Output() openPlugin = new EventEmitter<string>();
  @Output() togglePlugin = new EventEmitter<{ plugin: PluginStatusEntry; event: Event }>();
  @Output() saveCredentials = new EventEmitter<SavePluginCredentialsEvent>();
  @Output() deleteCredentials = new EventEmitter<PluginStatusEntry>();
  @Output() removePlugin = new EventEmitter<PluginStatusEntry>();

  editedValues: Record<string, string> = {};
  confirmingRemove = false;

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
   * Emits removePlugin and resets the confirmation state.
   */
  onConfirmRemove(): void {
    this.confirmingRemove = false;
    this.removePlugin.emit(this.plugin);
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
