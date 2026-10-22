import { describe, it, expect } from 'vitest';
import {
  createWorkspacePathMapper,
  isPathLikeProperty,
  WORKSPACE_ROOT,
  CONTAINER_HOME,
  type PathStyle,
} from './workspace-paths.js';

const posix = createWorkspacePathMapper({ hostDir: '/Users/kamil/proj', style: 'posix' });
const windows = createWorkspacePathMapper({ hostDir: 'C:\\Users\\Kamil\\proj', style: 'windows' });
const unc = createWorkspacePathMapper({
  hostDir: '\\\\wsl.localhost\\Ubuntu\\home\\kamil\\proj',
  style: 'unc',
});

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

describe('constants', () => {
  it('names the container mount and home', () => {
    expect(WORKSPACE_ROOT).toBe('/workspace');
    expect(CONTAINER_HOME).toBe('/home/speedwave');
  });
});

describe('createWorkspacePathMapper validation', () => {
  it.each<[PathStyle, string, RegExp]>([
    ['posix', 'relative/dir', /must be absolute/],
    ['posix', '/', /root/],
    ['posix', '', /must be absolute/],
    ['windows', '/Users/x', /drive/],
    ['windows', 'C:\\', /drive root/],
    ['unc', 'C:\\x', /wsl/],
    ['unc', '\\\\server\\share\\x', /wsl/],
    ['unc', '\\\\wsl.localhost\\Ubuntu', /inside a WSL distribution/],
  ])('rejects %s hostDir %j', (style, hostDir, message) => {
    expect(() => createWorkspacePathMapper({ hostDir, style })).toThrow(message);
  });

  it('accepts trailing separators and forward slashes on Windows', () => {
    const m = createWorkspacePathMapper({ hostDir: 'C:/Users/Kamil/proj/', style: 'windows' });
    expect(m.toHostPath('/workspace/a')).toBe('C:\\Users\\Kamil\\proj\\a');
    const p = createWorkspacePathMapper({ hostDir: '/Users/kamil/proj//', style: 'posix' });
    expect(p.toHostPath('/workspace')).toBe('/Users/kamil/proj');
  });
});

