import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OauthConnectComponent } from './oauth-connect.component';

describe('OauthConnectComponent', () => {
  let fixture: ComponentFixture<OauthConnectComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OauthConnectComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(OauthConnectComponent);
    el = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('providerLabel', 'GLPI');
  });

  function q(sel: string): HTMLElement | null {
    return el.querySelector(sel);
  }

  it('shows the Sign-in button when idle and not configured', () => {
    fixture.detectChanges();
    const btn = q('[data-testid="btn-start-oauth"]');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain('GLPI');
  });

  it('shows Reconnect when already configured', () => {
    fixture.componentRef.setInput('configured', true);
    fixture.detectChanges();
    expect(q('[data-testid="btn-reconnect-oauth"]')).not.toBeNull();
    expect(q('[data-testid="btn-start-oauth"]')).toBeNull();
  });

  it('disables Sign-in when prerequisites are not met', () => {
    fixture.componentRef.setInput('prerequisitesMet', false);
    fixture.componentRef.setInput('prerequisitesMissingMessage', 'Fill in Client ID');
    fixture.detectChanges();
    const btn = q('[data-testid="btn-start-oauth"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(q('[data-testid="oauth-prereq-hint"]')?.textContent).toContain('Client ID');
  });

  it('renders the redirect URI while awaiting the browser (authorization_code)', () => {
    fixture.componentRef.setInput('status', 'awaiting_redirect');
    fixture.componentRef.setInput('redirectUri', 'http://127.0.0.1:5005/callback');
    fixture.detectChanges();
    const hint = q('[data-testid="oauth-redirect-uri"]');
    expect(hint?.textContent).toContain('127.0.0.1:5005/callback');
    expect(q('[data-testid="btn-cancel-oauth"]')).not.toBeNull();
  });

  it('renders the device code (device flow)', () => {
    fixture.componentRef.setInput('deviceCode', {
      user_code: 'WXYZ-1234',
      verification_uri: 'https://idp.example.com/device',
    });
    fixture.detectChanges();
    expect(q('[data-testid="user-code"]')?.textContent).toContain('WXYZ-1234');
    expect(q('[data-testid="verification-url"]')?.textContent).toContain('idp.example.com');
  });

  it('shows success and error states', () => {
    fixture.componentRef.setInput('status', 'success');
    fixture.detectChanges();
    expect(q('[data-testid="oauth-success"]')).not.toBeNull();

    fixture.componentRef.setInput('status', 'error');
    fixture.componentRef.setInput('statusMessage', 'invalid_grant');
    fixture.detectChanges();
    expect(q('[data-testid="oauth-error"]')?.textContent).toContain('invalid_grant');
  });

  it('emits authorize/cancel/openUrl', () => {
    let authorized = 0;
    let cancelled = 0;
    let opened: string | null = null;
    fixture.componentInstance.authorize.subscribe(() => authorized++);
    fixture.componentInstance.cancelFlow.subscribe(() => cancelled++);
    fixture.componentInstance.openUrl.subscribe((u) => (opened = u));

    fixture.detectChanges();
    (q('[data-testid="btn-start-oauth"]') as HTMLButtonElement).click();
    expect(authorized).toBe(1);

    fixture.componentRef.setInput('deviceCode', {
      user_code: 'A',
      verification_uri: 'https://idp/device',
    });
    fixture.detectChanges();
    (q('[data-testid="btn-link"]') as HTMLButtonElement).click();
    expect(opened).toBe('https://idp/device');
    (q('[data-testid="btn-cancel-oauth"]') as HTMLButtonElement).click();
    expect(cancelled).toBe(1);
  });
});
