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
      { key: 'token', label: 'Token', field_type: 'password', placeholder: 'glpat-...' },
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
      { key: 'url', label: 'URL', field_type: 'url', placeholder: 'https://...' },
      { key: 'api_key', label: 'API Key', field_type: 'password', placeholder: '' },
    ],
    current_values: {},
    mappings: { tracker: 1 },
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
});
