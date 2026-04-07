import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ServiceCardComponent } from './service-card.component';
import { IntegrationStatusEntry } from '../../models/integration';

function makeGitlabSvc(): IntegrationStatusEntry {
  return {
    service: 'gitlab',
    enabled: true,
    configured: true,
    display_name: 'GitLab',
    description: 'Code hosting',
    auth_fields: [
      {
        key: 'token',
        label: 'Personal Access Token',
        field_type: 'password',
        placeholder: 'glpat-...',
        oauth_flow: false,
        optional: false,
      },
      {
        key: 'host_url',
        label: 'GitLab URL',
        field_type: 'url',
        placeholder: 'https://gitlab.com',
        oauth_flow: false,
        optional: false,
      },
    ],
    current_values: { token: 'existing-token', host_url: 'https://gitlab.com' },
    mappings: undefined,
  };
}

function makeRedmineSvc(): IntegrationStatusEntry {
  return {
    service: 'redmine',
    enabled: false,
    configured: false,
    display_name: 'Redmine',
    description: 'Project management',
    auth_fields: [
      {
        key: 'api_key',
        label: 'API Key',
        field_type: 'password',
        placeholder: 'abcdef1234567890...',
        oauth_flow: false,
        optional: false,
      },
      {
        key: 'host_url',
        label: 'Redmine URL',
        field_type: 'url',
        placeholder: 'https://redmine.company.com',
        oauth_flow: false,
        optional: false,
      },
      {
        key: 'project_id',
        label: 'Project ID',
        field_type: 'text',
        placeholder: 'my-project',
        oauth_flow: false,
        optional: true,
      },
    ],
    current_values: {},
    mappings: undefined,
  };
}

function makeSharepointSvc(): IntegrationStatusEntry {
  return {
    service: 'sharepoint',
    enabled: false,
    configured: false,
    display_name: 'SharePoint',
    description: 'Microsoft 365 document management',
    auth_fields: [
      {
        key: 'access_token',
        label: 'Access Token',
        field_type: 'password',
        placeholder: 'eyJ0...',
        oauth_flow: true,
        optional: false,
      },
      {
        key: 'refresh_token',
        label: 'Refresh Token',
        field_type: 'password',
        placeholder: '0.AR...',
        oauth_flow: true,
        optional: false,
      },
      {
        key: 'client_id',
        label: 'Client ID',
        field_type: 'text',
        placeholder: '00000000-0000-...',
        oauth_flow: false,
        optional: false,
      },
      {
        key: 'tenant_id',
        label: 'Tenant ID',
        field_type: 'text',
        placeholder: '00000000-0000-...',
        oauth_flow: false,
        optional: false,
      },
      {
        key: 'site_id',
        label: 'Site ID',
        field_type: 'text',
        placeholder: 'site-id',
        oauth_flow: false,
        optional: false,
      },
      {
        key: 'base_path',
        label: 'Base Path',
        field_type: 'text',
        placeholder: 'Projects/my-project',
        oauth_flow: false,
        optional: false,
      },
    ],
    current_values: {},
    mappings: undefined,
  };
}

