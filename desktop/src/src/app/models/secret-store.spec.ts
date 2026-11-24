import { describe, it, expect } from 'vitest';
import { groupByProject, isSecretStoreStatus } from './secret-store';

const READY = {
  state: 'ready',
  integrations: [],
  plaintextCount: 0,
  unreadable: [],
  migrationNotices: [],
};

describe('isSecretStoreStatus', () => {
  it('accepts every state of a well-formed status', () => {
    for (const state of [
      'ready',
      'keyMissing',
      'plaintextInStore',
      'keyUnreadable',
      'storeUnavailable',
    ]) {
      expect(isSecretStoreStatus({ ...READY, state })).toBe(true);
    }
  });

  it('rejects non-objects, unknown states and missing fields', () => {
    expect(isSecretStoreStatus(undefined)).toBe(false);
    expect(isSecretStoreStatus(null)).toBe(false);
    expect(isSecretStoreStatus('ready')).toBe(false);
    expect(isSecretStoreStatus({ ...READY, state: 'broken' })).toBe(false);
    expect(isSecretStoreStatus({ ...READY, plaintextCount: '0' })).toBe(false);
    expect(isSecretStoreStatus({ ...READY, integrations: null })).toBe(false);
    expect(isSecretStoreStatus({ ...READY, unreadable: undefined })).toBe(false);
    expect(isSecretStoreStatus({ ...READY, migrationNotices: undefined })).toBe(false);
  });
});

describe('groupByProject', () => {
  it('returns no groups for no integrations', () => {
    expect(groupByProject([])).toEqual([]);
  });

  it('groups services per project and drops repeats', () => {
    expect(
      groupByProject([
        { project: 'alpha', service: 'redmine' },
        { project: 'beta', service: 'slack' },
        { project: 'alpha', service: 'slack' },
        { project: 'alpha', service: 'redmine' },
      ])
    ).toEqual([
      { project: 'alpha', services: ['redmine', 'slack'] },
      { project: 'beta', services: ['slack'] },
    ]);
  });
});
