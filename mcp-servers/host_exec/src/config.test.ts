import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildArgv,
  findRecipe,
  HostExecToolError,
  readConfigSnapshot,
  resolveCwd,
  validateSuppliedParams,
} from './config.js';
import type { HostExecConfigSnapshot, HostExecRecipe } from './types.js';

function recipe(
  partial: Partial<HostExecRecipe> & Pick<HostExecRecipe, 'name' | 'exec'>
): HostExecRecipe {
  return { args: [], confirm: 'ask', ...partial };
}

describe('readConfigSnapshot', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-exec-cfg-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads a well-formed snapshot', async () => {
    const snap: HostExecConfigSnapshot = {
      projectDir: dir,
      commands: [recipe({ name: 'test', exec: './gradlew', args: ['test'] })],
    };
    const p = path.join(dir, 'config.json');
    await fs.writeFile(p, JSON.stringify(snap), 'utf-8');
    const got = await readConfigSnapshot(p);
    expect(got.projectDir).toBe(dir);
    expect(got.commands).toHaveLength(1);
    expect(got.commands[0].name).toBe('test');
  });

  it('throws (fatal) when the file is missing', async () => {
    await expect(readConfigSnapshot(path.join(dir, 'nope.json'))).rejects.toThrow(
      /cannot read config snapshot/
    );
  });

  it('throws when the file is not valid JSON', async () => {
    const p = path.join(dir, 'config.json');
    await fs.writeFile(p, '{ not json', 'utf-8');
    await expect(readConfigSnapshot(p)).rejects.toThrow(/not valid JSON/);
  });

  it('throws when the shape is wrong', async () => {
    const p = path.join(dir, 'config.json');
    await fs.writeFile(p, JSON.stringify({ projectDir: 123, commands: 'no' }), 'utf-8');
    await expect(readConfigSnapshot(p)).rejects.toThrow(/wrong shape/);
    await fs.writeFile(p, JSON.stringify({ commands: [] }), 'utf-8');
    await expect(readConfigSnapshot(p)).rejects.toThrow(/wrong shape/);
    await fs.writeFile(p, JSON.stringify(['array']), 'utf-8');
    await expect(readConfigSnapshot(p)).rejects.toThrow(/wrong shape/);
  });
});

describe('findRecipe', () => {
  it('finds by name; returns undefined for an unknown recipe', () => {
    const snap: HostExecConfigSnapshot = {
      projectDir: '/p',
      commands: [
        recipe({ name: 'test', exec: './gradlew' }),
        recipe({ name: 'build', exec: './gradlew' }),
      ],
    };
    expect(findRecipe(snap, 'build')?.name).toBe('build');
    expect(findRecipe(snap, 'nope')).toBeUndefined();
  });
});

describe('validateSuppliedParams', () => {
  it('accepts a value matching the (anchored) pattern', () => {
    const r = recipe({
      name: 'psql',
      exec: 'docker',
      args: ['psql', '-c', '{sql}'],
      params: [{ name: 'sql', pattern: 'SELECT .{0,200}' }],
    });
    const m = validateSuppliedParams(r, { sql: 'SELECT * FROM users LIMIT 1' });
    expect(m.get('sql')).toBe('SELECT * FROM users LIMIT 1');
  });

  it('rejects a value that does not fully match (anchoring matters)', () => {
    const r = recipe({
      name: 'x',
      exec: './t',
      args: ['{p}'],
      params: [{ name: 'p', pattern: 'abc' }],
    });
    expect(() => validateSuppliedParams(r, { p: 'abc; rm -rf /' })).toThrow(HostExecToolError);
    expect(() => validateSuppliedParams(r, { p: 'xabc' })).toThrow(HostExecToolError);
    expect(() => validateSuppliedParams(r, { p: 'abc' })).not.toThrow();
  });

  it('rejects a missing or non-string parameter', () => {
    const r = recipe({
      name: 'x',
      exec: './t',
      args: ['{p}'],
      params: [{ name: 'p', pattern: '.*' }],
    });
    expect(() => validateSuppliedParams(r, {})).toThrow(/required and must be a string/);
    expect(() => validateSuppliedParams(r, { p: 123 })).toThrow(/required and must be a string/);
  });

  it('rejects an unexpected parameter key', () => {
    const r = recipe({ name: 'x', exec: './t', args: [], params: [] });
    expect(() => validateSuppliedParams(r, { surprise: 'v' })).toThrow(
      /does not accept a parameter named 'surprise'/
    );
  });

  it('enforces maxLen (and the default ceiling)', () => {
    const r = recipe({
      name: 'x',
      exec: './t',
      args: ['{p}'],
      params: [{ name: 'p', pattern: '.*', maxLen: 5 }],
    });
    expect(() => validateSuppliedParams(r, { p: 'abcdef' })).toThrow(/too long/);
    expect(() => validateSuppliedParams(r, { p: 'abcde' })).not.toThrow();
  });

  it('treats an uncompilable pattern as a tool error', () => {
    const r = recipe({
      name: 'x',
      exec: './t',
      args: ['{p}'],
      params: [{ name: 'p', pattern: '([' }],
    });
    expect(() => validateSuppliedParams(r, { p: 'anything' })).toThrow(/invalid regex pattern/);
  });

  it('returns an empty map for a recipe with no params', () => {
    const r = recipe({ name: 'x', exec: './t', args: ['fixed'] });
    expect(validateSuppliedParams(r, {}).size).toBe(0);
  });
});

