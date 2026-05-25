import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { BridgeConnectionComponent } from './bridge-connection.component';
import { PluginBridgeService } from '../../services/plugin-bridge.service';
import type { PluginBridgeStatus, PluginBridgeCredentials } from '../../models/plugin';

const SLUG = 'figma';

function running(
  overrides: Partial<Extract<PluginBridgeStatus, { running: true }>> = {}
): PluginBridgeStatus {
  return {
    slug: SLUG,
    running: true,
    port: 60123,
    paired: false,
    partner_connected: false,
    display_name: 'Figma Bridge',
    ...overrides,
  };
}

describe('BridgeConnectionComponent', () => {
  let fixture: ComponentFixture<BridgeConnectionComponent>;
  let statusSig: ReturnType<typeof signal<PluginBridgeStatus | null>>;
  let serviceStub: {
    status: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    credentials: ReturnType<typeof vi.fn>;
  };
  let creds: PluginBridgeCredentials;

  beforeEach(() => {
    statusSig = signal<PluginBridgeStatus | null>(null);
    creds = { slug: SLUG, url: 'ws://127.0.0.1:60123/', token: 'uuid-token' };
    serviceStub = {
      status: vi.fn().mockReturnValue(statusSig.asReadonly()),
      refresh: vi.fn().mockResolvedValue(undefined),
      credentials: vi.fn().mockResolvedValue(creds),
    };
    TestBed.configureTestingModule({
      imports: [BridgeConnectionComponent],
      providers: [{ provide: PluginBridgeService, useValue: serviceStub }],
    });
    fixture = TestBed.createComponent(BridgeConnectionComponent);
    fixture.componentRef.setInput('slug', SLUG);
  });

  it('shows "waiting for connection" + muted dot when status is null', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    expect(cmp.statusLabel()).toBe('waiting for connection');
    expect(cmp.dotColor()).toBe('var(--ink-mute)');
  });

  it('shows accent dot + companion label when only partner_connected', async () => {
    statusSig.set(running({ partner_connected: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    expect(cmp.dotColor()).toBe('var(--accent)');
    expect(cmp.statusLabel()).toBe('companion connected, waiting for worker call');
  });

  it('shows green dot + connected label when paired', async () => {
    statusSig.set(running({ paired: true, partner_connected: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    expect(cmp.dotColor()).toBe('var(--green)');
    expect(cmp.statusLabel()).toBe('connected');
  });

  it('populates url and token after ngOnInit', async () => {
    const cmp = fixture.componentInstance;
    await cmp.ngOnInit();
    expect(cmp.url()).toBe('ws://127.0.0.1:60123/');
    expect(cmp.token()).toBe('uuid-token');
    expect(cmp.error()).toBeNull();
  });

  it('surfaces a "Bridge unavailable" message on credentials fetch failure', async () => {
    serviceStub.credentials.mockRejectedValueOnce(new Error('boom'));
    const cmp = fixture.componentInstance;
    await cmp.ngOnInit();
    expect(cmp.error()).toBe('Bridge unavailable: boom');
  });

  it('toggleReveal flips tokenRevealed', () => {
    const cmp = fixture.componentInstance;
    expect(cmp.tokenRevealed()).toBe(false);
    cmp.toggleReveal();
    expect(cmp.tokenRevealed()).toBe(true);
    cmp.toggleReveal();
    expect(cmp.tokenRevealed()).toBe(false);
  });

  it('copy(url) writes to clipboard and flashes copiedField', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const cmp = fixture.componentInstance;
    await cmp.ngOnInit();
    await cmp.copy('url');
    expect(writeText).toHaveBeenCalledWith('ws://127.0.0.1:60123/');
    expect(cmp.copiedField()).toBe('url');
  });

  it('copy surfaces an error when clipboard write fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const cmp = fixture.componentInstance;
    await cmp.ngOnInit();
    await cmp.copy('token');
    expect(cmp.copyError()).toBe('Could not copy to clipboard');
    expect(cmp.error()).toBeNull();
    expect(cmp.url()).toBe('ws://127.0.0.1:60123/');
    expect(cmp.token()).toBe('uuid-token');
  });
});
