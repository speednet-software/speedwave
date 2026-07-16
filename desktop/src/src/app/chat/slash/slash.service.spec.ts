import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SlashService, isBareSlash, type SlashDiscovery } from './slash.service';
import { TauriService } from '../../services/tauri.service';
import { LoggerService } from '../../services/logger.service';

describe('isBareSlash', () => {
  it('matches a lone slash, with or without surrounding whitespace', () => {
    expect(isBareSlash('/')).toBe(true);
    expect(isBareSlash('  /  ')).toBe(true);
    expect(isBareSlash('\n/\t')).toBe(true);
  });

  it('rejects real commands, text, and blanks', () => {
    expect(isBareSlash('/code-review')).toBe(false);
    expect(isBareSlash('what is 2/3?')).toBe(false);
    expect(isBareSlash('hej')).toBe(false);
    expect(isBareSlash('')).toBe(false);
    expect(isBareSlash('   ')).toBe(false);
  });
});

class MockTauri {
  invokeMock = vi.fn();
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    return this.invokeMock(cmd, args) as Promise<T>;
  }
}

function makeMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Resolves only after `tick()` is called; lets a test hold a refresh() mid-flight. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SlashService', () => {
  let service: SlashService;
  let tauri: MockTauri;
  let mockLogger: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    tauri = new MockTauri();
    mockLogger = makeMockLogger();
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: tauri },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });
    service = TestBed.inject(SlashService);
  });

  it('starts empty with no source, not discovering, not unavailable', () => {
    expect(service.commands()).toEqual([]);
    expect(service.source()).toBeNull();
    expect(service.discovering()).toBe(false);
    expect(service.isLoadingEmpty()).toBe(false);
    expect(service.unavailable()).toBe(false);
  });

  it('refresh() populates signals from the backend discovery', async () => {
    const discovery: SlashDiscovery = {
      commands: [
        {
          name: 'help',
          description: 'Show help',
          argument_hint: null,
          kind: 'Builtin',
          plugin: null,
        },
        { name: 'skill', description: null, argument_hint: null, kind: 'Skill', plugin: null },
      ],
      source: 'Init',
    };
    tauri.invokeMock.mockResolvedValue(discovery);

    await service.refresh('acme');

    expect(tauri.invokeMock).toHaveBeenCalledWith('list_slash_commands', { projectId: 'acme' });
    expect(service.commands()).toEqual(discovery.commands);
    expect(service.source()).toBe('Init');
    expect(service.discovering()).toBe(false);
    expect(service.error()).toBeNull();
    expect(service.unavailable()).toBe(false);
  });

  it('refresh() sets unavailable=true when source is Unavailable, keeps returned commands', async () => {
    const discovery: SlashDiscovery = { commands: [], source: 'Unavailable' };
    tauri.invokeMock.mockResolvedValue(discovery);

    await service.refresh('acme');

    expect(service.source()).toBe('Unavailable');
    expect(service.unavailable()).toBe(true);
    expect(service.commands()).toEqual([]);
    expect(service.error()).toBeNull();
  });

  it('refresh() clears unavailable on a subsequent Init result', async () => {
    tauri.invokeMock.mockResolvedValueOnce({
      commands: [],
      source: 'Unavailable',
    } as SlashDiscovery);
    await service.refresh('acme');
    expect(service.unavailable()).toBe(true);

    tauri.invokeMock.mockResolvedValueOnce({
      commands: [
        { name: 'clear', description: null, argument_hint: null, kind: 'Builtin', plugin: null },
      ],
      source: 'Init',
    } as SlashDiscovery);
    await service.refresh('acme');

    expect(service.unavailable()).toBe(false);
    expect(service.source()).toBe('Init');
  });

  it('refresh() sets source=null and error on backend failure without throwing', async () => {
    tauri.invokeMock.mockRejectedValue(new Error('container down'));

    await service.refresh('acme');

    expect(service.source()).toBeNull();
    expect(service.error()).toBe('Error: container down');
    expect(service.commands()).toEqual([]);
    expect(service.discovering()).toBe(false);
    expect(service.unavailable()).toBe(false);
  });

  it('refresh() preserves the previous list on error (no wipe)', async () => {
    const initial: SlashDiscovery = {
      commands: [
        { name: 'help', description: null, argument_hint: null, kind: 'Builtin', plugin: null },
      ],
      source: 'Init',
    };
    tauri.invokeMock.mockResolvedValueOnce(initial);
    await service.refresh('acme');
    expect(service.commands().length).toBe(1);

    tauri.invokeMock.mockRejectedValueOnce(new Error('later failure'));
    await service.refresh('acme');

    expect(service.commands().length).toBe(1);
    expect(service.source()).toBeNull();
    expect(service.error()).toContain('later failure');
  });

  it('refresh() with empty projectId clears state without invoking', async () => {
    await service.refresh('');
    expect(tauri.invokeMock).not.toHaveBeenCalled();
    expect(service.commands()).toEqual([]);
    expect(service.source()).toBeNull();
    expect(service.unavailable()).toBe(false);
  });

  it('isLoadingEmpty computes true only while discovering an empty list', async () => {
    const never = new Promise<SlashDiscovery>(() => {
      /* pending forever */
    });
    tauri.invokeMock.mockReturnValue(never);
    const pending = service.refresh('acme');
    expect(service.isLoadingEmpty()).toBe(true);
    void pending;
  });

  it('a second concurrent refresh() no-ops while one is already in flight', async () => {
    const first = deferred<SlashDiscovery>();
    tauri.invokeMock.mockReturnValueOnce(first.promise);

    const call1 = service.refresh('acme');
    expect(service.discovering()).toBe(true);

    // Second caller arrives while the first is still in flight.
    const call2 = service.refresh('acme');

    first.resolve({
      commands: [
        { name: 'clear', description: null, argument_hint: null, kind: 'Builtin', plugin: null },
      ],
      source: 'Init',
    });
    await Promise.all([call1, call2]);

    expect(tauri.invokeMock).toHaveBeenCalledTimes(1);
    expect(service.commands().length).toBe(1);
    expect(service.discovering()).toBe(false);
  });

  it('refresh() runs again once the previous in-flight call has resolved', async () => {
    tauri.invokeMock.mockResolvedValueOnce({ commands: [], source: 'Init' } as SlashDiscovery);
    await service.refresh('acme');
    expect(tauri.invokeMock).toHaveBeenCalledTimes(1);

    tauri.invokeMock.mockResolvedValueOnce({ commands: [], source: 'Init' } as SlashDiscovery);
    await service.refresh('acme');
    expect(tauri.invokeMock).toHaveBeenCalledTimes(2);
  });

  it('invalidate() calls the Tauri command', async () => {
    tauri.invokeMock.mockResolvedValue(undefined);
    await service.invalidate('acme');
    expect(tauri.invokeMock).toHaveBeenCalledWith('invalidate_slash_cache', { projectId: 'acme' });
  });

  it('invalidate() swallows errors so UI never crashes but logs via LoggerService', async () => {
    tauri.invokeMock.mockRejectedValue(new Error('invalidation failed'));
    await expect(service.invalidate('acme')).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('invalidate_slash_cache failed: Error: invalidation failed')
    );
  });

  it('invalidate() with empty projectId is a no-op', async () => {
    await service.invalidate('');
    expect(tauri.invokeMock).not.toHaveBeenCalled();
  });
});
