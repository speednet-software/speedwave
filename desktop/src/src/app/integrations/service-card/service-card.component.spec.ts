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
        label: 'Token',
        field_type: 'password',
        placeholder: 'glpat-...',
        oauth_flow: false,
      },
    ],
    current_values: { token: 'existing-token' },
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
        key: 'url',
        label: 'URL',
        field_type: 'url',
        placeholder: 'https://...',
        oauth_flow: false,
      },
      {
        key: 'api_key',
        label: 'API Key',
        field_type: 'password',
        placeholder: '',
        oauth_flow: false,
      },
    ],
    current_values: {},
    mappings: { tracker: 1 },
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
      },
      {
        key: 'refresh_token',
        label: 'Refresh Token',
        field_type: 'password',
        placeholder: '0.AR...',
        oauth_flow: true,
      },
      {
        key: 'client_id',
        label: 'Client ID',
        field_type: 'text',
        placeholder: '00000000-0000-...',
        oauth_flow: false,
      },
      {
        key: 'tenant_id',
        label: 'Tenant ID',
        field_type: 'text',
        placeholder: '00000000-0000-...',
        oauth_flow: false,
      },
      {
        key: 'site_id',
        label: 'Site ID',
        field_type: 'text',
        placeholder: 'site-id',
        oauth_flow: false,
      },
      {
        key: 'base_path',
        label: 'Base Path',
        field_type: 'text',
        placeholder: 'Projects/my-project',
        oauth_flow: false,
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
    expect(el.querySelector('.service-name').textContent).toContain('GitLab');
    expect(el.querySelector('.card-description').textContent).toContain('Code hosting');
  });

  it('should show configured badge when configured', () => {
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('.badge');
    expect(badge.textContent.trim()).toBe('Configured');
    expect(badge.classList.contains('configured')).toBe(true);
  });

  it('should show not-configured badge when not configured', () => {
    component.svc = makeRedmineSvc();
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('.badge');
    expect(badge.textContent.trim()).toBe('Not Configured');
    expect(badge.classList.contains('not-configured')).toBe(true);
  });

  it('should disable toggle when service is not configured', () => {
    component.svc = makeRedmineSvc();
    fixture.detectChanges();
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
    const toggle = fixture.nativeElement.querySelector('.toggle');
    expect(checkbox.disabled).toBe(true);
    expect(toggle.classList.contains('disabled')).toBe(true);
  });

  it('should enable toggle when service is configured', () => {
    fixture.detectChanges();
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
    const toggle = fixture.nativeElement.querySelector('.toggle');
    expect(checkbox.disabled).toBe(false);
    expect(toggle.classList.contains('disabled')).toBe(false);
  });

  it('should not show card-body when not expanded', () => {
    component.expanded = false;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.card-body')).toBeNull();
  });

  it('should show card-body when expanded', () => {
    component.expanded = true;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.card-body')).not.toBeNull();
  });

  it('should emit toggleExpand when header button is clicked', () => {
    fixture.detectChanges();
    const spy = vi.spyOn(component.toggleExpand, 'emit');
    fixture.nativeElement.querySelector('.card-header-btn').click();
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

    it('includes redmine mappings when service is redmine', () => {
      component.svc = makeRedmineSvc();
      component.editedValues = { url: 'https://redmine.test' };
      component.editedMappings = { tracker: 2, status: 5 };
      const spy = vi.spyOn(component.saveCredentials, 'emit');
      const event = { preventDefault: vi.fn() } as unknown as Event;
      component.onSave(event);
      expect(spy).toHaveBeenCalledWith({
        svc: component.svc,
        credentials: { url: 'https://redmine.test' },
        mappings: { tracker: 2, status: 5 },
      });
    });
  });

  it('should emit deleteCredentials when remove button is clicked', () => {
    component.expanded = true;
    fixture.detectChanges();
    const spy = vi.spyOn(component.deleteCredentials, 'emit');
    const removeBtn = fixture.nativeElement.querySelector('.btn-cancel');
    removeBtn.click();
    expect(spy).toHaveBeenCalledWith(component.svc);
  });

  describe('mapping helpers', () => {
    beforeEach(() => {
      component.svc = makeRedmineSvc();
    });

    it('getMappingEntries returns entries from service mappings', () => {
      const entries = component.getMappingEntries();
      expect(entries).toEqual([{ key: 'tracker', value: 1 }]);
    });

    it('getMappingEntries returns edited mappings when present', () => {
      component.editedMappings = { status: 3 };
      const entries = component.getMappingEntries();
      expect(entries).toEqual([{ key: 'status', value: 3 }]);
    });

    it('onAddMapping creates a new entry', () => {
      component.onAddMapping();
      expect(component.editedMappings).not.toBeNull();
      const keys = Object.keys(component.editedMappings!);
      expect(keys.length).toBeGreaterThan(1);
    });

    it('onRemoveMapping deletes an entry', () => {
      component.editedMappings = { tracker: 1, status: 2 };
      component.onRemoveMapping('tracker');
      expect(component.editedMappings!['tracker']).toBeUndefined();
      expect(component.editedMappings!['status']).toBe(2);
    });

    it('onUpdateMappingKey renames a key', () => {
      component.editedMappings = { tracker: 1 };
      const event = { target: { value: 'category' } } as unknown as Event;
      component.onUpdateMappingKey('tracker', event);
      expect(component.editedMappings!['tracker']).toBeUndefined();
      expect(component.editedMappings!['category']).toBe(1);
    });

    it('onUpdateMappingValue updates the value', () => {
      component.editedMappings = { tracker: 1 };
      const event = { target: { value: '99' } } as unknown as Event;
      component.onUpdateMappingValue('tracker', event);
      expect(component.editedMappings!['tracker']).toBe(99);
    });
  });

  describe('redmine-specific template', () => {
    it('shows mappings section for redmine when expanded', () => {
      component.svc = makeRedmineSvc();
      component.expanded = true;
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.mappings-section')).not.toBeNull();
    });

    it('does not show mappings section for non-redmine services', () => {
      component.expanded = true;
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.mappings-section')).toBeNull();
    });
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

    it('marks all visible inputs as required', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      fixture.detectChanges();
      const inputs = fixture.nativeElement.querySelectorAll('.form-input');
      expect(inputs.length).toBe(4); // client_id, tenant_id, site_id, base_path
      for (const input of inputs) {
        expect(input.required).toBe(true);
      }
    });

    it('shows oauth section for sharepoint when expanded', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.oauth-section')).not.toBeNull();
    });

    it('does not show oauth section for non-oauth services', () => {
      component.svc = makeGitlabSvc();
      component.expanded = true;
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.oauth-section')).toBeNull();
    });

    it('does not show oauth section for redmine', () => {
      component.svc = makeRedmineSvc();
      component.expanded = true;
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.oauth-section')).toBeNull();
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
      const cancelBtn = fixture.nativeElement.querySelector('.btn-cancel-oauth');
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
      const link = fixture.nativeElement.querySelector('.btn-link');
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
      const urlEl = fixture.nativeElement.querySelector('.verification-url');
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
      const codeEl = fixture.nativeElement.querySelector('.user-code');
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
      expect(fixture.nativeElement.querySelector('.polling-status')).not.toBeNull();
    });
  });

  describe('success/error messages', () => {
    it('shows success message', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      component.oauthStatus = 'success';
      fixture.detectChanges();
      const el = fixture.nativeElement.querySelector('.oauth-success');
      expect(el).not.toBeNull();
      expect(el.textContent).toContain('Authentication successful');
    });

    it('shows error message', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      component.oauthStatus = 'error';
      component.oauthStatusMessage = 'Something went wrong';
      fixture.detectChanges();
      const el = fixture.nativeElement.querySelector('.oauth-error');
      expect(el).not.toBeNull();
      expect(el.textContent).toContain('Something went wrong');
    });

    it('shows expired message', () => {
      component.svc = makeSharepointSvc();
      component.expanded = true;
      component.oauthStatus = 'expired';
      component.oauthStatusMessage = 'Code expired';
      fixture.detectChanges();
      const el = fixture.nativeElement.querySelector('.oauth-error');
      expect(el).not.toBeNull();
      expect(el.textContent).toContain('Code expired');
    });
  });
});
