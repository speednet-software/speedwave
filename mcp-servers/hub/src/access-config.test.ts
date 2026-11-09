import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAccessRules, parseAccessRules, type AccessRules } from './access-config.js';

interface FixtureCase {
  name: string;
  text?: string;
  generate?: { services?: number; padding?: number };
  expected?: AccessRules;
  expected_service_count?: number;
  error?: boolean;
}

const CASES: FixtureCase[] = JSON.parse(
  readFileSync(
    new URL('../../../crates/access-policy/tests/fixtures/access-file-cases.json', import.meta.url),
    'utf8'
  )
);

function textOf(c: FixtureCase): string {
  if (c.text !== undefined) return c.text;
  if (c.generate?.services !== undefined) {
    const services = Object.fromEntries(
      Array.from({ length: c.generate.services }, (_, i) => [`svc${i}`, 'read_only'])
    );
    return JSON.stringify({ version: 1, services });
  }
  return `{"version":1}${' '.repeat(c.generate?.padding ?? 0)}`;
}

describe('parseAccessRules against the shared fixture cases', () => {
  it('reads the fixture file', () => {
    expect(CASES.length).toBeGreaterThan(0);
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    if (c.error) {
      expect(() => parseAccessRules(textOf(c))).toThrow();
    } else if (c.expected_service_count !== undefined) {
      expect(Object.keys(parseAccessRules(textOf(c)).services)).toHaveLength(
        c.expected_service_count
      );
    } else {
      expect(parseAccessRules(textOf(c))).toEqual(c.expected);
    }
  });
});

describe('loadAccessRules', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function policyDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'hub-access-config-'));
    return dir;
  }

  const FULL: AccessRules = { default: 'full', services: {} };

  it('is full for every service without POLICY_FILE', () => {
    expect(loadAccessRules({})).toEqual(FULL);
  });

  it('is full for every service when the policy directory has no access.json', () => {
    const d = policyDir();
    expect(loadAccessRules({ POLICY_FILE: join(d, 'policy.json') })).toEqual(FULL);
  });

  it('reads access.json from the directory of POLICY_FILE', () => {
    const d = policyDir();
    writeFileSync(
      join(d, 'access.json'),
      '{"version":1,"default":"read_only","services":{"slack":"full"}}'
    );
    expect(loadAccessRules({ POLICY_FILE: join(d, 'policy.json') })).toEqual({
      default: 'read_only',
      services: { slack: 'full' },
    });
  });

  it('throws on an invalid access.json, naming the file', () => {
    const d = policyDir();
    writeFileSync(join(d, 'access.json'), '{"version":1,"default":"confirm"}');
    expect(() => loadAccessRules({ POLICY_FILE: join(d, 'policy.json') })).toThrow(
      /access\.json is invalid/
    );
  });

  it('throws on an access.json that is not valid UTF-8', () => {
    const d = policyDir();
    writeFileSync(join(d, 'access.json'), Buffer.from([0x7b, 0xff, 0x7d]));
    expect(() => loadAccessRules({ POLICY_FILE: join(d, 'policy.json') })).toThrow(
      /access\.json is invalid/
    );
  });

  it('throws when access.json cannot be read', () => {
    const d = policyDir();
    mkdirSync(join(d, 'access.json'));
    expect(() => loadAccessRules({ POLICY_FILE: join(d, 'policy.json') })).toThrow(
      /access\.json is invalid/
    );
  });
});
