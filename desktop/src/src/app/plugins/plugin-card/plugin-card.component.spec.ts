import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PluginCardComponent } from './plugin-card.component';
import { PluginStatusEntry } from '../../models/plugin';

function makeMcpPlugin(): PluginStatusEntry {
  return {
    slug: 'presale',
    name: 'Presale CRM',
    service_id: 'presale',
    version: '1.2.0',
    description: 'CRM integration for presale',
    enabled: true,
    configured: true,
    auth_fields: [
      {
        key: 'api_key',
        label: 'API Key',
        field_type: 'password',
        placeholder: 'Enter key',
        is_secret: true,
      },
      {
        key: 'host_url',
        label: 'Host URL',
        field_type: 'text',
        placeholder: 'https://...',
        is_secret: false,
      },
    ],
    current_values: { host_url: 'https://crm.test' },
    token_mount: 'ro',
    settings_schema: null,
    requires_integrations: [],
  };
}

function makeResourcePlugin(): PluginStatusEntry {
  return {
    slug: 'my-commands',
    name: 'Custom Commands',
    service_id: null,
    version: '0.1.0',
    description: 'Extra Claude commands',
    enabled: false,
    configured: true,
    auth_fields: [],
    current_values: {},
    token_mount: 'ro',
    settings_schema: null,
    requires_integrations: [],
  };
}

