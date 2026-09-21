import { describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { SettingsDirtyService } from './settings-dirty.service';

describe('SettingsDirtyService', () => {
  let service: SettingsDirtyService;

  beforeEach(() => {
    service = new SettingsDirtyService();
  });

  it('reports no dirty sections when nothing is registered', () => {
    expect(service.hasDirty()).toBe(false);
    expect(service.dirtySectionNames()).toEqual([]);
  });

  it('lists a registered dirty section by name and ignores clean ones', () => {
    service.register({ name: 'Telemetry', isDirty: signal(true), save: async () => {} });
    service.register({ name: 'Security', isDirty: signal(false), save: async () => {} });
    expect(service.hasDirty()).toBe(true);
    expect(service.dirtySectionNames()).toEqual(['Telemetry']);
  });

  it('drops a section after unregister', () => {
    const unregister = service.register({
      name: 'Telemetry',
      isDirty: signal(true),
      save: async () => {},
    });
    unregister();
    expect(service.hasDirty()).toBe(false);
  });

  it('confirmLeave resolves with the choice passed to resolvePrompt', async () => {
    const pending = service.confirmLeave();
    expect(service.promptOpen()).toBe(true);
    service.resolvePrompt('discard');
    await expect(pending).resolves.toBe('discard');
    expect(service.promptOpen()).toBe(false);
  });

  it('a second confirmLeave while one is open resolves to stay', async () => {
    const first = service.confirmLeave();
    await expect(service.confirmLeave()).resolves.toBe('stay');
    expect(service.promptOpen()).toBe(true);
    service.resolvePrompt('save');
    await expect(first).resolves.toBe('save');
  });

  it('resolvePrompt without an open prompt is a no-op', () => {
    service.resolvePrompt('stay');
    expect(service.promptOpen()).toBe(false);
  });

  it('saveDirtySections saves only dirty sections and succeeds when they end clean', async () => {
    const saved: string[] = [];
    const dirtyA = signal(true);
    service.register({
      name: 'LLM provider',
      isDirty: dirtyA,
      save: async () => {
        dirtyA.set(false);
        saved.push('LLM provider');
      },
    });
    service.register({
      name: 'Security',
      isDirty: signal(false),
      save: async () => {
        saved.push('Security');
      },
    });
    await expect(service.saveDirtySections()).resolves.toBe(true);
    expect(saved).toEqual(['LLM provider']);
  });

  it('saveDirtySections reports failure when a section stays dirty', async () => {
    service.register({ name: 'Telemetry', isDirty: signal(true), save: async () => {} });
    await expect(service.saveDirtySections()).resolves.toBe(false);
  });

  it('saveDirtySections reports failure when a save throws', async () => {
    service.register({
      name: 'Telemetry',
      isDirty: signal(true),
      save: async () => {
        throw new Error('backend down');
      },
    });
    await expect(service.saveDirtySections()).resolves.toBe(false);
  });

  it('prompt suppression is one-shot', () => {
    expect(service.consumeSuppression()).toBe(false);
    service.suppressNextPrompt();
    expect(service.consumeSuppression()).toBe(true);
    expect(service.consumeSuppression()).toBe(false);
  });
});
