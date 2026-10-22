import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  _setServicePiiModesForTesting,
  loadServicePiiModes,
  parseServicePiiModes,
  piiModeFor,
} from './pii-mode.js';

let dir: string | undefined;

afterEach(() => {
  _setServicePiiModesForTesting(new Map());
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function policyFile(content: unknown): string {
  dir = mkdtempSync(join(tmpdir(), 'hub-pii-mode-'));
  const file = join(dir, 'policy.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

describe('piiModeFor defaults', () => {
  it('sends tokens to custom servers and plaintext to every other service', () => {
    expect(piiModeFor('custom-figma')).toBe('tokens');
    expect(piiModeFor('custom-a')).toBe('tokens');
    for (const service of ['slack', 'redmine', 'gitlab', 'os', 'my-plugin', 'customer', 'custom']) {
      expect(piiModeFor(service)).toBe('plaintext');
    }
  });

  it('lets an explicit entry win over the default in both directions', () => {
    _setServicePiiModesForTesting(
      new Map([
        ['custom-figma', 'plaintext'],
        ['slack', 'tokens'],
      ])
    );
    expect(piiModeFor('custom-figma')).toBe('plaintext');
    expect(piiModeFor('slack')).toBe('tokens');
    expect(piiModeFor('custom-other')).toBe('tokens');
  });
});

describe('parseServicePiiModes', () => {
  it('reads every services entry', () => {
    const modes = parseServicePiiModes({
      version: 3,
      services: {
        'custom-figma': { pii_mode: 'plaintext' },
        'custom-linear': { pii_mode: 'tokens' },
      },
    });
    expect([...modes]).toEqual([
      ['custom-figma', 'plaintext'],
      ['custom-linear', 'tokens'],
    ]);
  });

  it.each([
    ['no services field', { version: 3 }],
    ['an empty services object', { version: 3, services: {} }],
    ['a non-object policy', 'x'],
    ['a null policy', null],
  ])('returns no entries for %s', (_label, policy) => {
    expect(parseServicePiiModes(policy).size).toBe(0);
  });

  it.each([
    ['services is an array', { services: [] }, /"services" must be an object/],
    ['services is null', { services: null }, /"services" must be an object/],
    ['unknown mode', { services: { 'custom-x': { pii_mode: 'redacted' } } }, /custom-x/],
    ['mode missing', { services: { 'custom-x': {} } }, /must be "tokens" or "plaintext"/],
    ['entry not an object', { services: { 'custom-x': 'plaintext' } }, /pii_mode/],
  ])('throws when %s', (_label, policy, message) => {
    expect(() => parseServicePiiModes(policy)).toThrow(message);
  });
});

describe('loadServicePiiModes', () => {
  it('loads explicit modes from POLICY_FILE', () => {
    const file = policyFile({ services: { 'custom-figma': { pii_mode: 'plaintext' } } });
    loadServicePiiModes({ POLICY_FILE: file });
    expect(piiModeFor('custom-figma')).toBe('plaintext');
  });

  it('falls back to the defaults when POLICY_FILE is unset or missing', () => {
    _setServicePiiModesForTesting(new Map([['custom-figma', 'plaintext']]));
    loadServicePiiModes({});
    expect(piiModeFor('custom-figma')).toBe('tokens');

    _setServicePiiModesForTesting(new Map([['custom-figma', 'plaintext']]));
    loadServicePiiModes({ POLICY_FILE: join(tmpdir(), 'no-such-dir', 'policy.json') });
    expect(piiModeFor('custom-figma')).toBe('tokens');
  });

  it('throws (fail-closed) on a malformed policy or services field', () => {
    expect(() => loadServicePiiModes({ POLICY_FILE: policyFile('{not json') })).toThrow();
    rmSync(dir as string, { recursive: true, force: true });
    expect(() =>
      loadServicePiiModes({
        POLICY_FILE: policyFile({ services: { 'custom-x': { pii_mode: 1 } } }),
      })
    ).toThrow(/pii_mode/);
  });
});
