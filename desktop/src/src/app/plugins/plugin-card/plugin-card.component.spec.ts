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
    configured: false,
    auth_fields: [],
    current_values: {},
    token_mount: 'ro',
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
    expect(el.querySelector('.service-name').textContent).toContain('Presale CRM');
    expect(el.querySelector('.version-badge').textContent).toContain('v1.2.0');
    expect(el.querySelector('.card-description').textContent).toContain('CRM integration');
  });

  it('should show configured badge for MCP plugin when configured', () => {
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('.badge');
    expect(badge.textContent.trim()).toBe('Configured');
    expect(badge.classList.contains('configured')).toBe(true);
  });

  it('should show not-configured badge for MCP plugin when not configured', () => {
    component.plugin = { ...makeMcpPlugin(), configured: false };
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('.badge');
    expect(badge.textContent.trim()).toBe('Not Configured');
    expect(badge.classList.contains('not-configured')).toBe(true);
  });

  it('should not show badge or toggle for resource-only plugin', () => {
    component.plugin = makeResourcePlugin();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.badge')).toBeNull();
    expect(fixture.nativeElement.querySelector('.toggle')).toBeNull();
  });

  it('should disable toggle when not configured', () => {
    component.plugin = { ...makeMcpPlugin(), configured: false };
    fixture.detectChanges();
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
    expect(checkbox.disabled).toBe(true);
  });

  it('should enable toggle when configured', () => {
    fixture.detectChanges();
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
    expect(checkbox.disabled).toBe(false);
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

  it('should emit removePlugin when uninstall button is clicked', () => {
    component.expanded = true;
    fixture.detectChanges();
    const spy = vi.spyOn(component.removePlugin, 'emit');
    const removeBtn = fixture.nativeElement.querySelector('.btn-remove');
    removeBtn.click();
    expect(spy).toHaveBeenCalledWith(component.plugin);
  });

  it('should emit deleteCredentials when remove credentials button is clicked', () => {
    component.expanded = true;
    fixture.detectChanges();
    const spy = vi.spyOn(component.deleteCredentials, 'emit');
    const removeBtn = fixture.nativeElement.querySelector('.btn-cancel');
    removeBtn.click();
    expect(spy).toHaveBeenCalledWith(component.plugin);
  });

  it('should set correct data-testid attribute', () => {
    fixture.detectChanges();
    const card = fixture.nativeElement.querySelector('[data-testid="plugin-card-presale"]');
    expect(card).not.toBeNull();
  });
});
