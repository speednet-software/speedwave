import { TestBed } from '@angular/core/testing';
import { BetaService } from './beta.service';
import { TauriService } from './tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('BetaService', () => {
  let mockTauri: MockTauriService;

  function createService(): BetaService {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: mockTauri }],
    });
    return TestBed.inject(BetaService);
  }

  beforeEach(() => {
    mockTauri = new MockTauriService();
  });

  /** Waits until `BetaService.init()` has registered its `beta-changed` listener. */
  async function awaitInit(): Promise<void> {
    for (let i = 0; i < 20 && !mockTauri.listenHandlers['beta-changed']; i++) {
      await Promise.resolve();
    }
  }

  it('seeds the signal from get_beta_enabled', async () => {
    mockTauri.invokeHandler = async (cmd) => (cmd === 'get_beta_enabled' ? true : undefined);

    const service = createService();
    await awaitInit();

    expect(service.enabled()).toBe(true);
  });

  it('updates on beta-changed events', async () => {
    mockTauri.invokeHandler = async (cmd) => (cmd === 'get_beta_enabled' ? false : undefined);

    const service = createService();
    await awaitInit();
    expect(service.enabled()).toBe(false);

    mockTauri.dispatchEvent('beta-changed', true);
    expect(service.enabled()).toBe(true);

    mockTauri.dispatchEvent('beta-changed', false);
    expect(service.enabled()).toBe(false);
  });

  it('stays off when invoke throws (no Tauri host)', async () => {
    mockTauri.invokeHandler = async () => {
      throw new Error('not running inside Tauri');
    };

    const service = createService();
    await awaitInit();

    expect(service.enabled()).toBe(false);
  });
});
