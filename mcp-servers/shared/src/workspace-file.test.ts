import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readWorkspaceFile } from './workspace-file.js';

describe('readWorkspaceFile', () => {
  let base: string;
  let root: string;
  let outside: string;
  let previousWorkspace: string | undefined;

  beforeEach(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ws-file-'));
    root = path.join(base, 'workspace');
    outside = path.join(base, 'outside');
    await fsp.mkdir(root);
    await fsp.mkdir(outside);
    previousWorkspace = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = root;
  });

  afterEach(async () => {
    if (previousWorkspace === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = previousWorkspace;
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('reads an absolute path inside the workspace', async () => {
    const file = path.join(root, 'report.txt');
    await fsp.writeFile(file, 'hello');
    const result = await readWorkspaceFile(file, 100);
    expect(result.buffer.toString()).toBe('hello');
    expect(result.name).toBe('report.txt');
  });

  it('reads a relative path from the workspace root', async () => {
    await fsp.mkdir(path.join(root, 'sub'));
    await fsp.writeFile(path.join(root, 'sub', 'a.md'), '# a');
    const result = await readWorkspaceFile('sub/a.md', 100);
    expect(result.buffer.toString()).toBe('# a');
    expect(result.name).toBe('a.md');
  });

  it('rejects ../ traversal out of the workspace', async () => {
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'x');
    await expect(readWorkspaceFile('../outside/secret.txt', 100)).rejects.toThrow(
      'filePath must resolve to a location inside the workspace'
    );
  });

  it('rejects a symlink inside the workspace that points outside', async () => {
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'x');
    await fsp.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    await expect(readWorkspaceFile('link.txt', 100)).rejects.toThrow(
      'filePath must resolve to a location inside the workspace'
    );
  });

  it('accepts a symlink that points inside the workspace', async () => {
    await fsp.writeFile(path.join(root, 'real.txt'), 'data');
    await fsp.symlink(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));
    const result = await readWorkspaceFile('alias.txt', 100);
    expect(result.buffer.toString()).toBe('data');
    expect(result.name).toBe('real.txt');
  });

  it('reports a missing file', async () => {
    await expect(readWorkspaceFile('missing.txt', 100)).rejects.toThrow(
      'File not found under workspace: missing.txt'
    );
  });

  it('rejects a directory', async () => {
    await fsp.mkdir(path.join(root, 'dir'));
    await expect(readWorkspaceFile('dir', 100)).rejects.toThrow('Not a regular file: dir');
  });

  it('rejects a file over the cap with a generic message', async () => {
    await fsp.writeFile(path.join(root, 'big.bin'), Buffer.alloc(11));
    await expect(readWorkspaceFile('big.bin', 10)).rejects.toThrow(
      'File is too large (11 bytes > 10 byte limit): big.bin. Split the file or reduce it.'
    );
  });

  it('accepts a file exactly at the cap', async () => {
    await fsp.writeFile(path.join(root, 'edge.bin'), Buffer.alloc(10));
    const result = await readWorkspaceFile('edge.bin', 10);
    expect(result.buffer.length).toBe(10);
  });
});
