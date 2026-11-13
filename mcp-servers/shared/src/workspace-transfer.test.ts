import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  MAX_WORKSPACE_FILES,
  WorkspaceFileListError,
  resolveWorkspaceFileList,
  openWorkspaceFile,
  sanitizeFilename,
  writeWorkspaceDownload,
} from './workspace-transfer.js';
import { WorkspaceFileError } from './workspace-file.js';

describe('workspace transfer helpers', () => {
  let base: string;
  let root: string;
  let outside: string;
  let previous: string | undefined;

  beforeEach(async () => {
    base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'ws-transfer-')));
    root = path.join(base, 'workspace');
    outside = path.join(base, 'outside');
    await fsp.mkdir(root);
    await fsp.mkdir(outside);
    previous = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = root;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = previous;
    await fsp.rm(base, { recursive: true, force: true });
  });

  describe('sanitizeFilename', () => {
    it.each([
      ['report.pdf', 'report.pdf'],
      ['../../etc/pa ss?wd*.txt', 'pa_ss_wd_.txt'],
      ['C:\\dir\\file.png', 'file.png'],
      ['.hidden', 'hidden'],
      ['..', 'file'],
      ['', 'file'],
      ['dir/', 'file'],
    ])('reduces %j to %j', (input, expected) => {
      expect(sanitizeFilename(input)).toBe(expected);
    });
  });

  describe('resolveWorkspaceFileList', () => {
    const reason = async (input: unknown): Promise<string> => {
      const error = await resolveWorkspaceFileList(input, 'file_paths').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WorkspaceFileListError);
      return (error as Error).message;
    };

    beforeEach(async () => {
      await fsp.writeFile(path.join(root, 'a.txt'), 'aaa');
      await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');
    });

    it('resolves entries in order', async () => {
      const files = await resolveWorkspaceFileList(['a.txt'], 'file_paths');

      expect(files).toEqual([{ path: path.join(root, 'a.txt'), name: 'a.txt', size: 3 }]);
    });

    it('rejects an empty or non-array list', async () => {
      expect(await reason([])).toContain('non-empty array');
      expect(await reason('a.txt')).toContain('non-empty array');
    });

    it('rejects more than the limit', async () => {
      expect(await reason(Array(MAX_WORKSPACE_FILES + 1).fill('a.txt'))).toContain(
        `at most ${MAX_WORKSPACE_FILES}`
      );
    });

    it('rejects a non-string or empty entry by index', async () => {
      expect(await reason(['a.txt', 5])).toContain('file_paths[1]');
      expect(await reason([''])).toContain('file_paths[0]');
    });

    it('rejects a duplicate by index', async () => {
      expect(await reason(['a.txt', path.join(root, 'a.txt')])).toContain(
        'file_paths[1] is a duplicate'
      );
    });

    it('rejects paths outside, missing and not regular files with the index', async () => {
      await fsp.mkdir(path.join(root, 'dir'));
      await fsp.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link'));

      expect(await reason([path.join(outside, 'secret.txt')])).toContain('outside the workspace');
      expect(await reason(['a.txt', 'link'])).toContain('file_paths[1]');
      expect(await reason(['missing'])).toContain('was not found');
      expect(await reason(['dir'])).toContain('not a regular file');
    });

    it('lets an unexpected filesystem failure through', async () => {
      process.env.WORKSPACE_DIR = path.join(root, 'nope');

      await expect(resolveWorkspaceFileList(['a.txt'], 'file_paths')).rejects.toThrow(/ENOENT/);
    });
  });

  describe('openWorkspaceFile', () => {
    it('opens a regular file and reports its size from the handle', async () => {
      await fsp.writeFile(path.join(root, 'a.txt'), 'abc');

      const { handle, size } = await openWorkspaceFile({
        path: path.join(root, 'a.txt'),
        name: 'a.txt',
        size: 0,
      });

      expect(size).toBe(3);
      expect((await handle.readFile()).toString()).toBe('abc');
      await handle.close();
    });

    it('refuses a path that became a symlink after it was resolved', async () => {
      await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');
      await fsp.symlink(path.join(outside, 'secret.txt'), path.join(root, 'swapped.txt'));

      const error = await openWorkspaceFile({
        path: path.join(root, 'swapped.txt'),
        name: 'swapped.txt',
        size: 6,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WorkspaceFileError);
      expect((error as WorkspaceFileError).kind).toBe('outside_workspace');
    });

    it('refuses a directory and lets a missing file through as its own error', async () => {
      await fsp.mkdir(path.join(root, 'dir'));

      await expect(
        openWorkspaceFile({ path: path.join(root, 'dir'), name: 'dir', size: 0 })
      ).rejects.toMatchObject({ kind: 'not_a_file' });
      await expect(
        openWorkspaceFile({ path: path.join(root, 'gone'), name: 'gone', size: 0 })
      ).rejects.toThrow(/ENOENT/);
    });
  });

  describe('writeWorkspaceDownload', () => {
    const download = (data: string, expectedSize?: number, name = 'shot.png') =>
      writeWorkspaceDownload({
        service: 'redmine',
        id: 3,
        name,
        source: Readable.from([Buffer.from(data)]),
        expectedSize,
      });

    it('writes <id>-<name> under .speedwave/<service> and reports path and size', async () => {
      const saved = await download('png-bytes', 9);

      expect(saved).toEqual({
        path: path.join(root, '.speedwave', 'redmine', '3-shot.png'),
        size: 9,
      });
      expect(await fsp.readFile(saved.path, 'utf8')).toBe('png-bytes');
      expect(await fsp.readdir(path.dirname(saved.path))).toEqual(['3-shot.png']);
    });

    it('sanitizes the name and overwrites on a repeat', async () => {
      await download('one', undefined, '../../x y.png');
      const saved = await download('two!', undefined, '../../x y.png');

      expect(saved.path).toBe(path.join(root, '.speedwave', 'redmine', '3-x_y.png'));
      expect(await fsp.readFile(saved.path, 'utf8')).toBe('two!');
    });

    it('rejects a size mismatch and leaves nothing behind', async () => {
      await expect(download('short', 99)).rejects.toThrow(/5 bytes.*99/);

      expect(await fsp.readdir(path.join(root, '.speedwave', 'redmine'))).toEqual([]);
    });

    it('leaves nothing behind when the source fails mid-stream', async () => {
      const source = new Readable({
        read() {
          this.push(Buffer.from('abc'));
          setImmediate(() => this.destroy(new Error('connection dropped')));
        },
      });

      await expect(
        writeWorkspaceDownload({ service: 'redmine', id: 3, name: 'f.bin', source })
      ).rejects.toThrow('connection dropped');

      expect(await fsp.readdir(path.join(root, '.speedwave', 'redmine'))).toEqual([]);
    });

    it('does not write through a symlink planted at the .part path', async () => {
      const victim = path.join(outside, 'victim.txt');
      await fsp.writeFile(victim, 'untouched');
      const dir = path.join(root, '.speedwave', 'redmine');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.symlink(victim, path.join(dir, '3-shot.png.part'));

      const saved = await download('new-bytes');

      expect(await fsp.readFile(victim, 'utf8')).toBe('untouched');
      expect(await fsp.readFile(saved.path, 'utf8')).toBe('new-bytes');
    });

    it('refuses a service directory that is a symlink out of the workspace', async () => {
      await fsp.mkdir(path.join(root, '.speedwave'));
      await fsp.symlink(outside, path.join(root, '.speedwave', 'redmine'));

      const error = await download('x').catch((e: unknown) => e);

      expect((error as WorkspaceFileError).kind).toBe('outside_workspace');
      expect(await fsp.readdir(outside)).toEqual([]);
    });

    it('refuses a .speedwave directory that is a symlink out of the workspace', async () => {
      await fsp.symlink(outside, path.join(root, '.speedwave'));

      const error = await download('x').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WorkspaceFileError);
      expect((error as WorkspaceFileError).kind).toBe('outside_workspace');
      expect(await fsp.readdir(outside)).toEqual([]);
    });
  });
});
