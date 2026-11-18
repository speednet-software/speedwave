import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadAccessRules,
  parseAccessRules,
  type AccessRules,
  type ReadRetry,
} from './access-config.js';

interface WrittenFile {
  name: string;
  policy: AccessRules;
  text: string;
}

const WRITTEN: WrittenFile[] = JSON.parse(
  readFileSync(
    new URL(
      '../../../crates/access-policy/tests/fixtures/written-access-files.json',
      import.meta.url
    ),
    'utf8'
  )
);

describe('parseAccessRules', () => {
  it('reads the files the host writes', () => {
    expect(WRITTEN.length).toBeGreaterThan(0);
  });

  it.each(WRITTEN.map((f) => [f.name, f] as const))('reads the written file: %s', (_name, f) => {
    expect(parseAccessRules(f.text)).toEqual(f.policy);
  });

  it('takes a missing default and services as full', () => {
    expect(parseAccessRules('{"version":1}')).toEqual({ default: 'full', services: {} });
  });

  it('keeps every service name the host wrote', () => {
    expect(
      parseAccessRules('{"version":1,"services":{"Not A Slug":"read_only","constructor":"full"}}')
        .services
    ).toEqual({ 'Not A Slug': 'read_only', constructor: 'full' });
  });

  it('has no inherited entries, so an object property name is not a mode', () => {
    const rules = parseAccessRules('{"version":1,"default":"read_only"}');
    expect(rules.services['constructor']).toBeUndefined();
    expect(rules.services['toString']).toBeUndefined();
  });

  it.each([
    ['an unknown default mode', '{"version":1,"default":"confirm"}'],
    ['an unknown service mode', '{"version":1,"services":{"slack":"confirm"}}'],
    ['a mode of the wrong type', '{"version":1,"services":{"slack":true}}'],
    ['an unknown top-level key', '{"version":1,"confirm":{}}'],
    ['a missing version', '{"default":"full"}'],
    ['an unsupported version', '{"version":2}'],
    ['a version of the wrong type', '{"version":"1"}'],
    ['services as an array', '{"version":1,"services":[]}'],
    ['services as null', '{"version":1,"services":null}'],
    ['a top-level array', '[]'],
    ['a top-level null', 'null'],
    ['text that is not JSON', '{"version":1'],
    ['an empty file', ''],
  ])('rejects %s', (_name, text) => {
    expect(() => parseAccessRules(text)).toThrow();
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

  it('throws without POLICY_FILE, so a hub started without its policy directory never opens every service', () => {
    expect(() => loadAccessRules({})).toThrow(/POLICY_FILE is not set/);
  });

  const ONE_READ: ReadRetry = { attempts: 1, delayMs: 0 };

  it('throws when the policy directory has no access.json, so a missing file never opens every service', () => {
    const d = policyDir();
    expect(() => loadAccessRules({ POLICY_FILE: join(d, 'policy.json') }, ONE_READ)).toThrow(
      /access\.json is invalid: file not found after 1 reads/
    );
  });

  it('reads a missing access.json again before it gives up', () => {
    const d = policyDir();
    const started = Date.now();
    expect(() =>
      loadAccessRules({ POLICY_FILE: join(d, 'policy.json') }, { attempts: 3, delayMs: 20 })
    ).toThrow(/file not found after 3 reads/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it('reads an access.json that appears while it retries', async () => {
    const d = policyDir();
    const file = join(d, 'access.json');
    const writer = spawn(process.execPath, [
      '-e',
      `setTimeout(() => require('fs').writeFileSync(process.argv[1], '{"version":1,"default":"read_only"}'), 100)`,
      file,
    ]);
    const exited = new Promise((resolve) => writer.once('exit', resolve));
    await new Promise((resolve) => writer.once('spawn', resolve));
    expect(
      loadAccessRules({ POLICY_FILE: join(d, 'policy.json') }, { attempts: 100, delayMs: 50 })
    ).toEqual({ default: 'read_only', services: {} });
    await exited;
  });

  it('reads an all-full access.json', () => {
    const d = policyDir();
    writeFileSync(join(d, 'access.json'), '{"version":1,"default":"full","services":{}}');
    expect(loadAccessRules({ POLICY_FILE: join(d, 'policy.json') }, ONE_READ)).toEqual(FULL);
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
    expect(() => loadAccessRules({ POLICY_FILE: join(d, 'policy.json') }, ONE_READ)).toThrow(
      /access\.json is invalid/
    );
  });
});

describe('getAccessRules', () => {
  let dir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads access.json when loadAccess has not run, so a missed startup call does not open every service', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-access-rules-'));
    writeFileSync(join(dir, 'access.json'), '{"version":1,"default":"read_only"}');
    vi.stubEnv('POLICY_FILE', join(dir, 'policy.json'));
    vi.resetModules();

    const { getAccessRules } = await import('./access-config.js');

    expect(getAccessRules()).toEqual({ default: 'read_only', services: {} });
  });
});