describe('classify', () => {
  it.each([
    ['/workspace', 'ok-workspace'],
    ['/workspace/', 'ok-workspace'],
    ['/workspace/src/a.ts', 'ok-workspace'],
    ['/workspace/a/../b', 'ok-workspace'],
    ['/workspace/./a', 'ok-workspace'],
    ['file:///workspace/a%20b.txt', 'ok-workspace'],
    ['file:///workspace', 'ok-workspace'],
    ['file:workspace/x', 'ok-workspace'],
    ['/workspace/..', 'refuse-escape'],
    ['/workspace/../etc/passwd', 'refuse-escape'],
    ['/workspace/a/../../..', 'refuse-escape'],
    ['file:///workspace/%2e%2e/etc', 'refuse-escape'],
    ['file:///workspace/../tmp/x', 'refuse-escape'],
    ['file:///workspace/a%2Fb', 'refuse-escape'],
    ['/etc/../workspace/x', 'refuse-escape'],
    ['/etc/../tmp/x', 'refuse-escape'],
    ['/a/../home/speedwave/.ssh', 'refuse-escape'],
    ['/tmp', 'refuse-tmp'],
    ['/tmp/out.png', 'refuse-tmp'],
    ['file:///tmp/out.png', 'refuse-tmp'],
    ['/home/speedwave', 'refuse-home'],
    ['/home/speedwave/.claude/x', 'refuse-home'],
    ['/workspacefoo/x', 'passthrough'],
    ['/tmpfile', 'passthrough'],
    ['/home/speedwaver/x', 'passthrough'],
    ['/home', 'passthrough'],
    ['/Users/other/file', 'passthrough'],
    ['/../..', 'passthrough'],
    ['file://server/share/x', 'passthrough'],
    ['https://example.com/workspace/x', 'passthrough'],
    ['relative/path', 'passthrough'],
    ['', 'passthrough'],
    ['zażółć', 'passthrough'],
  ])('%j -> %s', (value, expected) => {
    expect(posix.classify(value)).toBe(expected);
  });

  it.each([
    ['src/a.ts', 'refuse-relative'],
    ['./a', 'refuse-relative'],
    ['../a', 'refuse-relative'],
    ['plik ąę.txt', 'refuse-relative'],
    ['~/notes.md', 'refuse-home'],
    ['~', 'refuse-home'],
    ['', 'passthrough'],
    ['https://example.com/a', 'passthrough'],
    ['s3://bucket/key', 'passthrough'],
    ['/workspace/src/a.ts', 'ok-workspace'],
    ['file:///workspace/a.txt', 'ok-workspace'],
    ['/tmp/x', 'refuse-tmp'],
    ['/home/speedwave/x', 'refuse-home'],
    ['/workspace/../etc', 'refuse-escape'],
    ['/abs/elsewhere', 'refuse-outside-workspace'],
    ['/Users/x/.ssh/id_rsa', 'refuse-outside-workspace'],
    ['/../..', 'refuse-outside-workspace'],
    ['C:\\Users\\x', 'refuse-outside-workspace'],
    ['C:/Users/x/.ssh/id_rsa', 'refuse-outside-workspace'],
    ['c:relative', 'refuse-outside-workspace'],
    ['\\\\server\\share', 'refuse-outside-workspace'],
    ['\\rooted\\x', 'refuse-outside-workspace'],
    ['file:///etc/passwd', 'refuse-outside-workspace'],
    ['file://server/share/x', 'refuse-outside-workspace'],
    ['FILE:///Users/x/.ssh/id_rsa', 'refuse-outside-workspace'],
  ])('path-like %j -> %s', (value, expected) => {
    expect(posix.classify(value, true)).toBe(expected);
  });

  it('treats backslashes as separators only for a Windows host', () => {
    expect(posix.classify('/workspace/a\\..\\..\\x')).toBe('ok-workspace');
    expect(windows.classify('/workspace/a\\..\\..\\x')).toBe('refuse-escape');
    expect(windows.classify('/workspace/a\\..\\b')).toBe('ok-workspace');
  });

  it('confines path-like values on every host style', () => {
    for (const mapper of [windows, unc]) {
      expect(mapper.classify('C:\\Users\\Kamil\\proj\\a', true)).toBe('refuse-outside-workspace');
      expect(mapper.classify('\\\\wsl.localhost\\Ubuntu\\etc', true)).toBe(
        'refuse-outside-workspace'
      );
      expect(mapper.classify('/workspace/a', true)).toBe('ok-workspace');
      expect(mapper.classify('C:\\Users\\x')).toBe('passthrough');
    }
  });

  it('refuses dot-and-space segments a Windows host would collapse', () => {
    expect(windows.classify('/workspace/.. /x')).toBe('refuse-escape');
    expect(windows.classify('/workspace/.../x')).toBe('refuse-escape');
    expect(unc.classify('/workspace/x/. ')).toBe('refuse-escape');
    expect(posix.classify('/workspace/.../x')).toBe('ok-workspace');
  });
});

describe('toHostPath', () => {
  it('maps the root and nested paths for every style', () => {
    expect(posix.toHostPath('/workspace')).toBe('/Users/kamil/proj');
    expect(posix.toHostPath('/workspace/src/a b.ts')).toBe('/Users/kamil/proj/src/a b.ts');
    expect(windows.toHostPath('/workspace/src/a.ts')).toBe('C:\\Users\\Kamil\\proj\\src\\a.ts');
    expect(unc.toHostPath('/workspace/src/ąę.ts')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\kamil\\proj\\src\\ąę.ts'
    );
  });

  it('normalizes dot segments instead of passing them to the host', () => {
    expect(posix.toHostPath('/workspace/a/./b/../c')).toBe('/Users/kamil/proj/a/c');
  });

  it('returns null for anything outside /workspace and for file URLs', () => {
    expect(posix.toHostPath('/workspace/../x')).toBeNull();
    expect(posix.toHostPath('/tmp/x')).toBeNull();
    expect(posix.toHostPath('relative')).toBeNull();
    expect(posix.toHostPath('file:///workspace/x')).toBeNull();
  });
});