describe('ServiceCardComponent', () => {
  let component: ServiceCardComponent;
  let fixture: ComponentFixture<ServiceCardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ServiceCardComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ServiceCardComponent);
    component = fixture.componentInstance;
    component.svc = makeGitlabSvc();
  });

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('should render service name and description', () => {
    fixture.detectChanges();
    const el = fixture.nativeElement;
    expect(el.querySelector('[data-testid="service-name"]').textContent).toContain('GitLab');
    expect(el.querySelector('[data-testid="card-description"]').textContent).toContain(
      'Code hosting'
    );
  });

  it('should show configured badge when configured', () => {
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('[data-testid="badge"]');
    expect(badge.textContent.trim()).toBe('Configured');
    expect(badge.getAttribute('data-status')).toBe('configured');
  });

  it('should show not-configured badge when not configured', () => {
    component.svc = makeRedmineSvc();
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('[data-testid="badge"]');
    expect(badge.textContent.trim()).toBe('Not Configured');
    expect(badge.getAttribute('data-status')).toBe('not-configured');
  });

  it('should NOT disable toggle when service is not configured', () => {
    component.svc = makeRedmineSvc();
    fixture.detectChanges();
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
    const toggle = fixture.nativeElement.querySelector('[data-testid="toggle"]');
    expect(checkbox.disabled).toBe(false);
    expect(toggle.getAttribute('data-disabled')).toBeNull();
  });

  it('should NOT disable toggle when service is configured', () => {
    fixture.detectChanges();
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
    const toggle = fixture.nativeElement.querySelector('[data-testid="toggle"]');
    expect(checkbox.disabled).toBe(false);
    expect(toggle.getAttribute('data-disabled')).toBeNull();
  });

  it('should emit toggleExpand (not toggleService) when toggle clicked on unconfigured service', () => {
    component.svc = makeRedmineSvc();
    fixture.detectChanges();
    const expandSpy = vi.spyOn(component.toggleExpand, 'emit');
    const toggleSpy = vi.spyOn(component.toggleService, 'emit');
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
    checkbox.dispatchEvent(new Event('change'));
    expect(expandSpy).toHaveBeenCalledWith('redmine');
    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it('should reset checkbox to false when toggle clicked on unconfigured service', () => {
    component.svc = makeRedmineSvc();
    fixture.detectChanges();
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(checkbox.checked).toBe(false);
  });

  it('should not show card-body when not expanded', () => {
    component.expanded = false;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="card-body"]')).toBeNull();
  });

  it('should show card-body when expanded', () => {
    component.expanded = true;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="card-body"]')).not.toBeNull();
  });

  it('should emit toggleExpand when header button is clicked', () => {
    fixture.detectChanges();
    const spy = vi.spyOn(component.toggleExpand, 'emit');
    fixture.nativeElement.querySelector('[data-testid="card-header-btn"]').click();
    expect(spy).toHaveBeenCalledWith('gitlab');
  });

  it('should emit toggleService on checkbox change', () => {
    fixture.detectChanges();
    const spy = vi.spyOn(component.toggleService, 'emit');
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
    checkbox.dispatchEvent(new Event('change'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].svc).toBe(component.svc);
  });

  describe('getFieldValue()', () => {
    it('returns current_values when no edit', () => {
      expect(component.getFieldValue('token')).toBe('existing-token');
    });

    it('returns edited value when present', () => {
      component.editedValues = { token: 'edited-token' };
      expect(component.getFieldValue('token')).toBe('edited-token');
    });

    it('returns empty string when no value anywhere', () => {
      component.svc = { ...makeGitlabSvc(), current_values: {} };
      expect(component.getFieldValue('token')).toBe('');
    });
  });

  describe('onFieldInput()', () => {
    it('stores edited value', () => {
      const event = { target: { value: 'new-val' } } as unknown as Event;
      component.onFieldInput('token', event);
      expect(component.editedValues['token']).toBe('new-val');
    });
  });

  describe('onSave()', () => {
    it('emits saveCredentials with credentials', () => {
      component.editedValues = { token: 'glpat-new' };
      const spy = vi.spyOn(component.saveCredentials, 'emit');
      const event = { preventDefault: vi.fn() } as unknown as Event;
      component.onSave(event);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith({
        svc: component.svc,
        credentials: { token: 'glpat-new' },
        mappings: null,
      });
    });

    it('does not emit when no credentials entered', () => {
      const spy = vi.spyOn(component.saveCredentials, 'emit');
      const event = { preventDefault: vi.fn() } as unknown as Event;
      component.onSave(event);
      expect(spy).not.toHaveBeenCalled();
    });

    it('clears editedValues after emit', () => {
      component.editedValues = { token: 'glpat-new' };
      const event = { preventDefault: vi.fn() } as unknown as Event;
      component.onSave(event);
      expect(component.editedValues).toEqual({});
    });
  });

  it('should emit deleteCredentials when remove button is clicked', () => {
    component.expanded = true;
    fixture.detectChanges();
    const spy = vi.spyOn(component.deleteCredentials, 'emit');
    const removeBtn = fixture.nativeElement.querySelector(
      '[data-testid="integrations-remove-gitlab"]'
    );
    removeBtn.click();
    expect(spy).toHaveBeenCalledWith(component.svc);
  });

  it('should set correct data-testid attribute', () => {
    fixture.detectChanges();
    const card = fixture.nativeElement.querySelector('[data-testid="integrations-service-gitlab"]');
    expect(card).not.toBeNull();
  });

  // -- OAuth-related tests --

  describe('OAuth fields', () => {
    it('does not render inputs for oauth_flow fields', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      fixture.detectChanges();
      const el = fixture.nativeElement;
      expect(el.querySelector('#sharepoint-access_token')).toBeNull();
      expect(el.querySelector('#sharepoint-refresh_token')).toBeNull();
    });

    it('renders non-oauth fields for sharepoint', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      fixture.detectChanges();
      const el = fixture.nativeElement;
      expect(el.querySelector('#sharepoint-client_id')).not.toBeNull();
      expect(el.querySelector('#sharepoint-tenant_id')).not.toBeNull();
      expect(el.querySelector('#sharepoint-site_id')).not.toBeNull();
      expect(el.querySelector('#sharepoint-base_path')).not.toBeNull();
    });

    it('marks all visible SharePoint inputs as required', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      fixture.detectChanges();
      const inputs = fixture.nativeElement.querySelectorAll('[data-testid="auth-field-input"]');
      expect(inputs.length).toBe(4); // client_id, tenant_id, site_id, base_path
      for (const input of inputs) {
        expect(input.required).toBe(true);
      }
    });

    it('shows oauth section for sharepoint when expanded', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="oauth-section"]')).not.toBeNull();
    });

    it('does not show oauth section for non-oauth services', () => {
      component.svc = makeGitlabSvc();
      component.expanded = true;
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="oauth-section"]')).toBeNull();
    });

    it('does not show oauth section for redmine', () => {
      component.svc = makeRedmineSvc();
      component.expanded = true;
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="oauth-section"]')).toBeNull();
    });
  });

  describe('onStartOAuth()', () => {
    it('emits startOAuth with fresh form values (non-oauth only)', () => {
      component.svc = makeSharepointSvc();
      component.editedValues = {
        client_id: 'my-client',
        tenant_id: 'my-tenant',
        site_id: 'my-site',
      };
      const spy = vi.spyOn(component.startOAuth, 'emit');
      component.onStartOAuth();
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0][0];
      expect(payload.credentials).toEqual({
        client_id: 'my-client',
        tenant_id: 'my-tenant',
        site_id: 'my-site',
      });
      // Should NOT include oauth_flow fields
      expect(payload.credentials['access_token']).toBeUndefined();
      expect(payload.credentials['refresh_token']).toBeUndefined();
    });

    it('emits startOAuth with current_values merged', () => {
      component.svc = {
        ...makeSharepointSvc(),
        current_values: { client_id: 'saved-client', tenant_id: 'saved-tenant' },
      };
      component.editedValues = { site_id: 'new-site' };
      const spy = vi.spyOn(component.startOAuth, 'emit');
      component.onStartOAuth();
      const payload = spy.mock.calls[0][0];
      expect(payload.credentials['client_id']).toBe('saved-client');
      expect(payload.credentials['tenant_id']).toBe('saved-tenant');
      expect(payload.credentials['site_id']).toBe('new-site');
    });
  });

  describe('cancelOAuth', () => {
    it('emits cancelOAuth on cancel click', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      component.oauthStatus = 'starting';
      fixture.detectChanges();
      const spy = vi.spyOn(component.cancelOAuth, 'emit');
      const cancelBtn = fixture.nativeElement.querySelector('[data-testid="btn-cancel-oauth"]');
      cancelBtn.click();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('openVerificationUrl', () => {
    it('emits on open link click', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      component.deviceCodeInfo = {
        user_code: 'ABCD1234',
        verification_uri: 'https://microsoft.com/devicelogin',
        expires_in: 900,
        request_id: 'test-rid',
      };
      component.oauthStatus = 'polling';
      fixture.detectChanges();
      const spy = vi.spyOn(component.openVerificationUrl, 'emit');
      const link = fixture.nativeElement.querySelector('[data-testid="btn-link"]');
      link.click();
      expect(spy).toHaveBeenCalledWith('https://microsoft.com/devicelogin');
    });
  });

  describe('verification URL display', () => {
    it('shows copyable verification URL next to open button', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      component.deviceCodeInfo = {
        user_code: 'CODE123',
        verification_uri: 'https://microsoft.com/devicelogin',
        expires_in: 900,
        request_id: 'rid',
      };
      component.oauthStatus = 'polling';
      fixture.detectChanges();
      const urlEl = fixture.nativeElement.querySelector('[data-testid="verification-url"]');
      expect(urlEl).not.toBeNull();
      expect(urlEl.textContent).toContain('https://microsoft.com/devicelogin');
    });
  });

  describe('device code display', () => {
    it('displays user code when deviceCodeInfo is provided', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      component.deviceCodeInfo = {
        user_code: 'XYZW9876',
        verification_uri: 'https://microsoft.com/devicelogin',
        expires_in: 900,
        request_id: 'test-rid',
      };
      component.oauthStatus = 'polling';
      fixture.detectChanges();
      const codeEl = fixture.nativeElement.querySelector('[data-testid="user-code"]');
      expect(codeEl).not.toBeNull();
      expect(codeEl.textContent).toContain('XYZW9876');
    });

    it('shows polling status when polling', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      component.deviceCodeInfo = {
        user_code: 'CODE',
        verification_uri: 'https://example.com',
        expires_in: 900,
        request_id: 'rid',
      };
      component.oauthStatus = 'polling';
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="polling-status"]')).not.toBeNull();
    });
  });

  describe('optional fields', () => {
    it('appends (optional) to label for optional fields', () => {
      component.svc = makeRedmineSvc();
      component.expanded = true;
      fixture.detectChanges();
      const el = fixture.nativeElement;
      // Query labels by their `for` attribute — immune to field reordering
      expect(el.querySelector('label[for="redmine-api_key"]').textContent).not.toContain(
        '(optional)'
      );
      expect(el.querySelector('label[for="redmine-host_url"]').textContent).not.toContain(
        '(optional)'
      );
      expect(el.querySelector('label[for="redmine-project_id"]').textContent).toContain(
        '(optional)'
      );
    });

    it('does not mark optional fields as required', () => {
      component.svc = makeRedmineSvc();
      component.expanded = true;
      fixture.detectChanges();
      const el = fixture.nativeElement;
      // Query inputs by their ID — immune to field reordering
      expect(el.querySelector('#redmine-api_key').required).toBe(true);
      expect(el.querySelector('#redmine-host_url').required).toBe(true);
      expect(el.querySelector('#redmine-project_id').required).toBe(false);
    });

    it('onSave sends empty string for cleared optional fields', () => {
      component.svc = makeRedmineSvc();
      component.editedValues = { project_id: '' };
      const spy = vi.spyOn(component.saveCredentials, 'emit');
      component.onSave(new Event('submit'));
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0][0];
      expect(payload.credentials['project_id']).toBe('');
    });

    it('onSave does not send empty string for cleared required fields', () => {
      component.svc = makeRedmineSvc();
      component.editedValues = { api_key: '', host_url: 'https://example.com' };
      const spy = vi.spyOn(component.saveCredentials, 'emit');
      component.onSave(new Event('submit'));
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0][0];
      expect(payload.credentials['api_key']).toBeUndefined();
      expect(payload.credentials['host_url']).toBe('https://example.com');
    });
  });

  describe('setup-hint', () => {
    it('shows setup-hint when not configured and not expanded', () => {
      component.svc = makeRedmineSvc();
      component.expanded = false;
      fixture.detectChanges();
      const hint = fixture.nativeElement.querySelector('[data-testid="setup-hint"]');
      expect(hint).not.toBeNull();
      expect(hint.textContent).toContain('Click to set up credentials');
    });

    it('hides setup-hint when configured', () => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="setup-hint"]')).toBeNull();
    });

    it('hides setup-hint when expanded (even if not configured)', () => {
      component.svc = makeRedmineSvc();
      component.expanded = true;
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="setup-hint"]')).toBeNull();
    });

    it('emits toggleExpand with service name when setup-hint is clicked', () => {
      component.svc = makeRedmineSvc();
      component.expanded = false;
      fixture.detectChanges();
      const spy = vi.spyOn(component.toggleExpand, 'emit');
      const hint = fixture.nativeElement.querySelector('[data-testid="setup-hint"]');
      hint.click();
      expect(spy).toHaveBeenCalledWith('redmine');
    });

    it('emits toggleExpand on Enter key', () => {
      component.svc = makeRedmineSvc();
      component.expanded = false;
      fixture.detectChanges();
      const spy = vi.spyOn(component.toggleExpand, 'emit');
      const hint = fixture.nativeElement.querySelector('[data-testid="setup-hint"]');
      hint.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(spy).toHaveBeenCalledWith('redmine');
    });

    it('emits toggleExpand on Space key and prevents default', () => {
      component.svc = makeRedmineSvc();
      component.expanded = false;
      fixture.detectChanges();
      const spy = vi.spyOn(component.toggleExpand, 'emit');
      const hint = fixture.nativeElement.querySelector('[data-testid="setup-hint"]');
      const event = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
      hint.dispatchEvent(event);
      expect(spy).toHaveBeenCalledWith('redmine');
      expect(event.defaultPrevented).toBe(true);
    });
  });

  describe('success/error messages', () => {
    it('shows success message', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      component.oauthStatus = 'success';
      fixture.detectChanges();
      const el = fixture.nativeElement.querySelector('[data-testid="oauth-success"]');
      expect(el).not.toBeNull();
      expect(el.textContent).toContain('Authentication successful');
    });

    it('shows error message', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      component.oauthStatus = 'error';
      component.oauthStatusMessage = 'Something went wrong';
      fixture.detectChanges();
      const el = fixture.nativeElement.querySelector('[data-testid="oauth-error"]');
      expect(el).not.toBeNull();
      expect(el.textContent).toContain('Something went wrong');
    });

    it('shows expired message', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      component.oauthStatus = 'expired';
      component.oauthStatusMessage = 'Code expired';
      fixture.detectChanges();
      const el = fixture.nativeElement.querySelector('[data-testid="oauth-error"]');
      expect(el).not.toBeNull();
      expect(el.textContent).toContain('Code expired');
    });
  });
});
