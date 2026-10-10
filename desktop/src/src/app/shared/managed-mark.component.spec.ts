import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { ManagedMarkComponent } from './managed-mark.component';

describe('ManagedMarkComponent', () => {
  function render(lamp: 'allowed' | 'not-allowed' | null, provider: string | null) {
    const fixture = TestBed.createComponent(ManagedMarkComponent);
    fixture.componentRef.setInput('lamp', lamp);
    fixture.componentRef.setInput('provider', provider);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows an allowed lamp named for the provider', () => {
    const el = render('allowed', 'Auditor');
    expect(el.querySelector('[data-testid="managed-lamp"]')?.getAttribute('data-lamp')).toBe(
      'allowed'
    );
    expect(el.getAttribute('aria-label')).toBe('Managed by Auditor · allowed');
  });

  it('shows a not-allowed lamp', () => {
    const el = render('not-allowed', null);
    expect(el.querySelector('[data-testid="managed-lamp"]')?.getAttribute('data-lamp')).toBe(
      'not-allowed'
    );
    expect(el.getAttribute('title')).toBe('Managed by your organisation · not allowed');
  });

  it('is the bare mark without a lamp', () => {
    const el = render(null, null);
    expect(el.querySelector('[data-testid="managed-lamp"]')).toBeNull();
    expect(el.getAttribute('aria-label')).toBe('Managed by your organisation');
  });
});