describe('toWorkspacePath', () => {
  it('maps host paths inside the project', () => {
    expect(posix.toWorkspacePath('/Users/kamil/proj')).toBe('/workspace');
    expect(posix.toWorkspacePath('/Users/kamil/proj/')).toBe('/workspace');
    expect(posix.toWorkspacePath('/Users/kamil/proj/src/a.ts')).toBe('/workspace/src/a.ts');
    expect(windows.toWorkspacePath('c:/users/kamil/PROJ/src\\a.ts')).toBe('/workspace/src/a.ts');
    expect(unc.toWorkspacePath('\\\\wsl$\\Ubuntu\\home\\kamil\\proj\\x')).toBe('/workspace/x');
  });

  it('rejects sibling directories sharing a prefix and other paths', () => {
    expect(posix.toWorkspacePath('/Users/kamil/proj2/a')).toBeNull();
    expect(posix.toWorkspacePath('/Users/kamil')).toBeNull();
    expect(posix.toWorkspacePath('/USERS/kamil/proj')).toBeNull();
    expect(windows.toWorkspacePath('D:\\Users\\Kamil\\proj')).toBeNull();
  });
});

describe('rewriteArgs', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      query: { type: 'string' },
      target: { type: 'string', format: 'uri' },
      files: { type: 'array', items: { type: 'string' } },
      options: { type: 'object', properties: { outputDir: { type: 'string' } } },
    },
  };

  it('rewrites every /workspace leaf and leaves other values untouched', () => {
    const result = posix.rewriteArgs(
      {
        path: '/workspace/a.txt',
        query: 'find /workspace/b in text',
        target: 'file:///workspace/My%20File.txt',
        files: ['/workspace/x', '/workspace'],
        options: { outputDir: '/workspace/out', count: 3, flag: true, none: null },
        note: '/workspace/n',
      },
      schema
    );
    expect(result).toEqual({
      ok: true,
      args: {
        path: '/Users/kamil/proj/a.txt',
        query: 'find /workspace/b in text',
        target: 'file:///Users/kamil/proj/My%20File.txt',
        files: ['/Users/kamil/proj/x', '/Users/kamil/proj'],
        options: { outputDir: '/Users/kamil/proj/out', count: 3, flag: true, none: null },
        note: '/Users/kamil/proj/n',
      },
    });
  });

  it('builds Windows and UNC host file URLs', () => {
    const win = windows.rewriteArgs({ uri: 'file:///workspace/a b.txt' });
    expect(win).toEqual({ ok: true, args: { uri: 'file:///C:/Users/Kamil/proj/a%20b.txt' } });
    const wsl = unc.rewriteArgs({ uri: 'file:///workspace/a.txt' });
    expect(wsl).toEqual({
      ok: true,
      args: { uri: 'file://wsl.localhost/Ubuntu/home/kamil/proj/a.txt' },
    });
  });

  it('does not mutate the input and handles empty args', () => {
    const args = { path: '/workspace/a' };
    posix.rewriteArgs(args, schema);
    expect(args).toEqual({ path: '/workspace/a' });
    expect(posix.rewriteArgs({}, schema)).toEqual({ ok: true, args: {} });
    expect(posix.rewriteArgs({ path: '/workspace/a', list: ['/workspace/b', 1] })).toEqual({
      ok: true,
      args: { path: '/Users/kamil/proj/a', list: ['/Users/kamil/proj/b', 1] },
    });
  });

  it('keeps a __proto__ argument as plain data', () => {
    const args = JSON.parse('{"__proto__":{"path":"/workspace/x"}}') as Record<string, unknown>;
    const result = posix.rewriteArgs(args);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.getPrototypeOf(result.args)).toBe(Object.prototype);
      expect(Object.keys(result.args)).toEqual(['__proto__']);
    }
  });

  it.each([
    ['/tmp/x.png', 'path', 'refuse-tmp', '/tmp'],
    ['/home/speedwave/x', 'path', 'refuse-home', '/home/speedwave'],
    ['/workspace/../../etc/passwd', 'path', 'refuse-escape', 'leaves /workspace'],
    ['src/secret-value.ts', 'path', 'refuse-relative', 'absolute path under /workspace'],
    ['/Users/x/.ssh/id_rsa', 'path', 'refuse-outside-workspace', 'only receive paths inside'],
    ['C:\\Users\\x\\secret.txt', 'path', 'refuse-outside-workspace', 'under /workspace'],
    ['\\\\host\\share\\secret', 'path', 'refuse-outside-workspace', 'under /workspace'],
    ['file:///etc/passwd', 'target', 'refuse-outside-workspace', 'under /workspace'],
  ])('refuses %j and never echoes it', (value, param, reason, hint) => {
    const result = posix.rewriteArgs({ [param]: value }, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(reason);
      expect(result.param).toBe(param);
      const message = textOf(result.error);
      expect(message).toContain(`Invalid ${param}.`);
      expect(message).toContain(hint);
      expect(message).not.toContain(value);
      expect(result.error.isError).toBe(true);
    }
  });

  it('names nested and array parameters in the refusal', () => {
    const nested = posix.rewriteArgs({ options: { outputDir: 'out' } }, schema);
    expect(nested.ok === false && nested.param).toBe('options.outputDir');
    const listed = posix.rewriteArgs({ files: ['/workspace/a', '/tmp/b'] }, schema);
    expect(listed.ok === false && listed.param).toBe('files[1]');
  });

  it('allows relative values for properties that are not path-like', () => {
    expect(posix.rewriteArgs({ query: 'src/a.ts' }, schema)).toEqual({
      ok: true,
      args: { query: 'src/a.ts' },
    });
  });

  it('passes absolute host paths through in free-text properties', () => {
    const args = {
      query: '/Users/x/.ssh/id_rsa',
      note: 'see C:\\Users\\x and \\\\host\\share and file:///etc/passwd',
    };
    expect(posix.rewriteArgs(args, schema)).toEqual({ ok: true, args });
  });

  it('confines path-like array items and nested path-like properties', () => {
    const listed = posix.rewriteArgs({ files: ['/workspace/a', '/etc/shadow'] }, schema);
    expect(listed.ok === false && listed.param).toBe('files[1]');
    expect(listed.ok === false && listed.reason).toBe('refuse-outside-workspace');
    const nested = posix.rewriteArgs({ options: { outputDir: 'C:\\out' } }, schema);
    expect(nested.ok === false && nested.reason).toBe('refuse-outside-workspace');
  });

  it('refuses a relative value for a uri-format property', () => {
    const result = posix.rewriteArgs({ target: 'a.txt' }, schema);
    expect(result.ok === false && result.reason).toBe('refuse-relative');
  });

  it('stops descending past the depth limit', () => {
    let deep: Record<string, unknown> = { path: '/tmp/x' };
    for (let i = 0; i < 70; i++) deep = { a: deep };
    expect(posix.rewriteArgs(deep).ok).toBe(true);
  });

  it('rethrows unexpected errors', () => {
    const hostile = {
      get path(): string {
        throw new RangeError('boom');
      },
    };
    expect(() => posix.rewriteArgs(hostile)).toThrow(RangeError);
  });
});

