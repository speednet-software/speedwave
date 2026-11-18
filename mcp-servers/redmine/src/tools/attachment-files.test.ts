import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAttachmentFiles } from './attachment-files.js';

describe('resolveAttachmentFiles', () => {
  let workspace: string;
  let outside: string;
  let previous: string | undefined;

  const message = (result: Awaited<ReturnType<typeof resolveAttachmentFiles>>): string => {
    if ('files' in result) throw new Error('expected a rejection');
    return (result.error.content[0] as { text: string }).text;
  };

  beforeEach(async () => {
    workspace = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'redmine-files-')));
    outside = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'redmine-out-')));
    previous = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = workspace;
    await fsp.writeFile(path.join(workspace, 'a.txt'), 'aaa');
    await fsp.writeFile(path.join(workspace, 'b.txt'), 'bb');
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = previous;
    await fsp.rm(workspace, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  });

  it('resolves workspace paths to real paths, names and sizes in call order', async () => {
    const result = await resolveAttachmentFiles([path.join(workspace, 'a.txt'), 'b.txt']);

    expect(result).toEqual({
      files: [
        { path: path.join(workspace, 'a.txt'), name: 'a.txt', size: 3 },
        { path: path.join(workspace, 'b.txt'), name: 'b.txt', size: 2 },
      ],
    });
  });

  it('rejects a path outside the workspace and names its index', async () => {
    const result = await resolveAttachmentFiles(['a.txt', path.join(outside, 'secret.txt')]);

    expect(message(result)).toContain('Invalid file_paths');
    expect(message(result)).toContain('file_paths[1]');
    expect(message(result)).toContain('outside the workspace');
  });

  it('rejects a ../ escape', async () => {
    const result = await resolveAttachmentFiles([`../${path.basename(outside)}/secret.txt`]);

    expect(message(result)).toContain('outside the workspace');
  });

  it('rejects a symlink pointing out of the workspace', async () => {
    await fsp.symlink(path.join(outside, 'secret.txt'), path.join(workspace, 'link.txt'));

    const result = await resolveAttachmentFiles(['link.txt']);

    expect(message(result)).toContain('outside the workspace');
  });

  it('rejects a missing file and a directory', async () => {
    await fsp.mkdir(path.join(workspace, 'dir'));

    expect(message(await resolveAttachmentFiles(['missing.txt']))).toContain('was not found');
    expect(message(await resolveAttachmentFiles(['dir']))).toContain('not a regular file');
  });

  it('rejects an empty list, a non-array, a non-string entry and more than 10 files', async () => {
    expect(message(await resolveAttachmentFiles([]))).toContain('non-empty array');
    expect(message(await resolveAttachmentFiles('a.txt'))).toContain('non-empty array');
    expect(message(await resolveAttachmentFiles(['a.txt', 5]))).toContain('file_paths[1]');
    expect(message(await resolveAttachmentFiles(Array(11).fill('a.txt')))).toContain('at most 10');
  });

  it('rejects the same file listed twice', async () => {
    const result = await resolveAttachmentFiles(['a.txt', path.join(workspace, 'a.txt')]);

    expect(message(result)).toContain('file_paths[1]');
    expect(message(result)).toContain('duplicate');
  });

  it('lets an unexpected filesystem failure through instead of calling it a bad path', async () => {
    process.env.WORKSPACE_DIR = path.join(workspace, 'missing-root');

    await expect(resolveAttachmentFiles(['a.txt'])).rejects.toThrow(/ENOENT/);
  });
});
