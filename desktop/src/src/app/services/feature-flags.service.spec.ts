import { TestBed } from '@angular/core/testing';
import { FeatureFlagsService } from './feature-flags.service';
import { TauriService } from './tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('FeatureFlagsService', () => {
  let mockTauri: MockTauriService;

  function createService(): FeatureFlagsService {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: mockTauri }],
    });
    return TestBed.inject(FeatureFlagsService);
  }

  beforeEach(() => {
    mockTauri = new MockTauriService();
  });

  async function awaitInit(): Promise<void> {
    for (let i = 0; i < 20 && !mockTauri.listenHandlers['feature-flags-changed']; i++) {
      await Promise.resolve();
    }
  }

  it('seeds every flag from get_feature_flags', async () => {
    mockTauri.invokeHandler = async (cmd) =>
      cmd === 'get_feature_flags' ? { office: true, telemetry_settings: false } : undefined;

    const service = createService();
    await awaitInit();

    expect(service.enabled('office')).toBe(true);
    expect(service.enabled('telemetry_settings')).toBe(false);
  });

  it('applies the flags of each feature-flags-changed event', async () => {
    mockTauri.invokeHandler = async (cmd) =>
      cmd === 'get_feature_flags' ? { office: false, telemetry_settings: false } : undefined;

    const service = createService();
    await awaitInit();

    mockTauri.dispatchEvent('feature-flags-changed', { office: true, telemetry_settings: false });
    expect(service.enabled('office')).toBe(true);
    expect(service.enabled('telemetry_settings')).toBe(false);

    mockTauri.dispatchEvent('feature-flags-changed', { office: false, telemetry_settings: true });
    expect(service.enabled('office')).toBe(false);
    expect(service.enabled('telemetry_settings')).toBe(true);
  });

  it('keeps every flag off when invoke throws (no Tauri host)', async () => {
    mockTauri.invokeHandler = async () => {
      throw new Error('not running inside Tauri');
    };

    const service = createService();
    await awaitInit();

    expect(service.enabled('office')).toBe(false);
    expect(service.enabled('telemetry_settings')).toBe(false);
  });

  it('keeps every flag off when get_feature_flags returns nothing', async () => {
    mockTauri.invokeHandler = async () => undefined;

    const service = createService();
    await awaitInit();

    expect(service.enabled('office')).toBe(false);
    expect(service.enabled('telemetry_settings')).toBe(false);
  });

  it('set sends the flag to set_feature_flag and shows it at once', async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    mockTauri.invokeHandler = async (cmd, args) => {
      calls.push({ cmd, args });
      return cmd === 'get_feature_flags' ? { office: false, telemetry_settings: false } : undefined;
    };
    const service = createService();
    await awaitInit();

    await service.set('telemetry_settings', true);

    expect(calls).toContainEqual({
      cmd: 'set_feature_flag',
      args: { flag: 'telemetry_settings', enabled: true },
    });
    expect(service.enabled('telemetry_settings')).toBe(true);
    expect(service.enabled('office')).toBe(false);
  });

  it('set rejects with the backend error and leaves the flag unchanged', async () => {
    mockTauri.invokeHandler = async (cmd) => {
      if (cmd === 'set_feature_flag') throw new Error('unknown feature flag: office');
      return { office: false, telemetry_settings: false };
    };
    const service = createService();
    await awaitInit();

    await expect(service.set('office', true)).rejects.toThrow('unknown feature flag: office');
    expect(service.enabled('office')).toBe(false);
  });
});
