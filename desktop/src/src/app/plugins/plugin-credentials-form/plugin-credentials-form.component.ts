import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  MAX_PLUGIN_CREDENTIAL_BYTES,
  PluginAuthField,
  PluginSaveCredentialsEvent,
} from '../../models/plugin';
import { LoggerService } from '../../services/logger.service';

/**
 * Renders a form for a plugin's `auth_fields[]`. Emits the filled subset
 * on submit; emits a separate event when the user requests a full reset.
 *
 * Existing stored token values are **never read back** (the backend treats
 * them as secrets — files are not exposed via any tauri command). The form
 * is always rendered with empty inputs; the placeholder hints at the
 * expected token format. Leaving a field empty preserves whatever is
 * currently on disk; entering a value overwrites it.
 *
 * Per-field byte cap mirrors the Rust-side `MAX_CREDENTIAL_BYTES = 4096`
 * via the `maxlength` attribute, surfaced in the UI before the user hits
 * Save instead of as a backend error response.
 */
@Component({
  selector: 'app-plugin-credentials-form',
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (authFields().length > 0) {
      <form (submit)="onSubmit($event)" data-testid="plugin-credentials-form">
        @for (field of authFields(); track field.key) {
          <div class="my-4">
            <label
              class="mb-1.5 flex items-center gap-2 text-[13px] text-sw-text-muted"
              [for]="'cred-' + field.key"
              data-testid="cred-label"
            >
              <span>
                {{ field.label }}
                @if (field.required) {
                  <span class="text-red-400" aria-label="required">*</span>
                }
              </span>
              @if (isConfigured(field.key)) {
                <span
                  class="rounded bg-sw-success-dark px-1.5 py-0.5 text-[10px] font-medium text-sw-success-text"
                  data-testid="cred-configured-badge"
                  >✓ set</span
                >
                @if (confirmingClearKey === field.key) {
                  <span class="text-[11px] text-red-300">Clear?</span>
                  <button
                    type="button"
                    class="text-[11px] font-semibold text-red-300 underline"
                    [attr.data-testid]="'cred-clear-confirm-' + field.key"
                    (click)="confirmClear(field.key)"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    class="text-[11px] text-sw-text-ghost underline"
                    [attr.data-testid]="'cred-clear-cancel-' + field.key"
                    (click)="cancelClear()"
                  >
                    Cancel
                  </button>
                } @else {
                  <button
                    type="button"
                    class="text-[11px] text-sw-text-ghost underline hover:text-red-300"
                    [attr.data-testid]="'cred-clear-' + field.key"
                    (click)="requestClear(field.key)"
                  >
                    clear
                  </button>
                }
              }
            </label>
            @if (field.description) {
              <p
                [id]="'cred-desc-' + field.key"
                class="mb-1.5 text-[11px] leading-relaxed text-sw-text-ghost"
                data-testid="cred-description"
              >
                {{ field.description }}
              </p>
            }
            @if (field.field_type === 'textarea') {
              <!-- Multi-line secret (PEM, service-account JSON). The HTML
                   pattern attribute is invalid on textarea, so the regex is
                   checked by JS at submit + the backend. Masked with
                   -webkit-text-security when is_secret (Tauri webviews are
                   Chromium/WebKit). -->
              <textarea
                [id]="'cred-' + field.key"
                rows="3"
                [placeholder]="
                  isConfigured(field.key) ? '•••••••• stored — type to replace' : field.placeholder
                "
                [value]="getValue(field.key)"
                (input)="onFieldInput(field.key, $event)"
                (blur)="onFieldBlur(field, $event)"
                autocomplete="off"
                spellcheck="false"
                [attr.maxlength]="maxCredentialBytes"
                [attr.aria-describedby]="describedByFor(field.key)"
                [attr.aria-invalid]="errorFor(field.key) ? 'true' : null"
                [class.cred-secret-mask]="field.is_secret"
                class="box-border w-full resize-y rounded border border-sw-border bg-sw-bg-darkest
                       px-3 py-2.5 font-mono text-sm text-sw-text
                       focus:border-sw-accent focus:outline-none"
                [attr.data-testid]="'cred-input-' + field.key"
              ></textarea>
            } @else {
              <input
                [id]="'cred-' + field.key"
                [type]="field.field_type === 'password' ? 'password' : 'text'"
                [placeholder]="
                  isConfigured(field.key) ? '•••••••• stored — type to replace' : field.placeholder
                "
                [value]="getValue(field.key)"
                (input)="onFieldInput(field.key, $event)"
                (blur)="onFieldBlur(field, $event)"
                autocomplete="off"
                spellcheck="false"
                [attr.maxlength]="maxCredentialBytes"
                [attr.pattern]="field.validation?.pattern ?? null"
                [attr.title]="field.validation?.message ?? null"
                [attr.aria-describedby]="describedByFor(field.key)"
                [attr.aria-invalid]="errorFor(field.key) ? 'true' : null"
                class="box-border w-full rounded border border-sw-border bg-sw-bg-darkest
                       px-3 py-2.5 font-mono text-sm text-sw-text
                       focus:border-sw-accent focus:outline-none"
                [attr.data-testid]="'cred-input-' + field.key"
              />
            }
            @if (errorFor(field.key); as err) {
              <p
                [id]="'cred-err-' + field.key"
                class="mt-1.5 text-[11px] leading-relaxed text-red-300"
                role="alert"
                [attr.data-testid]="'cred-error-' + field.key"
              >
                {{ err }}
              </p>
            }
          </div>
        }
        <div class="mt-6 flex gap-3">
          <button
            type="submit"
            [disabled]="!hasAnyValue() || inFlight()"
            class="rounded bg-sw-accent px-4 py-2 font-mono text-[12px]
                   text-sw-bg-darkest disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="save-credentials-btn"
          >
            {{ inFlight() ? 'Saving…' : 'Save credentials' }}
          </button>
          <button
            type="button"
            (click)="clear.emit()"
            class="rounded border border-sw-border bg-transparent px-4 py-2
                   font-mono text-[12px] text-sw-text-muted hover:border-red-500/40
                   hover:text-red-300"
            data-testid="reset-credentials-btn"
          >
            Reset all
          </button>
        </div>
      </form>
    }
  `,
  styles: [
    // Mask multi-line secrets the way <input type=password> masks single-line.
    // Tauri webviews are Chromium (Windows/WebView2) / WebKit (macOS), both
    // support the vendor-prefixed property.
    `
      .cred-secret-mask {
        -webkit-text-security: disc;
      }
    `,
  ],
})
export class PluginCredentialsFormComponent {
  private readonly log = inject(LoggerService);
  readonly authFields = input.required<PluginAuthField[]>();
  /**
   * Keys of fields that currently have a value stored on disk (from
   * `PluginStatusEntry.configured_fields`). Drives the per-field "✓ set"
   * badge + "clear" button. Secrets are never read back, so this is the
   * only signal the form has that a value already exists.
   */
  readonly configuredFields = input<string[]>([]);
  readonly save = output<PluginSaveCredentialsEvent>();
  /**
   * Renamed from `reset` (which collides with the DOM-native form
   * `reset` event — `@angular-eslint/no-output-native` flags it).
   * Semantics unchanged: the host component should call
   * `delete_plugin_credentials` (clear ALL) when this fires.
   */
  readonly clear = output<void>();
  /**
   * Fired with a single field key when the user confirms that field's "clear"
   * (inline Yes/Cancel prompt, like Reset all). Never fired without confirm.
   */
  readonly clearField = output<string>();
  /**
   * True while a save/clear is in flight upstream. When true the Save button
   * is disabled to block double-submit (each click would re-trigger the
   * `save_plugin_credentials` Tauri call + container restart).
   */
  readonly inFlight = input<boolean>(false);

  /** Template binding for the per-field byte cap (mirrors Rust SSOT). */
  protected readonly maxCredentialBytes = MAX_PLUGIN_CREDENTIAL_BYTES;

  /**
   * Key of the field whose `clear` button was clicked; null when no confirm
   * is showing. One-at-a-time — opening another field's confirm replaces it.
   */
  confirmingClearKey: string | null = null;

  /**
   * Stage the confirm for a specific field (first click on "clear").
   * @param key the auth_fields[] entry to clear
   */
  requestClear(key: string): void {
    this.confirmingClearKey = key;
  }

  /**
   * User clicked "Yes" — actually emit `clearField` and dismiss the confirm.
   * @param key the auth_fields[] entry to clear
   */
  confirmClear(key: string): void {
    this.confirmingClearKey = null;
    this.clearField.emit(key);
  }

  /** Dismiss the confirm without clearing. */
  cancelClear(): void {
    this.confirmingClearKey = null;
  }

  /**
   * Space-joined list of `id`s the field is described by, for screen
   * readers — the help text `<p>` and/or the validation error `<p>`. Returns
   * `null` (not empty string) when neither is present so Angular drops the
   * attribute entirely instead of binding an empty `aria-describedby`.
   * @param key the field key
   * @returns the attribute value, or `null`
   */
  describedByFor(key: string): string | null {
    const field = this.authFields().find((f) => f.key === key);
    const ids: string[] = [];
    if (field?.description) ids.push(`cred-desc-${key}`);
    if (this.errorFor(key)) ids.push(`cred-err-${key}`);
    return ids.length ? ids.join(' ') : null;
  }

  /**
   * Re-validate a single field when focus leaves it, so format errors are
   * surfaced as soon as the user moves on — not held until submit.
   * @param field the auth field
   * @param event the blur event
   */
  onFieldBlur(field: PluginAuthField, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
    const value = target.value.trim();
    if (!value) {
      delete this.validationErrors[field.key];
      return;
    }
    const err = this.validationErrorFor(field, value);
    if (err) {
      this.validationErrors[field.key] = err;
    } else {
      delete this.validationErrors[field.key];
    }
  }

  /**
   * True when the given field key has a value stored on disk.
   * @param key the field key (as declared by `auth_fields[].key`)
   * @returns whether `configuredFields` reports a stored value for it
   */
  isConfigured(key: string): boolean {
    return this.configuredFields().includes(key);
  }

  /**
   * Local edit buffer. Never seeded from server — secrets are write-only.
   * Cleared after a successful save so the next render shows empty inputs
   * (otherwise the password field would still hold the just-typed token
   * in memory).
   */
  private values: Record<string, string> = {};

  /**
   * Returns the current edit-buffer value for a given field key, or an
   * empty string when the user has not typed anything for that key yet.
   * @param key the field key (as declared by `auth_fields[].key` in the
   *   plugin manifest)
   * @returns the user's pending input for that key, or `''`
   */
  getValue(key: string): string {
    return this.values[key] ?? '';
  }

  /**
   * Captures a single input event into the local edit buffer. Does not
   * trim — the trim happens at submit time so the user can still see
   * trailing spaces as they type.
   * @param key the field key being edited
   * @param event the DOM input event from the bound `<input>` or `<textarea>`
   */
  onFieldInput(key: string, event: Event): void {
    // Guard the cast — a synthetic event (e.g. dispatched in a test or
    // by an extension) with a non-field target would otherwise write
    // `undefined` into the buffer and break `hasAnyValue()`'s `.trim()`.
    // Both <input> (text/password) and <textarea> (multi-line) are accepted.
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
    this.values[key] = target.value;
    // Clear a stale validation error as soon as the user edits the field —
    // it's re-evaluated on the next submit.
    delete this.validationErrors[key];
  }

  /**
   * Per-field client-side validation errors, populated on submit. Advisory
   * only — `save_plugin_credentials` re-checks the same patterns host-side
   * (the IPC boundary is the authoritative gate).
   */
  private validationErrors: Record<string, string> = {};

  /**
   * Returns the current validation error for a field, or `undefined`.
   * @param key the field key
   * @returns the message to render under the input, or `undefined`
   */
  errorFor(key: string): string | undefined {
    return this.validationErrors[key];
  }

  /**
   * Tests a trimmed value against a field's optional regex constraint,
   * anchored full-match to mirror both the HTML `pattern` attribute and the
   * Rust host-side check. A field with no `validation`, or a compile error
   * in the (manifest-validated) pattern, is treated as valid here — the
   * backend remains the authority.
   * @param field the auth field whose constraint to apply
   * @param value the trimmed candidate value
   * @returns the error message on mismatch, or `null` when acceptable
   */
  private validationErrorFor(field: PluginAuthField, value: string): string | null {
    const validation = field.validation;
    if (!validation) return null;
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${validation.pattern})$`);
    } catch (err) {
      // Pattern compiled in Rust (RE2) but not in JS (e.g. a construct the
      // JS engine rejects). The backend still enforces it on save, so we
      // pass the client check — but log rather than swallow silently.
      this.log.warn(
        `auth_field "${field.key}" pattern not compilable in JS; skipping client check: ${String(err)}`
      );
      return null;
    }
    if (re.test(value)) return null;
    return validation.message ?? `Value for "${field.label}" does not match the required format`;
  }

  /**
   * True if at least one field has a non-empty, non-whitespace value in
   * the edit buffer. Drives the Save button's `disabled` state — a
   * submit with only whitespace would emit `{ credentials: {} }` which
   * the host component drops anyway, so we block the click earlier.
   * @returns whether any input has typed content worth saving
   */
  hasAnyValue(): boolean {
    return Object.values(this.values).some((v) => v.trim().length > 0);
  }

  /**
   * Handles `<form>` submit. Trims every value, drops whitespace-only
   * entries, and emits `save` with the filtered map. Whitespace-only or
   * fully-empty submits are no-ops (the host component would also
   * filter, but blocking earlier avoids a flash of "saving…" state).
   * @param event the form submit event (preventDefault called immediately)
   */
  onSubmit(event: Event): void {
    event.preventDefault();
    const credentials: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.values)) {
      const trimmed = value.trim();
      if (trimmed.length > 0) credentials[key] = trimmed;
    }
    if (Object.keys(credentials).length === 0) return;

    // Validate each filled field against its regex constraint before
    // emitting. Collect every error (not just the first) so the user sees
    // all problems at once. Any error blocks the save; the buffer is kept
    // so the user can correct it.
    const errors: Record<string, string> = {};
    const fields = this.authFields();
    for (const [key, value] of Object.entries(credentials)) {
      const field = fields.find((f) => f.key === key);
      if (!field) continue;
      const err = this.validationErrorFor(field, value);
      if (err) errors[key] = err;
    }
    this.validationErrors = errors;
    if (Object.keys(errors).length > 0) return;

    this.save.emit({ credentials });
    this.values = {};
  }
}
