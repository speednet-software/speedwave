import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PluginSettingsFormComponent } from './plugin-settings-form.component';
import { JsonSchema } from '../../models/plugin';

function makeSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      currency: {
        type: 'string',
        enum: ['PLN', 'EUR', 'USD'],
        default: 'PLN',
        description: 'Default currency for reports',
      },
      max_results: {
        type: 'integer',
        default: 50,
        description: 'Maximum results per page',
      },
      dark_mode: {
        type: 'boolean',
        default: true,
      },
      api_endpoint: {
        type: 'string',
        default: 'https://api.example.com',
        description: 'API base URL',
      },
    },
  };
}

describe('PluginSettingsFormComponent', () => {
  let component: PluginSettingsFormComponent;
  let fixture: ComponentFixture<PluginSettingsFormComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PluginSettingsFormComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(PluginSettingsFormComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('should show "no settings" message when schema is null', () => {
    fixture.componentRef.setInput('schema', null);
    fixture.detectChanges();
    const msg = fixture.nativeElement.querySelector('[data-testid="no-settings"]');
    expect(msg).not.toBeNull();
    expect(msg.textContent).toContain('No configurable settings');
  });

  it('should render text input for string property', () => {
    fixture.componentRef.setInput('schema', makeSchema());
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('[data-testid="setting-api_endpoint"]');
    expect(input).not.toBeNull();
    expect(input.tagName).toBe('INPUT');
    expect(input.type).toBe('text');
  });

  it('should render select for string with enum', () => {
    fixture.componentRef.setInput('schema', makeSchema());
    fixture.detectChanges();
    const select = fixture.nativeElement.querySelector('[data-testid="setting-currency"]');
    expect(select).not.toBeNull();
    expect(select.tagName).toBe('SELECT');
    const options = select.querySelectorAll('option');
    expect(options).toHaveLength(3);
    expect(options[0].value).toBe('PLN');
    expect(options[1].value).toBe('EUR');
    expect(options[2].value).toBe('USD');
  });

  it('should render checkbox for boolean property', () => {
    fixture.componentRef.setInput('schema', makeSchema());
    fixture.detectChanges();
    const checkbox = fixture.nativeElement.querySelector('[data-testid="setting-dark_mode"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox.type).toBe('checkbox');
  });

  it('should render number input for integer property', () => {
    fixture.componentRef.setInput('schema', makeSchema());
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('[data-testid="setting-max_results"]');
    expect(input).not.toBeNull();
    expect(input.type).toBe('number');
  });

  it('should use schema defaults when no saved values', () => {
    fixture.componentRef.setInput('schema', makeSchema());
    fixture.componentRef.setInput('values', {});
    fixture.detectChanges();
    expect(component.getValue('currency')).toBe('PLN');
    expect(component.getValue('max_results')).toBe(50);
    expect(component.getValue('dark_mode')).toBe(true);
  });

  it('should prefer saved values over defaults', () => {
    fixture.componentRef.setInput('schema', makeSchema());
    fixture.componentRef.setInput('values', { currency: 'EUR', max_results: 100 });
    fixture.detectChanges();
    expect(component.getValue('currency')).toBe('EUR');
    expect(component.getValue('max_results')).toBe(100);
  });

  it('should prefer edited values over saved values', () => {
    fixture.componentRef.setInput('schema', makeSchema());
    fixture.componentRef.setInput('values', { currency: 'EUR' });
    component.editedValues = { currency: 'USD' };
    expect(component.getValue('currency')).toBe('USD');
  });

  it('should display field descriptions as hints', () => {
    fixture.componentRef.setInput('schema', makeSchema());
    fixture.detectChanges();
    const hints = fixture.nativeElement.querySelectorAll('[data-testid="field-hint"]');
    expect(hints.length).toBeGreaterThan(0);
    const hintTexts = Array.from(hints).map((h: unknown) => (h as HTMLElement).textContent);
    expect(hintTexts).toContain('Default currency for reports');
  });

  it('should emit save with all values on submit', () => {
    fixture.componentRef.setInput('schema', makeSchema());
    fixture.componentRef.setInput('values', { currency: 'EUR' });
    component.editedValues = { max_results: 75 };
    fixture.detectChanges();

    const spy = vi.spyOn(component.save, 'emit');
    const form = fixture.nativeElement.querySelector('form');
    form.dispatchEvent(new Event('submit'));

    expect(spy).toHaveBeenCalledTimes(1);
    const emitted = spy.mock.calls[0]?.[0];
    expect(emitted).toBeDefined();
    if (!emitted) throw new Error('expected save to emit');
    expect(emitted['currency']).toBe('EUR');
    expect(emitted['max_results']).toBe(75);
    expect(emitted['dark_mode']).toBe(true);
    expect(emitted['api_endpoint']).toBe('https://api.example.com');
  });

  it('should handle null schema gracefully', () => {
    fixture.componentRef.setInput('schema', null);
    fixture.detectChanges();
    expect(component.propertyKeys()).toEqual([]);
    expect(fixture.nativeElement.querySelector('form')).toBeNull();
  });

  it('should update edited values on text input', () => {
    fixture.componentRef.setInput('schema', makeSchema());
    const event = { target: { value: 'https://new.api.com' } } as unknown as Event;
    component.onFieldChange('api_endpoint', event);
    expect(component.editedValues['api_endpoint']).toBe('https://new.api.com');
  });

  it('should convert number input to numeric value', () => {
    fixture.componentRef.setInput('schema', makeSchema());
    const event = { target: { value: '25' } } as unknown as Event;
    component.onFieldChange('max_results', event);
    expect(component.editedValues['max_results']).toBe(25);
  });

  it('should handle checkbox change', () => {
    fixture.componentRef.setInput('schema', makeSchema());
    const event = { target: { checked: false } } as unknown as Event;
    component.onCheckboxChange('dark_mode', event);
    expect(component.editedValues['dark_mode']).toBe(false);
  });
});