describe('isPathLikeProperty', () => {
  it.each([
    ['path', true],
    ['paths', true],
    ['file', true],
    ['files', true],
    ['dir', true],
    ['folder', true],
    ['file_path', true],
    ['output-dir', true],
    ['config.file', true],
    ['filePath', true],
    ['outputDir', true],
    ['sourceFiles', true],
    ['FILE_PATH', true],
    ['profile', false],
    ['query', false],
    ['xpath', false],
    ['', false],
  ])('%j -> %s', (name, expected) => {
    expect(isPathLikeProperty(name)).toBe(expected);
  });

  it('honours format path and uri', () => {
    expect(isPathLikeProperty('target', { format: 'path' })).toBe(true);
    expect(isPathLikeProperty('target', { format: 'uri' })).toBe(true);
    expect(isPathLikeProperty('target', { format: 'date' })).toBe(false);
    expect(isPathLikeProperty('target', 'not-a-schema')).toBe(false);
  });
});

describe('rewriteResult', () => {
  it('hides the posix host directory only at path boundaries', () => {
    const out = posix.rewriteResult({
      content: [
        {
          type: 'text',
          text: 'Saved /Users/kamil/proj/out.png; sibling /Users/kamil/proj2/x; root /Users/kamil/proj. End',
        },
      ],
      structuredContent: {
        path: '/Users/kamil/proj',
        nested: ['/Users/kamil/proj/a', '/Users/kamil/projects', 'x/Users/kamil/proj/y'],
        url: 'file:///Users/kamil/proj/a.txt',
        backup: '/Users/kamil/proj.bak',
        n: 5,
        b: false,
        z: null,
      },
    });
    expect(out).toEqual({
      content: [
        {
          type: 'text',
          text: 'Saved /workspace/out.png; sibling /Users/kamil/proj2/x; root /workspace. End',
        },
      ],
      structuredContent: {
        path: '/workspace',
        nested: ['/workspace/a', '/Users/kamil/projects', 'x/Users/kamil/proj/y'],
        url: 'file:///workspace/a.txt',
        backup: '/Users/kamil/proj.bak',
        n: 5,
        b: false,
        z: null,
      },
    });
  });

  it('matches Windows paths case-insensitively with either separator, escaped or not', () => {
    const text = [
      'C:\\Users\\Kamil\\proj\\a.txt',
      'c:/users/kamil/PROJ/b.txt',
      JSON.stringify({ p: 'C:\\Users\\Kamil\\proj\\c.txt' }),
      'file:///C:/Users/Kamil/proj/d.txt',
      'file:///c:/USERS/kamil/proj',
      'C:\\Users\\Kamil\\project\\e.txt',
    ].join(' | ');
    expect(windows.rewriteResult(text)).toBe(
      [
        '/workspace\\a.txt',
        '/workspace/b.txt',
        '{"p":"/workspace\\\\c.txt"}',
        'file:///workspace/d.txt',
        'file:///workspace',
        'C:\\Users\\Kamil\\project\\e.txt',
      ].join(' | ')
    );
  });

  it('matches percent-encoded host file URLs', () => {
    const m = createWorkspacePathMapper({
      hostDir: 'C:\\Users\\Łukasz\\My Proj',
      style: 'windows',
    });
    expect(m.rewriteResult('file:///C:/Users/%C5%81ukasz/My%20Proj/a.txt')).toBe(
      'file:///workspace/a.txt'
    );
    expect(m.rewriteResult('file:///c:/users/%c5%81ukasz/my%20proj')).toBe('file:///workspace');
    const p = createWorkspacePathMapper({ hostDir: '/Users/a/My Proj #1', style: 'posix' });
    expect(
      p.rewriteResult('see file:///Users/a/My%20Proj%20%231/x and /Users/a/My Proj #1/y')
    ).toBe('see file:///workspace/x and /workspace/y');
  });

  it('matches both UNC spellings of a WSL path', () => {
    const text =
      '\\\\wsl.localhost\\Ubuntu\\home\\kamil\\proj\\a ' +
      '\\\\wsl$\\Ubuntu\\home\\kamil\\proj\\b ' +
      '//wsl$/Ubuntu/home/kamil/proj/c ' +
      'file://wsl.localhost/Ubuntu/home/kamil/proj/d ' +
      'file://wsl$/Ubuntu/home/kamil/proj ' +
      '\\\\wsl.localhost\\Ubuntu\\home\\kamil\\proj2';
    expect(unc.rewriteResult(text)).toBe(
      '/workspace\\a /workspace\\b /workspace/c file:///workspace/d file:///workspace ' +
        '\\\\wsl.localhost\\Ubuntu\\home\\kamil\\proj2'
    );
  });

  it('keeps posix matching case-sensitive', () => {
    expect(posix.rewriteResult('/users/kamil/proj/a')).toBe('/users/kamil/proj/a');
  });

  it('passes non-string values through and leaves deep values alone', () => {
    expect(posix.rewriteResult(42)).toBe(42);
    expect(posix.rewriteResult(null)).toBeNull();
    let deep: unknown = '/Users/kamil/proj/x';
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(JSON.stringify(posix.rewriteResult(deep))).toContain('/Users/kamil/proj/x');
  });

  it('keeps __proto__ keys as plain data', () => {
    const value = JSON.parse('{"__proto__":{"p":"/Users/kamil/proj/x"}}') as Record<
      string,
      unknown
    >;
    const out = posix.rewriteResult(value);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"p":"/workspace/x"}}');
  });
});
