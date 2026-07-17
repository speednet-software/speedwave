import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  SlashService,
  isBareSlash,
  isBlankOrSlashOnly,
  isControlShaped,
  type SlashDiscovery,
} from './slash.service';
import { TauriService } from '../../services/tauri.service';
import { LoggerService } from '../../services/logger.service';

interface ControlShapeCase {
  readonly input: string;
  readonly is_control: boolean;
}

/**
 * Shared Rust↔TS fixture table (`crates/speedwave-runtime/src/fixtures/control_command_shape.json`):
 * both Rust `parse_control_command` and this spec assert against the same
 * cases, so a divergence (e.g. TS matching a tab that Rust rejects) fails on
 * whichever side regresses.
 */
const FIXTURE_REL = join(
  'crates',
  'speedwave-runtime',
  'src',
  'fixtures',
  'control_command_shape.json'
);

// __dirname depth varies under the coverage transform; walk up to the repo root.
function locateFixture(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, FIXTURE_REL);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`control_command_shape.json not found walking up from ${__dirname}`);
}

function loadControlShapeFixture(): ControlShapeCase[] {
  return JSON.parse(readFileSync(locateFixture(), 'utf-8')) as ControlShapeCase[];
}

describe('isControlShaped', () => {
  it('agrees with the Rust parse_control_command fixture table', () => {
    const cases = loadControlShapeFixture();
    expect(cases.length).toBeGreaterThan(0);
    for (const { input, is_control } of cases) {
      expect(isControlShaped(input), `isControlShaped(${JSON.stringify(input)})`).toBe(is_control);
    }
  });
});

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

describe('isBlankOrSlashOnly', () => {
  it('is true for empty and whitespace-only text', () => {
    expect(isBlankOrSlashOnly('')).toBe(true);
    expect(isBlankOrSlashOnly('   ')).toBe(true);
    expect(isBlankOrSlashOnly('\n\t ')).toBe(true);
  });

  it('is true for a lone slash, with or without surrounding whitespace', () => {
    expect(isBlankOrSlashOnly('/')).toBe(true);
    expect(isBlankOrSlashOnly('  /  ')).toBe(true);
    expect(isBlankOrSlashOnly('\n/\t')).toBe(true);
  });

  it('is false for a real slash command', () => {
    expect(isBlankOrSlashOnly('/code-review')).toBe(false);
    expect(isBlankOrSlashOnly('/clear')).toBe(false);
  });

  it('is false for ordinary text', () => {
    expect(isBlankOrSlashOnly('hej')).toBe(false);
    expect(isBlankOrSlashOnly('what is 2/3?')).toBe(false);
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
    expect(service.unavailableReason()).toBeNull();
  });

  it('refresh() surfaces the backend reason when source is Unavailable', async () => {
    const discovery: SlashDiscovery = {
      commands: [],
      source: 'Unavailable',
      reason: 'timed out after 60s with no init',
    };
    tauri.invokeMock.mockResolvedValue(discovery);

    await service.refresh('acme');

    expect(service.unavailable()).toBe(true);
    expect(service.unavailableReason()).toBe('timed out after 60s with no init');
  });

  it('refresh() clears a stale reason once a subsequent Init result arrives', async () => {
    tauri.invokeMock.mockResolvedValueOnce({
      commands: [],
      source: 'Unavailable',
      reason: 'exited without output (exit status 1 after 12ms)',
    } as SlashDiscovery);
    await service.refresh('acme');
    expect(service.unavailableReason()).toBe('exited without output (exit status 1 after 12ms)');

    tauri.invokeMock.mockResolvedValueOnce({ commands: [], source: 'Init' } as SlashDiscovery);
    await service.refresh('acme');
    expect(service.unavailableReason()).toBeNull();
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

  it('refresh() for a different project while one is in flight starts its own fetch', async () => {
    const forA = deferred<SlashDiscovery>();
    tauri.invokeMock.mockReturnValueOnce(forA.promise);

    const callA = service.refresh('project-a');
    expect(service.discovering()).toBe(true);

    const forB = deferred<SlashDiscovery>();
    tauri.invokeMock.mockReturnValueOnce(forB.promise);
    const callB = service.refresh('project-b');

    // Both calls actually hit the backend — no coalescing across projects.
    expect(tauri.invokeMock).toHaveBeenCalledTimes(2);
    expect(tauri.invokeMock).toHaveBeenNthCalledWith(1, 'list_slash_commands', {
      projectId: 'project-a',
    });
    expect(tauri.invokeMock).toHaveBeenNthCalledWith(2, 'list_slash_commands', {
      projectId: 'project-b',
    });

    forB.resolve({
      commands: [
        { name: 'b-cmd', description: null, argument_hint: null, kind: 'Command', plugin: null },
      ],
      source: 'Init',
    });
    await callB;
    expect(service.commands().map((c) => c.name)).toEqual(['b-cmd']);
    expect(service.discovering()).toBe(false);

    // A's late result must not clobber B's already-applied signals.
    forA.resolve({
      commands: [
        { name: 'a-cmd', description: null, argument_hint: null, kind: 'Command', plugin: null },
      ],
      source: 'Init',
    });
    await callA;
    expect(service.commands().map((c) => c.name)).toEqual(['b-cmd']);
    expect(service.discovering()).toBe(false);
  });

  it('refresh() same-project coalescing still holds while a different-project fetch is unaffected', async () => {
    const forA = deferred<SlashDiscovery>();
    tauri.invokeMock.mockReturnValueOnce(forA.promise);

    const callA1 = service.refresh('project-a');
    const callA2 = service.refresh('project-a');

    expect(tauri.invokeMock).toHaveBeenCalledTimes(1);

    forA.resolve({
      commands: [
        { name: 'a-cmd', description: null, argument_hint: null, kind: 'Command', plugin: null },
      ],
      source: 'Init',
    });
    await Promise.all([callA1, callA2]);
    expect(service.commands().map((c) => c.name)).toEqual(['a-cmd']);
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
