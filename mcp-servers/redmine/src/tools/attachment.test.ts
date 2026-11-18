import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notConfiguredMessage, type ToolsCallResult } from '@speedwave/mcp-shared';
import { createAttachmentTools } from './attachment-tools.js';
import { expectEmittedKeysDeclared } from './test-helpers.js';
import { RedmineClient, ProjectScopeError } from '../client.js';

type MockClient = { addAttachments: Mock; downloadAttachment: Mock; deleteAttachment: Mock };

const textOf = (result: ToolsCallResult): string => (result.content[0] as { text: string }).text;

describe('attachment tools', () => {
  let client: MockClient;
  let workspace: string;
  let outside: string;
  let previous: string | undefined;

  const tool = (name: string) =>
    createAttachmentTools(client as unknown as RedmineClient).find((t) => t.tool.name === name)!;
  const call = (name: string, params: Record<string, unknown>) => tool(name).handler(params);

  beforeEach(async () => {
    client = { addAttachments: vi.fn(), downloadAttachment: vi.fn(), deleteAttachment: vi.fn() };
    workspace = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'redmine-tools-')));
    outside = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'redmine-out-')));
    previous = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = workspace;
    await fsp.writeFile(path.join(workspace, 'a.txt'), 'aaa');
    await fsp.writeFile(path.join(workspace, 'b.txt'), 'bb');
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previous === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = previous;
    await fsp.rm(workspace, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  });

  describe('addAttachment', () => {
    it('sends the resolved files and the comment as one call and returns the added attachments', async () => {
      const added = [{ id: 11, filename: 'a.txt', filesize: 3, content_type: 'text/plain' }];
      client.addAttachments.mockResolvedValue({ attachments: added });

      const result = await call('addAttachment', {
        issue_id: 7,
        file_paths: ['a.txt', path.join(workspace, 'b.txt')],
        notes: 'see files',
      });

      expect(client.addAttachments).toHaveBeenCalledTimes(1);
      expect(client.addAttachments).toHaveBeenCalledWith(
        7,
        [
          { path: path.join(workspace, 'a.txt'), name: 'a.txt', size: 3 },
          { path: path.join(workspace, 'b.txt'), name: 'b.txt', size: 2 },
        ],
        'see files'
      );
      const emitted = expectEmittedKeysDeclared(tool('addAttachment').tool, result);
      expect(emitted).toEqual({ attachments: added });
    });

    it('passes on the warning when the files were attached but the listing failed', async () => {
      client.addAttachments.mockResolvedValue({
        attachments: [],
        warning: 'attached, listing failed',
      });

      const result = await call('addAttachment', { issue_id: 7, file_paths: ['a.txt'] });

      expect(expectEmittedKeysDeclared(tool('addAttachment').tool, result)).toEqual({
        attachments: [],
        warning: 'attached, listing failed',
      });
    });

    it.each([
      ['an absolute path outside the workspace', () => path.join(outside, 'secret.txt')],
      ['a ../ escape', () => `../${path.basename(outside)}/secret.txt`],
    ])('rejects %s before any Redmine call, even when another path is fine', async (_n, bad) => {
      const result = await call('addAttachment', { issue_id: 7, file_paths: ['a.txt', bad()] });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('file_paths[1]');
      expect(textOf(result)).toContain('outside the workspace');
      expect(client.addAttachments).not.toHaveBeenCalled();
    });

    it('rejects a symlink leaving the workspace before any Redmine call', async () => {
      await fsp.symlink(path.join(outside, 'secret.txt'), path.join(workspace, 'link.txt'));

      const result = await call('addAttachment', { issue_id: 7, file_paths: ['link.txt'] });

      expect(textOf(result)).toContain('outside the workspace');
      expect(client.addAttachments).not.toHaveBeenCalled();
    });

    it('rejects an empty file list before any Redmine call', async () => {
      const result = await call('addAttachment', { issue_id: 7, file_paths: [] });

      expect(textOf(result)).toContain('non-empty array');
      expect(client.addAttachments).not.toHaveBeenCalled();
    });

    it('reports a project scope violation as an error', async () => {
      client.addAttachments.mockRejectedValue(new ProjectScopeError('mine', 'project_id=9'));

      const result = await call('addAttachment', { issue_id: 7, file_paths: ['a.txt'] });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Project scope violation');
    });

    it('formats a client error with the issue id as context', async () => {
      const spy = vi.spyOn(RedmineClient, 'formatError').mockReturnValue('formatted');
      client.addAttachments.mockRejectedValue(new Error('boom'));

      const result = await call('addAttachment', { issue_id: 7, file_paths: ['a.txt'] });

      expect(textOf(result)).toBe('Error: formatted');
      expect(spy).toHaveBeenCalledWith(expect.any(Error), { issue_id: 7 });
    });
  });

  describe('downloadAttachment', () => {
    it('returns where the file was saved, its size and type, never its bytes', async () => {
      const saved = {
        id: 3,
        filename: 'shot.png',
        content_type: 'image/png',
        size: 12,
        path: '/workspace/.speedwave/redmine/3-shot.png',
      };
      client.downloadAttachment.mockResolvedValue(saved);

      const result = await call('downloadAttachment', { issue_id: 7, attachment_id: 3 });

      expect(client.downloadAttachment).toHaveBeenCalledWith(7, 3);
      expect(expectEmittedKeysDeclared(tool('downloadAttachment').tool, result)).toEqual(saved);
    });

    it('passes the teaching error for an attachment of another issue to the caller', async () => {
      client.downloadAttachment.mockRejectedValue(
        new Error('Invalid attachment_id. Call getIssueFull with include ["attachments"]')
      );

      const result = await call('downloadAttachment', { issue_id: 7, attachment_id: 99 });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('getIssueFull');
    });
  });

  describe('deleteAttachment', () => {
    it('deletes and confirms the id', async () => {
      client.deleteAttachment.mockResolvedValue(undefined);

      const result = await call('deleteAttachment', { issue_id: 7, attachment_id: 3 });

      expect(client.deleteAttachment).toHaveBeenCalledWith(7, 3);
      expect(expectEmittedKeysDeclared(tool('deleteAttachment').tool, result)).toEqual({
        deleted_attachment_id: 3,
      });
    });

    it('reports a 403 as a permission error', async () => {
      const error = Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: { status: 403, data: {} },
      });
      client.deleteAttachment.mockRejectedValue(error);

      const result = await call('deleteAttachment', { issue_id: 7, attachment_id: 3 });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Permission denied');
    });
  });

  describe('unconfigured client', () => {
    it.each(['addAttachment', 'downloadAttachment', 'deleteAttachment'])(
      '%s reports Redmine as not configured',
      async (name) => {
        const def = createAttachmentTools(null).find((t) => t.tool.name === name)!;

        const result = await def.handler({ issue_id: 7, file_paths: ['a.txt'], attachment_id: 3 });

        expect(textOf(result)).toBe(`Error: ${notConfiguredMessage('Redmine')}`);
      }
    );
  });
});
