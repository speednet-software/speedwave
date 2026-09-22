import { describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { settingsUnsavedChangesGuard } from './settings-unsaved-changes.guard';
import { SettingsDirtyService } from '../settings/settings-dirty.service';

describe('settingsUnsavedChangesGuard', () => {
  let registry: SettingsDirtyService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    registry = TestBed.inject(SettingsDirtyService);
  });

  function run(): Promise<boolean> {
    return TestBed.runInInjectionContext(() =>
      settingsUnsavedChangesGuard({} as never, {} as never, {} as never, {} as never)
    ) as Promise<boolean>;
  }

  it('passes without prompting when nothing is dirty', async () => {
    await expect(run()).resolves.toBe(true);
    expect(registry.promptOpen()).toBe(false);
  });

  it('stay blocks the navigation', async () => {
    registry.register({ name: 'Security', isDirty: signal(true), save: async () => {} });
    const verdict = run();
    expect(registry.promptOpen()).toBe(true);
    registry.resolvePrompt('stay');
    await expect(verdict).resolves.toBe(false);
  });

  it('discard leaves without saving', async () => {
    let saves = 0;
    registry.register({
      name: 'Security',
      isDirty: signal(true),
      save: async () => {
        saves += 1;
      },
    });
    const verdict = run();
    registry.resolvePrompt('discard');
    await expect(verdict).resolves.toBe(true);
    expect(saves).toBe(0);
  });

  it('save waits for the save and passes when the section comes back clean', async () => {
    const isDirty = signal(true);
    registry.register({
      name: 'Telemetry',
      isDirty,
      save: async () => {
        isDirty.set(false);
      },
    });
    const verdict = run();
    registry.resolvePrompt('save');
    await expect(verdict).resolves.toBe(true);
  });

  it('save blocks the navigation when the section stays dirty (failed save)', async () => {
    registry.register({ name: 'Telemetry', isDirty: signal(true), save: async () => {} });
    const verdict = run();
    registry.resolvePrompt('save');
    await expect(verdict).resolves.toBe(false);
  });

  it('a superseding second navigation resolves the first as stay and answers the second', async () => {
    registry.register({ name: 'Security', isDirty: signal(true), save: async () => {} });
    const first = run();
    expect(registry.promptOpen()).toBe(true);
    const second = run();
    await expect(first).resolves.toBe(false);
    expect(registry.promptOpen()).toBe(true);
    registry.resolvePrompt('discard');
    await expect(second).resolves.toBe(true);
  });

  it('a suppressed evaluation passes once without prompting', async () => {
    registry.register({ name: 'Security', isDirty: signal(true), save: async () => {} });
    registry.suppressNextPrompt();
    await expect(run()).resolves.toBe(true);
    expect(registry.promptOpen()).toBe(false);
    const verdict = run();
    expect(registry.promptOpen()).toBe(true);
    registry.resolvePrompt('stay');
    await expect(verdict).resolves.toBe(false);
  });
});
