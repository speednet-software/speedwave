import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { JsonSchema } from '../../models/plugin';

/** Renders a settings form dynamically from a JSON Schema definition. */
@Component({
  selector: 'app-plugin-settings-form',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!schema) {
      <p class="text-sw-text-dim text-[13px]" data-testid="no-settings">
        No configurable settings for this plugin.
      </p>
    } @else {
      <form (submit)="onSubmit($event)">
        @for (key of propertyKeys(); track key) {
          <div class="form-group my-4">
            <label class="block mb-1.5 text-[13px] text-sw-text-muted" [for]="'setting-' + key">{{
              key
            }}</label>
            @if (schema.properties[key].description) {
              <span class="block text-[11px] text-sw-text-ghost mb-1.5" data-testid="field-hint">{{
                schema.properties[key].description
              }}</span>
            }

            @if (schema.properties[key].enum) {
              <select
                [id]="'setting-' + key"
                class="w-full px-3 py-2.5 bg-sw-bg-darkest border border-sw-border rounded text-sw-text text-sm font-mono box-border focus:border-sw-accent focus:outline-none"
                [value]="getValue(key)"
                (change)="onFieldChange(key, $event)"
                [attr.data-testid]="'setting-' + key"
              >
                @for (opt of schema.properties[key].enum; track opt) {
                  <option [value]="opt" [selected]="opt === getValue(key)">{{ opt }}</option>
                }
              </select>
            } @else if (schema.properties[key].type === 'boolean') {
              <label class="flex items-center gap-2 text-[13px] text-sw-text cursor-pointer">
                <input
                  type="checkbox"
                  [id]="'setting-' + key"
                  class="accent-sw-accent"
                  [checked]="getValue(key) === true"
                  (change)="onCheckboxChange(key, $event)"
                  [attr.data-testid]="'setting-' + key"
                />
                Enabled
              </label>
            } @else if (
              schema.properties[key].type === 'number' || schema.properties[key].type === 'integer'
            ) {
              <input
                type="number"
                [id]="'setting-' + key"
                class="form-input w-full px-3 py-2.5 bg-sw-bg-darkest border border-sw-border rounded text-sw-text text-sm font-mono box-border focus:border-sw-accent focus:outline-none"
                [value]="getValue(key)"
                (input)="onFieldChange(key, $event)"
                [attr.data-testid]="'setting-' + key"
              />
            } @else {
              <input
                type="text"
                [id]="'setting-' + key"
                class="form-input w-full px-3 py-2.5 bg-sw-bg-darkest border border-sw-border rounded text-sw-text text-sm font-mono box-border focus:border-sw-accent focus:outline-none"
                [value]="getValue(key)"
                (input)="onFieldChange(key, $event)"
                [attr.data-testid]="'setting-' + key"
              />
            }
          </div>
        }

        <div class="flex gap-3 mt-4">
          <button
            type="submit"
            class="btn-save px-5 py-1.5 bg-transparent text-sw-accent border border-sw-accent rounded text-[13px] font-mono cursor-pointer transition-all duration-200 hover:bg-sw-accent hover:text-sw-bg-darkest"
            data-testid="settings-save"
          >
            Save Settings
          </button>
        </div>
      </form>
    }
  `,
})
export class PluginSettingsFormComponent {
  @Input() schema: JsonSchema | null = null;
  @Input() values: Record<string, unknown> = {};

  @Output() save = new EventEmitter<Record<string, unknown>>();

  editedValues: Record<string, unknown> = {};

  /** Returns sorted property keys from the schema. */
  propertyKeys(): string[] {
    if (!this.schema) return [];
    return Object.keys(this.schema.properties).sort();
  }

  /**
   * Returns the current value for a key, falling back to saved value then schema default.
   * @param key - the property key to look up
   */
  getValue(key: string): unknown {
    if (key in this.editedValues) return this.editedValues[key];
    if (key in this.values) return this.values[key];
    return this.schema?.properties[key]?.default ?? '';
  }

  /**
   * Handles text/number/select input changes.
   * @param key - the property key
   * @param event - the DOM input event
   */
  onFieldChange(key: string, event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const prop = this.schema?.properties[key];
    if (prop && (prop.type === 'number' || prop.type === 'integer')) {
      this.editedValues[key] = Number(target.value);
    } else {
      this.editedValues[key] = target.value;
    }
  }

  /**
   * Handles checkbox changes.
   * @param key - the property key
   * @param event - the checkbox change event
   */
  onCheckboxChange(key: string, event: Event): void {
    this.editedValues[key] = (event.target as HTMLInputElement).checked;
  }

  /**
   * Collects all values and emits them on form submit.
   * @param event - the form submit event
   */
  onSubmit(event: Event): void {
    event.preventDefault();
    const result: Record<string, unknown> = {};
    for (const key of this.propertyKeys()) {
      result[key] = this.getValue(key);
    }
    this.save.emit(result);
  }
}
