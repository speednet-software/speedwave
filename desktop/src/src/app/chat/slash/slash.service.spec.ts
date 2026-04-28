import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SlashService, type SlashDiscovery } from './slash.service';
import { TauriService } from '../../services/tauri.service';

class MockTauri {
  invokeMock = vi.fn();
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    return this.invokeMock(cmd, args) as Promise<T>;
  }
}

describe('SlashService', () => {
  let service: SlashService;
  let tauri: MockTauri;

  beforeEach(() => {
    tauri = new MockTauri();
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: tauri }],
    });
    service = TestBed.inject(SlashService);
  });

  it('starts empty with no source and not discovering', () => {
    expect(service.commands()).toEqual([]);
    expect(service.source()).toBeNull();
    expect(service.discovering()).toBe(false);
    expect(service.isLoadingEmpty()).toBe(false);
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
  });

  it('refresh() sets source=null and error on backend failure without throwing', async () => {
    tauri.invokeMock.mockRejectedValue(new Error('container down'));

    await service.refresh('acme');

    expect(service.source()).toBeNull();
    expect(service.error()).toBe('Error: container down');
    expect(service.commands()).toEqual([]);
    expect(service.discovering()).toBe(false);
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

    // Commands are preserved, error is captured, source becomes null.
    expect(service.commands().length).toBe(1);
    expect(service.source()).toBeNull();
    expect(service.error()).toContain('later failure');
  });

  it('refresh() with empty projectId clears state without invoking', async () => {
    await service.refresh('');
    expect(tauri.invokeMock).not.toHaveBeenCalled();
    expect(service.commands()).toEqual([]);
    expect(service.source()).toBeNull();
  });

  it('isLoadingEmpty computes true only while discovering an empty list', async () => {
    const never = new Promise<SlashDiscovery>(() => {
      /* pending forever */
    });
    tauri.invokeMock.mockReturnValue(never);
    const pending = service.refresh('acme');
    // After set(true) in refresh, the computed reflects loading-empty.
    expect(service.isLoadingEmpty()).toBe(true);
    // Stop the pending promise by rejecting internal state: simulate abort.
    void pending;
  });

  it('invalidate() calls the Tauri command', async () => {
    tauri.invokeMock.mockResolvedValue(undefined);
    await service.invalidate('acme');
    expect(tauri.invokeMock).toHaveBeenCalledWith('invalidate_slash_cache', { projectId: 'acme' });
  });

  it('invalidate() swallows errors so UI never crashes', async () => {
    tauri.invokeMock.mockRejectedValue(new Error('invalidation failed'));
    await expect(service.invalidate('acme')).resolves.toBeUndefined();
  });

  it('invalidate() with empty projectId is a no-op', async () => {
    await service.invalidate('');
    expect(tauri.invokeMock).not.toHaveBeenCalled();
  });
});
