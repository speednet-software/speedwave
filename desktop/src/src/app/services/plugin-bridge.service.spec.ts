import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { PluginBridgeService } from './plugin-bridge.service';
import { TauriService } from './tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import type { PluginBridgeStatus } from '../models/plugin';

const SLUG = 'figma';

type RunningSnapshot = Extract<PluginBridgeStatus, { running: true }>;

function snapshot(overrides: Partial<RunningSnapshot> = {}): PluginBridgeStatus {
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

describe('PluginBridgeService', () => {
  let service: PluginBridgeService;
  let mockTauri: MockTauriService;
  let invokeCount: Record<string, number>;
  let lastSnapshot: PluginBridgeStatus;

  beforeEach(() => {
    invokeCount = {};
    lastSnapshot = snapshot();
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      invokeCount[cmd] = (invokeCount[cmd] ?? 0) + 1;
      if (cmd === 'plugin_bridge_get_status') return lastSnapshot;
      if (cmd === 'plugin_bridge_get_credentials') {
        const port = lastSnapshot.running ? lastSnapshot.port : 0;
        return { slug: SLUG, url: `ws://127.0.0.1:${port}/`, token: 'uuid-token' };
      }
      return undefined;
    };
    TestBed.configureTestingModule({
      providers: [PluginBridgeService, { provide: TauriService, useValue: mockTauri }],
    });
    service = TestBed.inject(PluginBridgeService);
  });

  it('returns the same signal for repeated status() calls on the same slug', () => {
    const a = service.status(SLUG);
    const b = service.status(SLUG);
    expect(a).toBe(b);
  });

  it('populates the signal after refresh()', async () => {
    await service.refresh(SLUG);
    const status = service.status(SLUG)();
    expect(status).toMatchObject({ slug: SLUG, running: true, port: 60123 });
  });

  it('subscribes to plugin_bridge_event exactly once across multiple refresh() calls', async () => {
    await service.refresh(SLUG);
    await service.refresh(SLUG);
    await service.refresh(SLUG);
    expect(Object.keys(mockTauri.listenHandlers)).toEqual(['plugin_bridge_event']);
  });

  it('flips paired and partner_connected to true on paired event', async () => {
    await service.refresh(SLUG);
    mockTauri.dispatchEvent('plugin_bridge_event', { slug: SLUG, kind: 'paired' });
    const status = service.status(SLUG)();
    expect(status?.running && status.paired).toBe(true);
    expect(status?.running && status.partner_connected).toBe(true);
  });

  it('flips only partner_connected on slot_occupied event', async () => {
    await service.refresh(SLUG);
    mockTauri.dispatchEvent('plugin_bridge_event', { slug: SLUG, kind: 'slot_occupied' });
    const status = service.status(SLUG)();
    expect(status?.running && status.partner_connected).toBe(true);
    expect(status?.running && status.paired).toBe(false);
  });

  it('resets paired and partner_connected on disconnected event', async () => {
    lastSnapshot = snapshot({ paired: true, partner_connected: true });
    await service.refresh(SLUG);
    mockTauri.dispatchEvent('plugin_bridge_event', { slug: SLUG, kind: 'disconnected' });
    const status = service.status(SLUG)();
    expect(status?.running && status.paired).toBe(false);
    expect(status?.running && status.partner_connected).toBe(false);
  });

  it('returns credentials from plugin_bridge_get_credentials', async () => {
    const creds = await service.credentials(SLUG);
    expect(creds).toEqual({ slug: SLUG, url: 'ws://127.0.0.1:60123/', token: 'uuid-token' });
  });

  it('does not throw when an event arrives for an unknown slug', async () => {
    await service.refresh(SLUG);
    expect(() =>
      mockTauri.dispatchEvent('plugin_bridge_event', { slug: 'other', kind: 'paired' })
    ).not.toThrow();
  });
});