describe('buildArgv', () => {
  it('substitutes parameters as single argv elements (never re-split)', () => {
    const r = recipe({
      name: 'psql',
      exec: 'docker',
      args: ['compose', 'exec', '-T', 'db', 'psql', '-c', '{sql}'],
    });
    const argv = buildArgv(r, new Map([['sql', 'SELECT 1; DROP TABLE x']]));
    expect(argv).toEqual(['compose', 'exec', '-T', 'db', 'psql', '-c', 'SELECT 1; DROP TABLE x']);
  });
  it('substitutes a token embedded in a larger arg', () => {
    const r = recipe({ name: 't', exec: './gradlew', args: ['test', '--tests', '{cls}'] });
    expect(buildArgv(r, new Map([['cls', 'com.x.Y']]))).toEqual(['test', '--tests', 'com.x.Y']);
  });
  it('leaves an unknown {token} as a literal', () => {
    const r = recipe({ name: 't', exec: './t', args: ['{notdeclared}'] });
    expect(buildArgv(r, new Map())).toEqual(['{notdeclared}']);
  });
  it('handles multiple tokens in one arg', () => {
    const r = recipe({ name: 't', exec: './t', args: ['{a}-{b}'] });
    expect(
      buildArgv(
        r,
        new Map([
          ['a', 'x'],
          ['b', 'y'],
        ])
      )
    ).toEqual(['x-y']);
  });
});

describe('resolveCwd', () => {
  let proj: string;
  let outside: string;
  beforeEach(async () => {
    proj = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'host-exec-proj-')));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'host-exec-out-')));
    await fs.mkdir(path.join(proj, 'frontend'));
    await fs.mkdir(path.join(proj, 'services', 'api'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(proj, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('returns the project dir and "." with no cwdSub', async () => {
    const { cwd, label } = await resolveCwd(proj, recipe({ name: 't', exec: './t' }));
    expect(cwd).toBe(proj);
    expect(label).toBe('.');
  });

  it('resolves a valid subdirectory', async () => {
    const { cwd, label } = await resolveCwd(
      proj,
      recipe({ name: 't', exec: './t', cwdSub: 'frontend' })
    );
    expect(cwd).toBe(path.join(proj, 'frontend'));
    expect(label).toBe('frontend');
    const nested = await resolveCwd(
      proj,
      recipe({ name: 't', exec: './t', cwdSub: 'services/api' })
    );
    expect(nested.cwd).toBe(path.join(proj, 'services', 'api'));
    // A leading `./` produces a `.` segment that the symlink walk must skip.
    const dotted = await resolveCwd(proj, recipe({ name: 't', exec: './t', cwdSub: './frontend' }));
    expect(dotted.cwd).toBe(path.join(proj, 'frontend'));
    expect(dotted.label).toBe('./frontend');
  });

  it('rejects a cwdSub that does not exist', async () => {
    await expect(
      resolveCwd(proj, recipe({ name: 't', exec: './t', cwdSub: 'nope' }))
    ).rejects.toThrow(HostExecToolError);
  });

  it('rejects a cwdSub that is a file, not a directory', async () => {
    await fs.writeFile(path.join(proj, 'afile'), 'x');
    await expect(
      resolveCwd(proj, recipe({ name: 't', exec: './t', cwdSub: 'afile' }))
    ).rejects.toThrow(/not a directory/);
  });

  it('rejects an absolute cwdSub even though the Rust side should have', async () => {
    await expect(
      resolveCwd(proj, recipe({ name: 't', exec: './t', cwdSub: outside }))
    ).rejects.toThrow(/relative path with no/);
  });

  it('rejects a cwdSub containing ".."', async () => {
    await expect(
      resolveCwd(proj, recipe({ name: 't', exec: './t', cwdSub: '../escape' }))
    ).rejects.toThrow(/relative path with no/);
  });

  it('rejects a symlink that points outside the project (realpath escape)', async () => {
    // proj/link -> outside
    await fs.symlink(outside, path.join(proj, 'link'), 'dir');
    await expect(
      resolveCwd(proj, recipe({ name: 't', exec: './t', cwdSub: 'link' }))
    ).rejects.toThrow(/resolves outside the project directory|must not traverse a symlink/);
  });

  it('rejects a symlink that points back inside the project (no symlink traversal allowed at all)', async () => {
    // proj/link -> proj/frontend  (realpath stays inside, but it's a symlink)
    await fs.symlink(path.join(proj, 'frontend'), path.join(proj, 'inlink'), 'dir');
    await expect(
      resolveCwd(proj, recipe({ name: 't', exec: './t', cwdSub: 'inlink' }))
    ).rejects.toThrow(/must not traverse a symlink/);
  });

  it('rejects when the project directory itself does not exist', async () => {
    await expect(
      resolveCwd(path.join(proj, 'gone'), recipe({ name: 't', exec: './t' }))
    ).rejects.toThrow(HostExecToolError);
  });
});
