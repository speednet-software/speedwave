import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SecretStoreService } from './secret-store.service';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { makeMockLogger } from '../testing/mock-logger';
import type { SecretStoreStatus } from '../models/secret-store';

const READY: SecretStoreStatus = {
  state: 'ready',
  integrations: [],
  plaintextCount: 0,
  unreadable: [],
  migrationNotices: [],
};

const KEY_MISSING: SecretStoreStatus = {
  state: 'keyMissing',
  integrations: [
    { project: 'alpha', service: 'redmine' },
    { project: 'alpha', service: 'slack' },
  ],
  plaintextCount: 0,
  unreadable: [],
  migrationNotices: [],
};

describe('SecretStoreService', () => {
  let mockTauri: MockTauriService;
  let logger: ReturnType<typeof makeMockLogger>;
  let calls: { cmd: string; args?: Record<string, unknown> }[];

  async function create(
    handler: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  ): Promise<SecretStoreService> {
    mockTauri.invokeHandler = async (cmd, args) => {
      calls.push({ cmd, args });
      return handler(cmd, args);
    };
    const service = TestBed.inject(SecretStoreService);
    await service.refresh();
    return service;
  }

  beforeEach(() => {
    mockTauri = new MockTauriService();
    logger = makeMockLogger();
    calls = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: logger },
      ],
    });
  });

  it('is not blocking before the first status arrives', () => {
    mockTauri.invokeHandler = () => new Promise(() => undefined);
    const service = TestBed.inject(SecretStoreService);

    expect(service.status()).toBeNull();
    expect(service.state()).toBe('ready');
    expect(service.blocking()).toBe(false);
  });

  it('stays ready for a ready status', async () => {
    const service = await create(async () => READY);

    expect(service.state()).toBe('ready');
    expect(service.blocking()).toBe(false);
    expect(service.notices()).toEqual([]);
  });

  it('blocks and groups the integrations when the key is missing', async () => {
    const service = await create(async () => KEY_MISSING);

    expect(service.blocking()).toBe(true);
    expect(service.state()).toBe('keyMissing');
    expect(service.affectedProjects()).toEqual([
      { project: 'alpha', services: ['redmine', 'slack'] },
    ]);
  });

  it('exposes the plaintext count and blocks', async () => {
    const service = await create(async () => ({
      ...READY,
      state: 'plaintextInStore',
      plaintextCount: 3,
    }));

    expect(service.blocking()).toBe(true);
    expect(service.plaintextCount()).toBe(3);
  });

  it('blocks when the key file is unreadable', async () => {
    const service = await create(async () => ({ ...READY, state: 'keyUnreadable' }));

    expect(service.blocking()).toBe(true);
    expect(service.state()).toBe('keyUnreadable');
  });

  it('blocks when the secrets directory cannot be read', async () => {
    const service = await create(async () => ({ ...READY, state: 'storeUnavailable' }));

    expect(service.blocking()).toBe(true);
    expect(service.state()).toBe('storeUnavailable');
  });

  it('ignores a malformed status and keeps the last one', async () => {
    let answer: unknown = KEY_MISSING;
    const service = await create(async () => answer);
    answer = { state: 'nonsense' };

    await service.refresh();

    expect(service.state()).toBe('keyMissing');
  });

  it('logs a failed refresh without blocking', async () => {
    const service = await create(async () => {
      throw new Error('no host');
    });

    expect(service.blocking()).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('shows unreadable-integration notices until they are dismissed', async () => {
    let unreadable = ['Integration slack: cannot read the secret.'];
    const service = await create(async () => ({ ...READY, unreadable }));
    expect(service.notices()).toEqual(['Integration slack: cannot read the secret.']);

    service.dismissNotices();
    expect(service.notices()).toEqual([]);

    unreadable = ['Integration slack: cannot read the secret.', 'Integration redmine: cannot read'];
    await service.refresh();
    expect(service.notices()).toEqual(['Integration redmine: cannot read']);
  });

  it('adds failed-migration notices after the unreadable ones and dismisses both', async () => {
    const service = await create(async () => ({
      ...READY,
      unreadable: ['Integration slack: cannot read the secret.'],
      migrationNotices: ['Startup migration secrets_at_rest did not finish: 1 problem(s).'],
    }));
    expect(service.notices()).toEqual([
      'Integration slack: cannot read the secret.',
      'Startup migration secrets_at_rest did not finish: 1 problem(s).',
    ]);

    service.dismissNotices();
    expect(service.notices()).toEqual([]);
  });

  it('shows failed-migration notices on their own', async () => {
    const service = await create(async () => ({
      ...READY,
      migrationNotices: ['Startup migration legacy_files did not finish: 2 paths.'],
    }));
    expect(service.notices()).toEqual(['Startup migration legacy_files did not finish: 2 paths.']);
  });

  it('creates a new key with confirmed true and applies the returned status', async () => {
    const service = await create(async (cmd) =>
      cmd === 'reset_secret_store' ? READY : KEY_MISSING
    );

    await service.createNewKey();

    expect(calls.filter((c) => c.cmd === 'reset_secret_store')).toEqual([
      { cmd: 'reset_secret_store', args: { confirmed: true } },
    ]);
    expect(service.state()).toBe('ready');
    expect(service.resetError()).toBeNull();
    expect(service.resetting()).toBe(false);
  });

  it('keeps blocking and reports the error when the reset fails', async () => {
    const service = await create(async (cmd) => {
      if (cmd === 'reset_secret_store') {
        throw new Error('The secret store does not need a new key.');
      }
      return KEY_MISSING;
    });

    await service.createNewKey();

    expect(service.state()).toBe('keyMissing');
    expect(service.resetError()).toBe('The secret store does not need a new key.');
    expect(service.resetting()).toBe(false);
  });

  it('reports an unexpected reset answer', async () => {
    const service = await create(async (cmd) =>
      cmd === 'reset_secret_store' ? 'oops' : KEY_MISSING
    );

    await service.createNewKey();

    expect(service.state()).toBe('keyMissing');
    expect(service.resetError()).toBe('The secret store returned an unexpected answer.');
  });

  it('runs one reset at a time', async () => {
    let release: (value: SecretStoreStatus) => void = () => undefined;
    const pending = new Promise<SecretStoreStatus>((resolve) => (release = resolve));
    const service = await create(async (cmd) =>
      cmd === 'reset_secret_store' ? pending : KEY_MISSING
    );

    const first = service.createNewKey();
    await service.createNewKey();
    expect(service.resetting()).toBe(true);
    release(READY);
    await first;

    expect(calls.filter((c) => c.cmd === 'reset_secret_store')).toHaveLength(1);
    expect(service.state()).toBe('ready');
  });
});
