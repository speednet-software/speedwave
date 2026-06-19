import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PluginCredentialsFormComponent } from './plugin-credentials-form.component';
import {
  MAX_PLUGIN_CREDENTIAL_BYTES,
  PluginAuthField,
  PluginSaveCredentialsEvent,
} from '../../models/plugin';

function makeAuthFields(): PluginAuthField[] {
  return [
    {
      key: 'example_pat',
      label: 'Example Plugin Personal Access Token',
      field_type: 'password',
      placeholder: 'ex_...',
      is_secret: true,
      required: true,
    },
    {
      key: 'example_oauth',
      label: 'Example Plugin Remote MCP OAuth Token',
      field_type: 'password',
      placeholder: 'exmcp_...',
      is_secret: true,
      required: false,
    },
  ];
}

/**
 * Helper: dispatch an input event on a query-selected element.
 * Mirrors the pattern used in plugin-settings-form.component.spec.ts.
 * @param fixture the component fixture whose nativeElement we query
 * @param selector CSS selector for the `<input>` element to write into
 * @param value the new input value to set + fire as an `input` event
 */
function setInputValue(
  fixture: ComponentFixture<PluginCredentialsFormComponent>,
  selector: string,
  value: string
): void {
  const input = fixture.nativeElement.querySelector(selector) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('PluginCredentialsFormComponent', () => {
  let component: PluginCredentialsFormComponent;
  let fixture: ComponentFixture<PluginCredentialsFormComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PluginCredentialsFormComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(PluginCredentialsFormComponent);
    component = fixture.componentInstance;
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  it('renders a password input for is_secret=true / field_type=password fields', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector(
      '[data-testid="cred-input-example_pat"]'
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe('password');
  });

  it('renders a text input for non-password field_type', () => {
    const fields: PluginAuthField[] = [
      {
        key: 'host_url',
        label: 'Host URL',
        field_type: 'text',
        placeholder: 'https://...',
        is_secret: false,
        required: true,
      },
    ];
    fixture.componentRef.setInput('authFields', fields);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector(
      '[data-testid="cred-input-host_url"]'
    ) as HTMLInputElement;
    expect(input.type).toBe('text');
  });

  it('renders a <textarea> for field_type="textarea" and captures input', () => {
    const fields: PluginAuthField[] = [
      {
        key: 'service_account',
        label: 'Service account JSON',
        field_type: 'textarea',
        placeholder: '{ ... }',
        is_secret: true,
        required: false,
      },
    ];
    fixture.componentRef.setInput('authFields', fields);
    fixture.detectChanges();

    const el = fixture.nativeElement.querySelector(
      '[data-testid="cred-input-service_account"]'
    ) as HTMLElement;
    expect(el.tagName).toBe('TEXTAREA');

    // onFieldInput must accept HTMLTextAreaElement (not just HTMLInputElement).
    const saveSpy = vi.fn<(event: PluginSaveCredentialsEvent) => void>();
    component.save.subscribe(saveSpy);
    setInputValue(fixture, '[data-testid="cred-input-service_account"]', '{"k":"v"}');
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="plugin-credentials-form"]'
      ) as HTMLFormElement
    ).dispatchEvent(new Event('submit'));

    expect(saveSpy).toHaveBeenCalledWith({ credentials: { service_account: '{"k":"v"}' } });
  });

  it('renders field.description under the label when present', () => {
    const fields: PluginAuthField[] = [
      {
        key: 'example_pat',
        label: 'Example Plugin PAT',
        field_type: 'password',
        placeholder: 'ex_...',
        is_secret: true,
        required: false,
        description: 'Optional. Unlocks REST tools.',
      },
    ];
    fixture.componentRef.setInput('authFields', fields);
    fixture.detectChanges();
    const desc = fixture.nativeElement.querySelector('[data-testid="cred-description"]');
    expect(desc).not.toBeNull();
    expect(desc.textContent.trim()).toBe('Optional. Unlocks REST tools.');
  });

  it('omits the description element when the field has no description', () => {
    // makeAuthFields() entries have no `description` → element absent.
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="cred-description"]')).toBeNull();
  });

  // ── #6: per-field configured status + clear ─────────────────────────────

  it('shows the "✓ set" badge only for fields in configuredFields', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.componentRef.setInput('configuredFields', ['example_pat']); // only PAT stored
    fixture.detectChanges();

    const badges = fixture.nativeElement.querySelectorAll('[data-testid="cred-configured-badge"]');
    expect(badges.length).toBe(1); // only example_pat, not example_oauth
  });

  it('shows no configured badges when configuredFields is empty (default)', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelectorAll('[data-testid="cred-configured-badge"]').length
    ).toBe(0);
  });

  it('per-field clear is confirm-gated (first click stages, Yes emits)', () => {
    // First click stages confirm; only Yes emits clearField.
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.componentRef.setInput('configuredFields', ['example_pat']);
    fixture.detectChanges();

    const clearFieldSpy = vi.fn<(key: string) => void>();
    component.clearField.subscribe(clearFieldSpy);

    // First click stages the confirm — no emit yet.
    (
      fixture.nativeElement.querySelector(
        '[data-testid="cred-clear-example_pat"]'
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    expect(clearFieldSpy).not.toHaveBeenCalled();
    const confirmBtn = fixture.nativeElement.querySelector(
      '[data-testid="cred-clear-confirm-example_pat"]'
    ) as HTMLButtonElement;
    expect(confirmBtn).not.toBeNull();

    // Confirm — now emit.
    confirmBtn.click();
    expect(clearFieldSpy).toHaveBeenCalledWith('example_pat');
  });

  it('per-field clear Cancel dismisses the confirm without emitting', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.componentRef.setInput('configuredFields', ['example_pat']);
    fixture.detectChanges();
    const clearFieldSpy = vi.fn<(key: string) => void>();
    component.clearField.subscribe(clearFieldSpy);

    (
      fixture.nativeElement.querySelector(
        '[data-testid="cred-clear-example_pat"]'
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="cred-clear-cancel-example_pat"]'
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    expect(clearFieldSpy).not.toHaveBeenCalled();
    // After cancel the confirm is gone — original "clear" link is back.
    expect(
      fixture.nativeElement.querySelector('[data-testid="cred-clear-example_pat"]')
    ).not.toBeNull();
  });

  it('shows a "stored — type to replace" placeholder for configured fields', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.componentRef.setInput('configuredFields', ['example_pat']);
    fixture.detectChanges();

    const patInput = fixture.nativeElement.querySelector(
      '[data-testid="cred-input-example_pat"]'
    ) as HTMLInputElement;
    const oauthInput = fixture.nativeElement.querySelector(
      '[data-testid="cred-input-example_oauth"]'
    ) as HTMLInputElement;
    expect(patInput.placeholder).toContain('stored');
    expect(oauthInput.placeholder).toBe('exmcp_...'); // not configured → original placeholder
  });

  it('renders required marker for required fields and not for optional', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();
    const labels = fixture.nativeElement.querySelectorAll('[data-testid="cred-label"]');
    // example_pat (required: true) → label has the "*" marker
    expect(labels[0].querySelector('[aria-label="required"]')).not.toBeNull();
    // example_oauth (required: false) → no marker
    expect(labels[1].querySelector('[aria-label="required"]')).toBeNull();
  });

  it('emits filled credentials on submit', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();

    const saveSpy = vi.fn<(event: PluginSaveCredentialsEvent) => void>();
    component.save.subscribe(saveSpy);

    setInputValue(fixture, '[data-testid="cred-input-example_pat"]', 'ex_TEST');
    fixture.detectChanges();

    const form = fixture.nativeElement.querySelector(
      '[data-testid="plugin-credentials-form"]'
    ) as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));

    expect(saveSpy).toHaveBeenCalledOnce();
    expect(saveSpy).toHaveBeenCalledWith({ credentials: { example_pat: 'ex_TEST' } });
  });

  it('renders a typed input for oauth_flow client fields and emits their value on save', () => {
    // An oauth_flow:true client field must be typeable and submitted.
    fixture.componentRef.setInput('authFields', [
      {
        key: 'client_id',
        label: 'Client ID',
        field_type: 'text',
        placeholder: 'cid',
        is_secret: false,
        required: true,
        oauth_flow: true,
      },
    ]);
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="cred-input-client_id"]'
    ) as HTMLInputElement;
    expect(input).not.toBeNull();

    const saveSpy = vi.fn<(event: PluginSaveCredentialsEvent) => void>();
    component.save.subscribe(saveSpy);
    setInputValue(fixture, '[data-testid="cred-input-client_id"]', 'cid-123');
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="plugin-credentials-form"]'
      ) as HTMLFormElement
    ).dispatchEvent(new Event('submit'));

    expect(saveSpy).toHaveBeenCalledWith({ credentials: { client_id: 'cid-123' } });
  });

  it('emits clear event when Reset all is clicked', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();

    const clearSpy = vi.fn<() => void>();
    component.clear.subscribe(clearSpy);

    const btn = fixture.nativeElement.querySelector(
      '[data-testid="reset-credentials-btn"]'
    ) as HTMLButtonElement;
    btn.click();

    expect(clearSpy).toHaveBeenCalledOnce();
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  it('does not render anything when authFields is empty', () => {
    fixture.componentRef.setInput('authFields', []);
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector('[data-testid="plugin-credentials-form"]');
    expect(form).toBeNull();
  });

  it('disables Save button when all fields are empty', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="save-credentials-btn"]'
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('enables Save button after typing any value', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();

    setInputValue(fixture, '[data-testid="cred-input-example_pat"]', 'ex_T');
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector(
      '[data-testid="save-credentials-btn"]'
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('trims values and drops fields that become empty after trim', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();

    const saveSpy = vi.fn<(event: PluginSaveCredentialsEvent) => void>();
    component.save.subscribe(saveSpy);

    setInputValue(fixture, '[data-testid="cred-input-example_pat"]', '  ex_TRIMMED  ');
    setInputValue(fixture, '[data-testid="cred-input-example_oauth"]', '    '); // whitespace-only
    fixture.detectChanges();

    const form = fixture.nativeElement.querySelector(
      '[data-testid="plugin-credentials-form"]'
    ) as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));

    expect(saveSpy).toHaveBeenCalledWith({
      credentials: { example_pat: 'ex_TRIMMED' },
    });
  });

  it('does not emit save when every field is whitespace-only', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();

    const saveSpy = vi.fn<(event: PluginSaveCredentialsEvent) => void>();
    component.save.subscribe(saveSpy);

    setInputValue(fixture, '[data-testid="cred-input-example_pat"]', '   ');
    fixture.detectChanges();

    const form = fixture.nativeElement.querySelector(
      '[data-testid="plugin-credentials-form"]'
    ) as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('sets maxlength on inputs (mirrors Rust MAX_CREDENTIAL_BYTES)', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector(
      '[data-testid="cred-input-example_pat"]'
    ) as HTMLInputElement;
    expect(input.getAttribute('maxlength')).toBe(String(MAX_PLUGIN_CREDENTIAL_BYTES));
  });

  // ── H7 a11y wiring ─────────────────────────────────────────────────────

  it('wires aria-describedby to description + error ids when present', () => {
    const fields: PluginAuthField[] = [
      {
        key: 'example_pat',
        label: 'PAT',
        field_type: 'password',
        placeholder: '',
        is_secret: true,
        required: true,
        description: 'Generate at the provider console.',
        validation: { pattern: '^ex_.+$', message: 'starts with ex_' },
      },
    ];
    fixture.componentRef.setInput('authFields', fields);
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="cred-input-example_pat"]'
    ) as HTMLInputElement;
    // Description present → described-by includes it; no error yet → only desc.
    expect(input.getAttribute('aria-describedby')).toBe('cred-desc-example_pat');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('#cred-desc-example_pat'),
      'description <p> must have the bound id'
    ).not.toBeNull();

    // Submit invalid value → error appears, both ids in described-by + aria-invalid=true.
    setInputValue(fixture, '[data-testid="cred-input-example_pat"]', 'ghp_wrong');
    (
      fixture.nativeElement.querySelector(
        '[data-testid="plugin-credentials-form"]'
      ) as HTMLFormElement
    ).dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    expect(input.getAttribute('aria-describedby')).toBe(
      'cred-desc-example_pat cred-err-example_pat'
    );
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const errEl = fixture.nativeElement.querySelector('#cred-err-example_pat');
    expect(errEl).not.toBeNull();
    expect(errEl?.getAttribute('role')).toBe('alert');
  });

  it('drops aria-describedby when neither description nor error is present', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields()); // no description
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector(
      '[data-testid="cred-input-example_pat"]'
    ) as HTMLInputElement;
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });

  // ── H8 secret masking on textarea ──────────────────────────────────────

  it('applies the secret-mask CSS class to <textarea> when is_secret', () => {
    const fields: PluginAuthField[] = [
      {
        key: 'pem',
        label: 'PEM key',
        field_type: 'textarea',
        placeholder: '-----BEGIN…',
        is_secret: true,
        required: false,
      },
    ];
    fixture.componentRef.setInput('authFields', fields);
    fixture.detectChanges();
    const el = fixture.nativeElement.querySelector(
      '[data-testid="cred-input-pem"]'
    ) as HTMLTextAreaElement;
    expect(el.classList.contains('cred-secret-mask')).toBe(true);
  });

  // ── M7 blur validation ─────────────────────────────────────────────────

  it('re-validates on blur (not just on submit)', () => {
    const fields: PluginAuthField[] = [
      {
        key: 'example_pat',
        label: 'Token',
        field_type: 'password',
        placeholder: '',
        is_secret: true,
        required: false,
        validation: { pattern: '^ex_.+$', message: 'must start with ex_' },
      },
    ];
    fixture.componentRef.setInput('authFields', fields);
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="cred-input-example_pat"]'
    ) as HTMLInputElement;
    input.value = 'ghp_bad';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-testid="cred-error-example_pat"]')
    ).not.toBeNull();
  });

  // ── M8 Save button disabled during in-flight ──────────────────────────

  it('disables Save and switches label to "Saving…" while inFlight', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.componentRef.setInput('inFlight', true);
    fixture.detectChanges();

    setInputValue(fixture, '[data-testid="cred-input-example_pat"]', 'ex_x');
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="save-credentials-btn"]'
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent?.trim()).toBe('Saving…');
  });

  it('ignores input events whose target is not an HTMLInputElement', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();

    // Synthetic event with a non-input target (e.g. a div).
    const fakeEvent = { target: document.createElement('div') } as unknown as Event;
    component.onFieldInput('example_pat', fakeEvent);

    expect(() => component.hasAnyValue()).not.toThrow();
    expect(component.hasAnyValue()).toBe(false);
    expect(component.getValue('example_pat')).toBe('');
  });

  // ── State transitions ──────────────────────────────────────────────────

  it('clears local buffer after a successful save (next render shows empty inputs)', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();

    setInputValue(fixture, '[data-testid="cred-input-example_pat"]', 'ex_TEMP');
    fixture.detectChanges();

    const form = fixture.nativeElement.querySelector(
      '[data-testid="plugin-credentials-form"]'
    ) as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    // After save, getValue returns empty — buffer was wiped.
    expect(component.getValue('example_pat')).toBe('');
    expect(component.hasAnyValue()).toBe(false);
  });

  it('emits credentials for both fields when both are filled', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();

    const saveSpy = vi.fn<(event: PluginSaveCredentialsEvent) => void>();
    component.save.subscribe(saveSpy);

    setInputValue(fixture, '[data-testid="cred-input-example_pat"]', 'ex_AAA');
    setInputValue(fixture, '[data-testid="cred-input-example_oauth"]', 'exmcp_BBB');
    fixture.detectChanges();

    const form = fixture.nativeElement.querySelector(
      '[data-testid="plugin-credentials-form"]'
    ) as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));

    expect(saveSpy).toHaveBeenCalledWith({
      credentials: { example_pat: 'ex_AAA', example_oauth: 'exmcp_BBB' },
    });
  });

  // ── #5: auth_field validation (regex pattern + message) ───────────────────

  function validatedField(message?: string): PluginAuthField[] {
    return [
      {
        key: 'example_pat',
        label: 'Example Plugin Personal Access Token',
        field_type: 'password',
        placeholder: 'ex_...',
        is_secret: true,
        required: false,
        validation: { pattern: '^ex_[A-Za-z0-9_-]+$', message },
      },
    ];
  }

  it('binds the validation pattern + message to the input attributes', () => {
    fixture.componentRef.setInput('authFields', validatedField('Must start with ex_'));
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector(
      '[data-testid="cred-input-example_pat"]'
    ) as HTMLInputElement;
    expect(input.getAttribute('pattern')).toBe('^ex_[A-Za-z0-9_-]+$');
    expect(input.getAttribute('title')).toBe('Must start with ex_');
  });

  it('omits the pattern attribute when the field has no validation', () => {
    fixture.componentRef.setInput('authFields', makeAuthFields());
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector(
      '[data-testid="cred-input-example_pat"]'
    ) as HTMLInputElement;
    expect(input.getAttribute('pattern')).toBeNull();
  });

  it('blocks save and shows the author message when the value fails the pattern', () => {
    fixture.componentRef.setInput('authFields', validatedField('Must start with ex_'));
    fixture.detectChanges();

    const saveSpy = vi.fn<(event: PluginSaveCredentialsEvent) => void>();
    component.save.subscribe(saveSpy);

    setInputValue(fixture, '[data-testid="cred-input-example_pat"]', 'ghp_wrongprefix');
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="plugin-credentials-form"]'
      ) as HTMLFormElement
    ).dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(saveSpy).not.toHaveBeenCalled();
    const err = fixture.nativeElement.querySelector('[data-testid="cred-error-example_pat"]');
    expect(err?.textContent?.trim()).toBe('Must start with ex_');
  });

  it('falls back to a generic message when validation has no message', () => {
    fixture.componentRef.setInput('authFields', validatedField()); // no message
    fixture.detectChanges();

    setInputValue(fixture, '[data-testid="cred-input-example_pat"]', 'nope');
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="plugin-credentials-form"]'
      ) as HTMLFormElement
    ).dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    const err = fixture.nativeElement.querySelector('[data-testid="cred-error-example_pat"]');
    expect(err?.textContent).toContain('does not match the required format');
  });

  it('emits save when the value matches the pattern', () => {
    fixture.componentRef.setInput('authFields', validatedField('bad'));
    fixture.detectChanges();

    const saveSpy = vi.fn<(event: PluginSaveCredentialsEvent) => void>();
    component.save.subscribe(saveSpy);

    setInputValue(fixture, '[data-testid="cred-input-example_pat"]', 'ex_abc-123_XYZ');
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="plugin-credentials-form"]'
      ) as HTMLFormElement
    ).dispatchEvent(new Event('submit'));

    expect(saveSpy).toHaveBeenCalledWith({ credentials: { example_pat: 'ex_abc-123_XYZ' } });
  });

  it('rejects a partial match — the pattern is anchored full-match', () => {
    // Author pattern is un-anchored; component wraps it in ^(?:…)$.
    fixture.componentRef.setInput('authFields', [
      {
        key: 'example_pat',
        label: 'Token',
        field_type: 'password',
        placeholder: '',
        is_secret: true,
        required: false,
        validation: { pattern: 'ex_[a-z]+' },
      },
    ]);
    fixture.detectChanges();

    const saveSpy = vi.fn<(event: PluginSaveCredentialsEvent) => void>();
    component.save.subscribe(saveSpy);

    setInputValue(fixture, '[data-testid="cred-input-example_pat"]', 'x_ex_abc_y');
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="plugin-credentials-form"]'
      ) as HTMLFormElement
    ).dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(saveSpy).not.toHaveBeenCalled();
    expect(
      fixture.nativeElement.querySelector('[data-testid="cred-error-example_pat"]')
    ).not.toBeNull();
  });

  it('clears the validation error once the user edits the field', () => {
    fixture.componentRef.setInput('authFields', validatedField('bad'));
    fixture.detectChanges();

    setInputValue(fixture, '[data-testid="cred-input-example_pat"]', 'wrong');
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="plugin-credentials-form"]'
      ) as HTMLFormElement
    ).dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="cred-error-example_pat"]')
    ).not.toBeNull();

    // Editing the field clears the error immediately.
    setInputValue(fixture, '[data-testid="cred-input-example_pat"]', 'ex_now_valid');
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="cred-error-example_pat"]')
    ).toBeNull();
  });
});
