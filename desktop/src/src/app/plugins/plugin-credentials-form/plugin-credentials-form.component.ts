import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  MAX_PLUGIN_CREDENTIAL_BYTES,
  PluginAuthField,
  PluginSaveCredentialsEvent,
} from '../../models/plugin';
import { LoggerService } from '../../services/logger.service';
import { OauthConnectComponent } from '../../shared/oauth-connect/oauth-connect.component';
import { OAuthFlowStatus } from '../../models/integration';

/** Renders a form for a plugin's `auth_fields[]`; emits the filled subset on submit and a separate event on full reset. Non-secret values are prefilled from `currentValues`; secret fields stay write-only (rendered empty). */
@Component({
  selector: 'app-plugin-credentials-form',
  imports: [CommonModule, OauthConnectComponent],
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
              <!-- Multi-line secret; regex checked by JS at submit + backend (pattern invalid on textarea). -->
              <textarea
                [id]="'cred-' + field.key"
                rows="3"
                [placeholder]="storedPlaceholder(field)"
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
                [placeholder]="storedPlaceholder(field)"
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

        @if (hasOAuthFields()) {
          <app-oauth-connect
            [providerLabel]="providerLabel()"
            [configured]="oauthConfigured()"
            [status]="oauthStatus()"
            [redirectUri]="oauthRedirectUri()"
            [statusMessage]="oauthStatusMessage()"
            [prerequisitesMet]="oauthPrerequisitesMet()"
            [prerequisitesMissingMessage]="oauthPrerequisitesMissingMessage()"
            (authorize)="authorizeOauth.emit()"
            (cancelFlow)="cancelOauth.emit()"
          />
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
    // Mask multi-line secrets via -webkit-text-security (Chromium/WebKit webviews).
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
   * Keys of fields with a value stored on disk (from
   * `PluginStatusEntry.configured_fields`); drives the "✓ set" badge + clear button.
   */
  readonly configuredFields = input<string[]>([]);
  /**
   * Stored non-secret values keyed by `auth_fields[].key`, from
   * `PluginStatusEntry.current_values`; the host never includes secret keys.
   */
  readonly currentValues = input<Record<string, string>>({});
  readonly save = output<PluginSaveCredentialsEvent>();
  /**
   * Fires when the user requests a full reset; host clears ALL credentials.
   * Named `clear` (not `reset`) to avoid the DOM-native `reset` event collision.
   */
  readonly clear = output<void>();
  /**
   * Fired with a single field key when the user confirms that field's "clear"
   * (inline Yes/Cancel prompt, like Reset all). Never fired without confirm.
   */
  readonly clearField = output<string>();
  /**
   * True while a save/clear is in flight upstream; disables Save to block double-submit.
   */
  readonly inFlight = input<boolean>(false);

  // -- OAuth (authorization_code) flow, when the manifest declares oauth --
  /** Brand shown in the OAuth button (plugin display name). */
  readonly providerLabel = input<string>('provider');
  /** Whether an authorized OAuth state already exists (reconnect copy). */
  readonly oauthConfigured = input<boolean>(false);
  /** Flow status from `plugin_oauth_progress` events. */
  readonly oauthStatus = input<OAuthFlowStatus | null>(null);
  /** Loopback redirect URI to surface while awaiting the browser callback. */
  readonly oauthRedirectUri = input<string | null>(null);
  readonly oauthStatusMessage = input<string>('');
  readonly authorizeOauth = output<void>();
  readonly cancelOauth = output<void>();

  /** Template binding for the per-field byte cap (mirrors Rust SSOT). */
  protected readonly maxCredentialBytes = MAX_PLUGIN_CREDENTIAL_BYTES;

  /** True when any auth field is OAuth-driven (renders the connect UI). */
  hasOAuthFields(): boolean {
    return this.authFields().some((f) => f.oauth_flow);
  }

  /** Required OAuth client-credential fields that must be saved before Authorize. */
  private oauthPrerequisiteFields(): PluginAuthField[] {
    return this.authFields().filter((f) => f.oauth_flow && f.required);
  }

  /**
   * Whether every prerequisite is SAVED (Authorize reads only saved credentials).
   */
  oauthPrerequisitesMet(): boolean {
    return this.oauthPrerequisiteFields().every((f) => this.isConfigured(f.key));
  }

  /** Hint listing the prerequisites still needing to be saved. */
  oauthPrerequisitesMissingMessage(): string {
    const missing = this.oauthPrerequisiteFields()
      .filter((f) => !this.isConfigured(f.key))
      .map((f) => f.label);
    return missing.length ? `Save ${missing.join(', ')} above first, then authorize.` : '';
  }

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
   * Space-joined `id`s for `aria-describedby` (help and/or error `<p>`);
   * `null` when neither is present so Angular drops the attribute.
   * @param key the `auth_fields[].key` identifying the field
   */
  describedByFor(key: string): string | null {
    const field = this.authFields().find((f) => f.key === key);
    const ids: string[] = [];
    if (field?.description) ids.push(`cred-desc-${key}`);
    if (this.errorFor(key)) ids.push(`cred-err-${key}`);
    return ids.length ? ids.join(' ') : null;
  }

  /**
   * Re-validates a single field on blur, so format errors surface as soon
   * as the user moves on — not held until submit.
   * @param field the auth field being validated
   * @param event the blur `Event` whose target holds the current value
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
   * True when the given field key (as declared by `auth_fields[].key`) has
   * a value stored on disk, per `configuredFields`.
   * @param key the `auth_fields[].key` identifying the field
   */
  isConfigured(key: string): boolean {
    return this.configuredFields().includes(key);
  }

  /**
   * Masked "stored" hint only for a configured secret; otherwise the manifest
   * placeholder — a non-secret shows its prefilled value, not this hint.
   * @param field the auth field being rendered
   */
  storedPlaceholder(field: PluginAuthField): string {
    return this.isConfigured(field.key) && field.is_secret
      ? '•••••••• stored — type to replace'
      : field.placeholder;
  }

  /** Local edit buffer for typed values; cleared after a successful save. Never seeded — display falls back to `currentValues` via `getValue`. */
  private values: Record<string, string> = {};

  /**
   * Value shown in a field's input: what the user typed, else the stored
   * non-secret value. Secrets are never read back — they render empty.
   * @param key the `auth_fields[].key` identifying the field
   */
  getValue(key: string): string {
    const typed = this.values[key];
    if (typed !== undefined) return typed;
    if (this.authFields().find((f) => f.key === key)?.is_secret) return '';
    return this.currentValues()[key] ?? '';
  }

  /**
   * Captures an input event into the edit buffer for `key`; trims only at submit.
   * @param key the `auth_fields[].key` identifying the field
   * @param event the `input` event whose target holds the new value
   */
  onFieldInput(key: string, event: Event): void {
    // Guard the cast against a non-field event target.
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
    this.values[key] = target.value;
    // Clear a stale validation error on edit; re-evaluated on next submit.
    delete this.validationErrors[key];
  }

  /** Per-field client-side validation errors, populated on submit. Advisory only — `save_plugin_credentials` re-checks host-side (authoritative gate). */
  private validationErrors: Record<string, string> = {};

  /**
   * Returns the current validation error for a field key, or `undefined`;
   * the message to render under the input.
   * @param key the `auth_fields[].key` identifying the field
   */
  errorFor(key: string): string | undefined {
    return this.validationErrors[key];
  }

  /**
   * Tests a trimmed value against a field's optional regex (anchored
   * full-match); no `validation` or an uncompilable pattern is treated as valid.
   * @param field the auth field whose `validation` pattern to apply
   * @param value the trimmed value to test
   */
  private validationErrorFor(field: PluginAuthField, value: string): string | null {
    const validation = field.validation;
    if (!validation) return null;
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${validation.pattern})$`);
    } catch (err) {
      // Pattern compiles in Rust (RE2) but not JS; backend still enforces on save.
      this.log.warn(
        `auth_field "${field.key}" pattern not compilable in JS; skipping client check: ${String(err)}`
      );
      return null;
    }
    if (re.test(value)) return null;
    return validation.message ?? `Value for "${field.label}" does not match the required format`;
  }

  /** True if any field has a non-whitespace value in the edit buffer; drives the Save button's `disabled` state. */
  hasAnyValue(): boolean {
    return Object.values(this.values).some((v) => v.trim().length > 0);
  }

  /**
   * Handles `<form>` submit: trims values, drops empty entries, emits `save`.
   * Whitespace-only or fully-empty submits are no-ops.
   * @param event the form `submit` event
   */
  onSubmit(event: Event): void {
    event.preventDefault();
    const credentials: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.values)) {
      const trimmed = value.trim();
      if (trimmed.length > 0) credentials[key] = trimmed;
    }
    if (Object.keys(credentials).length === 0) return;

    // Validate each filled field against its regex, collecting all errors.
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
