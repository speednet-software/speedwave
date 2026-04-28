import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ErrorBlockComponent } from './error-block.component';
import type { ErrorBlockKind } from '../../models/chat';

describe('ErrorBlockComponent', () => {
  let component: ErrorBlockComponent;
  let fixture: ComponentFixture<ErrorBlockComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ErrorBlockComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ErrorBlockComponent);
    component = fixture.componentInstance;
  });

  function setInputs(content: string, kind: ErrorBlockKind = 'generic'): void {
    fixture.componentRef.setInput('content', content);
    fixture.componentRef.setInput('kind', kind);
    fixture.detectChanges();
  }

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('happy: renders content and default generic shape', () => {
    setInputs('Something went wrong');
    expect(el().textContent).toContain('Something went wrong');
    const wrapper = el().querySelector('[data-testid="error-block"]');
    expect(wrapper?.getAttribute('data-kind')).toBe('generic');
    // Every variant is a left-border timeline; red variant uses red-500/50.
    expect(wrapper?.classList.contains('border-l-2')).toBe(true);
    expect(wrapper?.className).toContain('border-red-500/50');
  });

  const redKinds: ErrorBlockKind[] = [
    'rate_limit',
    'network',
    'session_exited',
    'broken_pipe',
    'generic',
  ];
  for (const kind of redKinds) {
    it(`happy: ${kind} renders a red timeline border (no amber, no gray)`, () => {
      setInputs('oops', kind);
      const wrapper = el().querySelector('[data-testid="error-block"]');
      expect(wrapper?.classList.contains('border-l-2')).toBe(true);
      expect(wrapper?.className).toContain('border-red-500/50');
      expect(wrapper?.className).not.toContain('border-[var(--amber)]/50');
      expect(wrapper?.className).not.toContain('border-[var(--ink-mute)]/50');
      // Red variants without an action label render no action button.
      const hasAction = kind === 'session_exited' || kind === 'broken_pipe';
      if (hasAction) {
        expect(el().querySelector('[data-testid="error-action"]')).toBeTruthy();
      } else {
        expect(el().querySelector('[data-testid="error-action"]')).toBeNull();
      }
    });
  }

  const amberKinds: ErrorBlockKind[] = ['no_active_project', 'session_starting', 'auth_required'];
  for (const kind of amberKinds) {
    it(`happy: ${kind} renders an amber timeline with an action button`, () => {
      setInputs('please do X', kind);
      const wrapper = el().querySelector('[data-testid="error-block"]');
      expect(wrapper?.classList.contains('border-l-2')).toBe(true);
      expect(wrapper?.className).toContain('border-[var(--amber)]/50');
      expect(wrapper?.className).not.toContain('border-red-500/50');
      expect(el().querySelector('[data-testid="error-action"]')).toBeTruthy();
    });
  }

  it('happy: stopped_by_user renders a muted gray timeline', () => {
    setInputs('turn cancelled', 'stopped_by_user');
    const wrapper = el().querySelector('[data-testid="error-block"]');
    expect(wrapper?.className).toContain('border-[var(--ink-mute)]/50');
    expect(wrapper?.className).not.toContain('border-red-500/50');
  });

  it('label: each kind produces an expected label', () => {
    const map: Record<ErrorBlockKind, string> = {
      rate_limit: '⚠ rate_limit',
      network: '⚠ network_error',
      session_exited: '⚠ session_exited',
      broken_pipe: '⚠ broken_pipe',
      no_active_project: 'no active project',
      session_starting: 'session starting',
      auth_required: 'auth required',
      stopped_by_user: '■ stopped by user',
      generic: '⚠ error',
    };
    for (const [kind, expected] of Object.entries(map) as Array<[ErrorBlockKind, string]>) {
      setInputs('x', kind);
      const label = el().querySelector('[data-testid="error-label"]');
      expect(label?.textContent?.trim()).toBe(expected);
    }
  });

  it('edge: empty content still renders without crash', () => {
    setInputs('');
    expect(el().querySelector('[data-testid="error-block"]')).toBeTruthy();
  });

  it('edge: very long content renders in full', () => {
    const long = 'x'.repeat(5000);
    setInputs(long);
    expect(el().textContent).toContain(long);
  });

  it('state: actionable variant emits actioned on click', () => {
    setInputs('auth', 'auth_required');
    const spy = vi.fn();
    component.actioned.subscribe(spy);
    const actionBtn = el().querySelector(
      '[data-testid="error-action"]'
    ) as HTMLButtonElement | null;
    actionBtn?.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('state: passive variants do not emit on any interaction', () => {
    setInputs('boom', 'network');
    const spy = vi.fn();
    component.actioned.subscribe(spy);
    fixture.detectChanges();
    expect(spy).not.toHaveBeenCalled();
  });

  it('ARIA: wrapper has role=alert; aria-live is polite only for stopped_by_user', () => {
    setInputs('turn cancelled', 'stopped_by_user');
    const wrapper = el().querySelector('[data-testid="error-block"]');
    expect(wrapper?.getAttribute('role')).toBe('alert');
    expect(wrapper?.getAttribute('aria-live')).toBe('polite');
  });

  it('ARIA: aria-live is assertive for failure variants (red and amber)', () => {
    setInputs('pick', 'no_active_project');
    let wrapper = el().querySelector('[data-testid="error-block"]');
    expect(wrapper?.getAttribute('role')).toBe('alert');
    expect(wrapper?.getAttribute('aria-live')).toBe('assertive');

    setInputs('boom', 'rate_limit');
    wrapper = el().querySelector('[data-testid="error-block"]');
    expect(wrapper?.getAttribute('aria-live')).toBe('assertive');
  });

  it('ARIA: action button is a real <button> with accessible text', () => {
    setInputs('pick', 'no_active_project');
    const action = el().querySelector('[data-testid="error-action"]') as HTMLButtonElement | null;
    expect(action?.tagName).toBe('BUTTON');
    expect(action?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('data-kind attribute reflects the current kind', () => {
    setInputs('x', 'rate_limit');
    expect(el().querySelector('[data-testid="error-block"]')?.getAttribute('data-kind')).toBe(
      'rate_limit'
    );
    setInputs('x', 'auth_required');
    expect(el().querySelector('[data-testid="error-block"]')?.getAttribute('data-kind')).toBe(
      'auth_required'
    );
  });
});
