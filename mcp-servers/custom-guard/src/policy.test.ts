import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definitionHash } from '@speedwave/mcp-shared';
import { createPolicyStore, MAX_POLICY_BYTES, parseGuardPolicy, POLICY_VERSION } from './policy.js';

const expected = { service: 'custom-figma', mode: 'npm' as const };
const getFile = { name: 'get_file', description: 'Fetch a file', inputSchema: { type: 'object' } };
const hash = definitionHash(getFile);

function policyDoc(tools: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { version: POLICY_VERSION, service: 'custom-figma', mode: 'npm', tools, ...extra };
}

describe('parseGuardPolicy', () => {
  it('parses tool decisions, limits and guard-only options', () => {
    const policy = parseGuardPolicy(
      policyDoc(
        {
          get_file: {
            state: 'allowed',
            defHash: hash,
            exposedName: 'get_file',
            definition: getFile,
            deferLoading: false,
            timeoutClass: 'long',
          },
          post_comment: { state: 'pending', defHash: hash },
        },
        { maxResultBytes: 1000, consentDigest: 'ignored', maxDescriptionBytes: 1024 }
      ),
      expected
    );
    expect(policy.maxResultBytes).toBe(1000);
    expect(policy.tools.get('get_file')).toEqual({
      state: 'allowed',
      defHash: hash,
      exposedName: 'get_file',
    });
    expect(policy.toolOptions.get('get_file')).toEqual({
      definition: getFile,
      deferLoading: false,
      timeoutClass: 'long',
    });
    expect(policy.toolOptions.get('post_comment')).toEqual({});
  });

  it('accepts an empty tool map', () => {
    expect(parseGuardPolicy(policyDoc({}), expected).tools.size).toBe(0);
  });

  it.each([
    ['not an object', [], /JSON object/],
    ['missing version', { ...policyDoc({}), version: undefined }, /version must be 1/],
    ['future version', { ...policyDoc({}), version: 2 }, /version must be 1/],
    ['other service', { ...policyDoc({}), service: 'custom-other' }, /another service/],
    ['other mode', { ...policyDoc({}), mode: 'host' }, /another mode/],
    ['no tools', { ...policyDoc({}), tools: undefined }, /"tools" object/],
    ['bad state', policyDoc({ a: { state: 'changed', defHash: hash } }), /invalid state/],
    [
      'definition named differently',
      policyDoc({ get_file: { state: 'allowed', defHash: hash, definition: { name: 'x' } } }),
      /named like its entry/,
    ],
    [
      'definition not an object',
      policyDoc({ get_file: { state: 'allowed', defHash: hash, definition: 'x' } }),
      /named like its entry/,
    ],
    [
      'deferLoading not a boolean',
      policyDoc({ get_file: { state: 'allowed', defHash: hash, deferLoading: 'no' } }),
      /deferLoading must be a boolean/,
    ],
    [
      'unknown timeout class',
      policyDoc({ get_file: { state: 'allowed', defHash: hash, timeoutClass: 'forever' } }),
      /standard or long/,
    ],
  ])('rejects %s', (_label, raw, message) => {
    expect(() => parseGuardPolicy(raw, expected)).toThrow(message);
  });
});

describe('createPolicyStore', () => {
  let dir: string;
  let file: string;
  let warn: ReturnType<typeof vi.spyOn>;

  function writeAtomic(content: string): void {
    const tmp = join(dir, `.policy.json.tmp.${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guard-policy-'));
    file = join(dir, 'policy.json');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null while no policy was ever loaded', () => {
    const store = createPolicyStore(file, expected);
    expect(store.current()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('denying every tool');
    store.current();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('picks up a rewritten policy without a restart', () => {
    const store = createPolicyStore(file, expected);
    writeAtomic(JSON.stringify(policyDoc({ get_file: { state: 'allowed', defHash: hash } })));
    expect(store.current()?.tools.get('get_file')?.state).toBe('allowed');
    writeAtomic(JSON.stringify(policyDoc({ get_file: { state: 'blocked', defHash: hash } })));
    expect(store.current()?.tools.get('get_file')?.state).toBe('blocked');
  });

  it('serves the cached copy while the file is unchanged', () => {
    const store = createPolicyStore(file, expected);
    writeAtomic(JSON.stringify(policyDoc({})));
    const first = store.current();
    expect(store.current()).toBe(first);
  });

  it('keeps the last good policy when the new file is torn or invalid', () => {
    const store = createPolicyStore(file, expected);
    writeAtomic(JSON.stringify(policyDoc({ get_file: { state: 'allowed', defHash: hash } })));
    const good = store.current();
    writeAtomic('{"version":1,"service":"custom-fi');
    expect(store.current()).toBe(good);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('not valid JSON');
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('keeping the last valid policy');
    writeAtomic(JSON.stringify(policyDoc({ get_file: { state: 'sideways', defHash: hash } })));
    expect(store.current()).toBe(good);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('invalid state');
  });

  it('never echoes policy contents in a warning', () => {
    const store = createPolicyStore(file, expected);
    writeAtomic('{"secret-looking-content": ');
    store.current();
    expect(String(warn.mock.calls.at(-1)?.[0])).not.toContain('secret-looking-content');
  });

  it('denies every tool once the file disappears, even after a valid load', () => {
    const store = createPolicyStore(file, expected);
    writeAtomic(JSON.stringify(policyDoc({ get_file: { state: 'allowed', defHash: hash } })));
    expect(store.current()).not.toBeNull();
    unlinkSync(file);
    expect(store.current()).toBeNull();
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('cannot be read; denying every tool');
    expect(store.current()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to a policy loaded before the file went missing', () => {
    const store = createPolicyStore(file, expected);
    writeAtomic(JSON.stringify(policyDoc({ get_file: { state: 'allowed', defHash: hash } })));
    store.current();
    unlinkSync(file);
    store.current();
    writeAtomic('{"version":1,"service":"custom-fi');
    expect(store.current()).toBeNull();
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('denying every tool');
    writeAtomic(JSON.stringify(policyDoc({ get_file: { state: 'blocked', defHash: hash } })));
    expect(store.current()?.tools.get('get_file')?.state).toBe('blocked');
    unlinkSync(file);
    expect(store.current()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('rejects an oversized policy file', () => {
    const store = createPolicyStore(file, expected);
    writeAtomic(' '.repeat(MAX_POLICY_BYTES + 1));
    expect(store.current()).toBeNull();
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('larger than');
  });

  it('reads only the exact policy file and ignores in-flight tmp siblings', () => {
    const store = createPolicyStore(file, expected);
    writeFileSync(
      join(dir, '.policy.json.tmp.12345'),
      JSON.stringify(policyDoc({ get_file: { state: 'allowed', defHash: hash } }))
    );
    expect(store.current()).toBeNull();
    writeFileSync(
      file,
      JSON.stringify(policyDoc({ get_file: { state: 'blocked', defHash: hash } }))
    );
    expect(store.current()?.tools.get('get_file')?.state).toBe('blocked');
  });

  it('rejects a policy written for another server', () => {
    const store = createPolicyStore(file, expected);
    writeAtomic(JSON.stringify({ ...policyDoc({}), service: 'custom-other' }));
    expect(store.current()).toBeNull();
  });
});