describe('PluginCardComponent', () => {
  let component: PluginCardComponent;
  let fixture: ComponentFixture<PluginCardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PluginCardComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(PluginCardComponent);
    component = fixture.componentInstance;
    component.plugin = makeMcpPlugin();
  });

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('should render plugin name, version, and description', () => {
    fixture.detectChanges();
    const el = fixture.nativeElement;
    expect(el.querySelector('[data-testid="service-name"]').textContent).toContain('Presale CRM');
    expect(el.querySelector('[data-testid="version-badge"]').textContent).toContain('v1.2.0');
    expect(el.querySelector('[data-testid="card-description"]').textContent).toContain(
      'CRM integration'
    );
  });

  it('should show configured badge for MCP plugin when configured', () => {
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('[data-testid="badge"]');
    expect(badge.textContent.trim()).toBe('Configured');
    expect(badge.getAttribute('data-status')).toBe('configured');
  });

  it('should show not-configured badge for MCP plugin when not configured', () => {
    component.plugin = { ...makeMcpPlugin(), configured: false };
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('[data-testid="badge"]');
    expect(badge.textContent.trim()).toBe('Not Configured');
    expect(badge.getAttribute('data-status')).toBe('not-configured');
  });

  it('should not show badge for plugin without auth_fields', () => {
    component.plugin = makeResourcePlugin();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="badge"]')).toBeNull();
  });

  it('should show toggle for all plugins regardless of service_id', () => {
    component.plugin = makeResourcePlugin();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="toggle"]')).not.toBeNull();
  });

  it('should NOT disable toggle when not configured', () => {
    component.plugin = { ...makeMcpPlugin(), configured: false };
    fixture.detectChanges();
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
    expect(checkbox.disabled).toBe(false);
  });

  it('should NOT disable toggle when configured', () => {
    fixture.detectChanges();
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
    expect(checkbox.disabled).toBe(false);
  });

  it('should emit toggleExpand (not togglePlugin) when toggle clicked on unconfigured plugin', () => {
    component.plugin = { ...makeMcpPlugin(), configured: false };
    fixture.detectChanges();
    const expandSpy = vi.spyOn(component.toggleExpand, 'emit');
    const toggleSpy = vi.spyOn(component.togglePlugin, 'emit');
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
    checkbox.dispatchEvent(new Event('change'));
    expect(expandSpy).toHaveBeenCalledWith('presale');
    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it('should reset checkbox to false when toggle clicked on unconfigured plugin', () => {
    component.plugin = { ...makeMcpPlugin(), configured: false };
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

  it('should render auth field inputs with data-testid when expanded', () => {
    component.expanded = true;
    fixture.detectChanges();
    const inputs = fixture.nativeElement.querySelectorAll('[data-testid="auth-field-input"]');
    expect(inputs.length).toBe(2);
  });

  it('should emit openPlugin when Open button is clicked', () => {
    fixture.detectChanges();
    const spy = vi.spyOn(component.openPlugin, 'emit');
    const openBtn = fixture.nativeElement.querySelector('[data-testid="plugin-open-presale"]');
    expect(openBtn).not.toBeNull();
    openBtn.click();
    expect(spy).toHaveBeenCalledWith('presale');
  });

  it('should emit toggleExpand when header button is clicked', () => {
    fixture.detectChanges();
    const spy = vi.spyOn(component.toggleExpand, 'emit');
    fixture.nativeElement.querySelector('[data-testid="card-header-btn"]').click();
    expect(spy).toHaveBeenCalledWith('presale');
  });

  it('should emit togglePlugin on checkbox change', () => {
    fixture.detectChanges();
    const spy = vi.spyOn(component.togglePlugin, 'emit');
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
    checkbox.dispatchEvent(new Event('change'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].plugin).toBe(component.plugin);
  });

  describe('getFieldValue()', () => {
    it('returns current_values when no edit', () => {
      expect(component.getFieldValue('host_url')).toBe('https://crm.test');
    });

    it('returns edited value when present', () => {
      component.editedValues = { host_url: 'https://new.test' };
      expect(component.getFieldValue('host_url')).toBe('https://new.test');
    });

    it('returns empty string when no value anywhere', () => {
      component.plugin = { ...makeMcpPlugin(), current_values: {} };
      expect(component.getFieldValue('host_url')).toBe('');
    });
  });

  describe('onFieldInput()', () => {
    it('stores edited value', () => {
      const event = { target: { value: 'new-val' } } as unknown as Event;
      component.onFieldInput('api_key', event);
      expect(component.editedValues['api_key']).toBe('new-val');
    });
  });

  describe('onSave()', () => {
    it('emits saveCredentials with credentials', () => {
      component.editedValues = { api_key: 'secret-123' };
      const spy = vi.spyOn(component.saveCredentials, 'emit');
      const event = { preventDefault: vi.fn() } as unknown as Event;
      component.onSave(event);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith({
        plugin: component.plugin,
        credentials: { api_key: 'secret-123' },
      });
    });

    it('does not emit when no credentials entered', () => {
      const spy = vi.spyOn(component.saveCredentials, 'emit');
      const event = { preventDefault: vi.fn() } as unknown as Event;
      component.onSave(event);
      expect(spy).not.toHaveBeenCalled();
    });

    it('clears editedValues after emit', () => {
      component.editedValues = { api_key: 'secret-123' };
      const event = { preventDefault: vi.fn() } as unknown as Event;
      component.onSave(event);
      expect(component.editedValues).toEqual({});
    });
  });

  describe('uninstall confirmation', () => {
    it('shows confirmation prompt on first click', () => {
      component.expanded = true;
      fixture.detectChanges();
      const spy = vi.spyOn(component.removePlugin, 'emit');
      const removeBtn = fixture.nativeElement.querySelector(
        '[data-testid="plugin-remove-presale"]'
      );
      removeBtn.click();
      fixture.detectChanges();
      expect(spy).not.toHaveBeenCalled();
      expect(
        fixture.nativeElement.querySelector('[data-testid="confirm-prompt"]').textContent
      ).toContain('Are you sure?');
    });

    it('emits removePlugin on confirm', () => {
      component.expanded = true;
      component.confirmingRemove = true;
      fixture.detectChanges();
      const spy = vi.spyOn(component.removePlugin, 'emit');
      const confirmBtn = fixture.nativeElement.querySelector(
        '[data-testid="plugin-remove-confirm-presale"]'
      );
      confirmBtn.click();
      expect(spy).toHaveBeenCalledWith(component.plugin);
      expect(component.confirmingRemove).toBe(false);
    });

    it('cancels removal on cancel click', () => {
      component.expanded = true;
      component.confirmingRemove = true;
      fixture.detectChanges();
      const spy = vi.spyOn(component.removePlugin, 'emit');
      const cancelBtn = fixture.nativeElement.querySelector(
        '[data-testid="plugin-remove-cancel-presale"]'
      );
      cancelBtn.click();
      fixture.detectChanges();
      expect(spy).not.toHaveBeenCalled();
      expect(component.confirmingRemove).toBe(false);
    });
  });

  describe('setup-hint', () => {
    it('shows setup-hint for unconfigured MCP plugin when not expanded', () => {
      component.plugin = { ...makeMcpPlugin(), configured: false };
      component.expanded = false;
      fixture.detectChanges();
      const hint = fixture.nativeElement.querySelector('[data-testid="setup-hint"]');
      expect(hint).not.toBeNull();
      expect(hint.textContent).toContain('Click to set up credentials');
    });

    it('hides setup-hint for resource-only plugin (no auth_fields)', () => {
      component.plugin = makeResourcePlugin();
      component.expanded = false;
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="setup-hint"]')).toBeNull();
    });

    it('hides setup-hint when configured', () => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="setup-hint"]')).toBeNull();
    });

    it('hides setup-hint when expanded (even if unconfigured)', () => {
      component.plugin = { ...makeMcpPlugin(), configured: false };
      component.expanded = true;
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="setup-hint"]')).toBeNull();
    });

    it('emits toggleExpand with slug when setup-hint is clicked', () => {
      component.plugin = { ...makeMcpPlugin(), configured: false };
      component.expanded = false;
      fixture.detectChanges();
      const spy = vi.spyOn(component.toggleExpand, 'emit');
      const hint = fixture.nativeElement.querySelector('[data-testid="setup-hint"]');
      hint.click();
      expect(spy).toHaveBeenCalledWith('presale');
    });

    it('emits toggleExpand on Enter key', () => {
      component.plugin = { ...makeMcpPlugin(), configured: false };
      component.expanded = false;
      fixture.detectChanges();
      const spy = vi.spyOn(component.toggleExpand, 'emit');
      const hint = fixture.nativeElement.querySelector('[data-testid="setup-hint"]');
      hint.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(spy).toHaveBeenCalledWith('presale');
    });

    it('emits toggleExpand on Space key and prevents default', () => {
      component.plugin = { ...makeMcpPlugin(), configured: false };
      component.expanded = false;
      fixture.detectChanges();
      const spy = vi.spyOn(component.toggleExpand, 'emit');
      const hint = fixture.nativeElement.querySelector('[data-testid="setup-hint"]');
      const event = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
      hint.dispatchEvent(event);
      expect(spy).toHaveBeenCalledWith('presale');
      expect(event.defaultPrevented).toBe(true);
    });
  });

  it('should emit deleteCredentials when remove credentials button is clicked', () => {
    component.expanded = true;
    fixture.detectChanges();
    const spy = vi.spyOn(component.deleteCredentials, 'emit');
    const removeBtn = fixture.nativeElement.querySelector(
      '[data-testid="plugin-delete-creds-presale"]'
    );
    removeBtn.click();
    expect(spy).toHaveBeenCalledWith(component.plugin);
  });

  it('should set correct data-testid attribute', () => {
    fixture.detectChanges();
    const card = fixture.nativeElement.querySelector('[data-testid="plugin-card-presale"]');
    expect(card).not.toBeNull();
  });
});
