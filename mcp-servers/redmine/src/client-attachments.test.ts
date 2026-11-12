import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RedmineClient } from './client.js';

type Received = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };
type Reply = { status: number; body?: unknown; raw?: Buffer; headers?: Record<string, string> };
type Route = (request: Received) => Reply | 'destroy' | 'endless-404';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('RedmineClient attachments', () => {
  let server: http.Server;
  let baseUrl: string;
  let received: Received[];
  let responsesFinished: boolean[];
  let route: Route;
  let workspace: string;
  let previousWorkspace: string | undefined;

  const attachment = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    filename: `file-${id}.png`,
    filesize: 1,
    content_type: 'image/png',
    content_url: `${baseUrl}/attachments/download/${id}/file-${id}.png`,
    ...over,
  });

  const issueReply = (attachments: unknown[], projectId = 1): Reply => ({
    status: 200,
    body: { issue: { id: 7, project: { id: projectId, name: 'P' }, attachments } },
  });

  const client = (projectId?: string) =>
    new RedmineClient(
      { url: baseUrl, apiKey: 'secret-key' },
      projectId ? { host_url: baseUrl, project_id: projectId } : null
    );

  const writeWorkspaceFile = async (name: string, data: Buffer) => {
    const real = path.join(workspace, name);
    await fsp.mkdir(path.dirname(real), { recursive: true });
    await fsp.writeFile(real, data);
    return { path: real, name, size: data.length };
  };

  const callsTo = (method: string, pathPrefix: string) =>
    received.filter((r) => r.method === method && r.url.startsWith(pathPrefix));

  beforeEach(async () => {
    received = [];
    responsesFinished = [];
    route = () => ({ status: 404 });
    workspace = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'redmine-att-')));
    previousWorkspace = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = workspace;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const request = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks),
        };
        received.push(request);
        res.on('close', () => responsesFinished.push(res.writableFinished));
        const reply = route(request);
        if (reply === 'endless-404') {
          res.writeHead(404, { 'Content-Type': 'application/octet-stream' });
          const chunk = Buffer.alloc(1_000_000);
          const push = () => {
            if (!res.destroyed && res.write(chunk)) setImmediate(push);
            else res.once('drain', push);
          };
          push();
          return;
        }
        if (reply === 'destroy') {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '100000' });
          res.write(Buffer.alloc(1000));
          setTimeout(() => res.destroy(), 20);
          return;
        }
        const payload = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
        res.writeHead(reply.status, {
          ...(reply.raw ? {} : { 'Content-Type': 'application/json' }),
          ...reply.headers,
        });
        res.end(payload);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previousWorkspace === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = previousWorkspace;
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  describe('addAttachments', () => {
    it('streams each file as octet-stream and attaches both with the comment in one PUT', async () => {
      const first = await writeWorkspaceFile('a.bin', randomBytes(300_000));
      const second = await writeWorkspaceFile('b.txt', Buffer.from('hello'));
      let uploads = 0;
      let issueReads = 0;
      route = (r) => {
        if (r.method === 'POST' && r.url.startsWith('/uploads.json')) {
          uploads += 1;
          return { status: 201, body: { upload: { token: `tok-${uploads}` } } };
        }
        if (r.method === 'GET' && r.url.startsWith('/issues/7.json')) {
          issueReads += 1;
          return issueReply(
            issueReads === 1 ? [attachment(1)] : [attachment(1), attachment(2), attachment(3)]
          );
        }
        if (r.method === 'PUT') return { status: 204 };
        return { status: 404 };
      };

      const added = (await client().addAttachments(7, [first, second], 'see files')).attachments;

      const posts = callsTo('POST', '/uploads.json');
      expect(posts).toHaveLength(2);
      expect(posts[0].url).toBe('/uploads.json?filename=a.bin');
      expect(posts[0].headers['content-type']).toBe('application/octet-stream');
      expect(posts[0].headers['content-length']).toBe('300000');
      expect(posts[0].headers['x-redmine-api-key']).toBe('secret-key');
      expect(sha(posts[0].body)).toBe(sha(await fsp.readFile(first.path)));
      expect(posts[1].url).toBe('/uploads.json?filename=b.txt');
      expect(posts[1].body.toString()).toBe('hello');
      const puts = callsTo('PUT', '/issues/7.json');
      expect(puts).toHaveLength(1);
      expect(JSON.parse(puts[0].body.toString())).toEqual({
        issue: {
          notes: 'see files',
          uploads: [
            { token: 'tok-1', filename: 'a.bin' },
            { token: 'tok-2', filename: 'b.txt' },
          ],
        },
      });
      expect(added.map((a) => a.id)).toEqual([2, 3]);
    });

    it('sends no notes key when no comment is given', async () => {
      const file = await writeWorkspaceFile('a.txt', Buffer.from('x'));
      route = (r) =>
        r.method === 'POST'
          ? { status: 201, body: { upload: { token: 't' } } }
          : r.method === 'PUT'
            ? { status: 204 }
            : issueReply([]);

      await client().addAttachments(7, [file]);

      const body = JSON.parse(callsTo('PUT', '/issues/7.json')[0].body.toString());
      expect(body.issue).toEqual({ uploads: [{ token: 't', filename: 'a.txt' }] });
    });

    it('rejects an issue of another project before uploading anything', async () => {
      const file = await writeWorkspaceFile('a.txt', Buffer.from('x'));
      route = (r) => {
        if (r.url.startsWith('/projects/mine.json')) {
          return { status: 200, body: { project: { id: 1 } } };
        }
        return issueReply([], 99);
      };

      await expect(client('mine').addAttachments(7, [file])).rejects.toThrow(
        /Project scope violation/
      );

      expect(callsTo('POST', '/uploads.json')).toHaveLength(0);
      expect(callsTo('PUT', '/issues')).toHaveLength(0);
    });

    it('turns a 422 on upload into the server message and attaches nothing', async () => {
      const file = await writeWorkspaceFile('big.bin', Buffer.from('x'));
      route = (r) =>
        r.method === 'POST'
          ? { status: 422, body: { errors: ['File is too large (maximum size is 5 MB)'] } }
          : issueReply([]);

      const error = await client()
        .addAttachments(7, [file])
        .catch((e: Error) => e);

      expect((error as Error).message).toContain('big.bin');
      expect((error as Error).message).toContain('File is too large (maximum size is 5 MB)');
      expect((error as Error).message).toContain('nothing was attached');
      expect(callsTo('PUT', '/issues')).toHaveLength(0);
    });

    it('says the limit was exceeded when a proxy answers 413', async () => {
      const file = await writeWorkspaceFile('big.bin', Buffer.from('x'));
      route = (r) => (r.method === 'POST' ? { status: 413 } : issueReply([]));

      await expect(client().addAttachments(7, [file])).rejects.toThrow(
        /big\.bin.*too large.*nothing was attached/s
      );
    });

    it('lets a 403 on upload through for the permission message and attaches nothing', async () => {
      const file = await writeWorkspaceFile('a.txt', Buffer.from('x'));
      route = (r) => (r.method === 'POST' ? { status: 403 } : issueReply([]));

      const error = await client()
        .addAttachments(7, [file])
        .catch((e: unknown) => e);

      expect(RedmineClient.formatError(error)).toContain('Permission denied');
      expect(callsTo('PUT', '/issues')).toHaveLength(0);
    });

    it('fails with the read error when the file vanished after it was resolved', async () => {
      route = () => issueReply([]);

      await expect(
        client().addAttachments(7, [
          { path: path.join(workspace, 'gone.txt'), name: 'gone.txt', size: 1 },
        ])
      ).rejects.toThrow(/ENOENT/);

      expect(callsTo('PUT', '/issues')).toHaveLength(0);
    });

    it('refuses a file whose path became a symlink after it was resolved and sends nothing', async () => {
      const real = await writeWorkspaceFile('a.txt', Buffer.from('x'));
      const secret = path.join(workspace, '..', 'secret-key.txt');
      await fsp.writeFile(secret, 'api-key');
      await fsp.rm(real.path);
      await fsp.symlink(secret, real.path);
      route = () => issueReply([]);

      await expect(client().addAttachments(7, [real])).rejects.toThrow(/changed into a link/);

      expect(callsTo('POST', '/uploads.json')).toHaveLength(0);
      expect(callsTo('PUT', '/issues')).toHaveLength(0);
      await fsp.rm(secret);
    });

    it('reports the files as attached when only the listing after the PUT fails', async () => {
      const file = await writeWorkspaceFile('a.txt', Buffer.from('x'));
      let issueReads = 0;
      route = (r) => {
        if (r.method === 'POST') return { status: 201, body: { upload: { token: 't' } } };
        if (r.method === 'PUT') return { status: 204 };
        issueReads += 1;
        return issueReads === 1 ? issueReply([]) : { status: 403 };
      };

      const result = await client().addAttachments(7, [file]);

      expect(result.attachments).toEqual([]);
      expect(result.warning).toContain('were attached to issue 7');
      expect(result.warning).toContain('getIssueFull');
      expect(callsTo('PUT', '/issues')).toHaveLength(1);
    });
  });

  describe('createIssue with files', () => {
    it('uploads the files and creates the issue with their tokens', async () => {
      const file = await writeWorkspaceFile('shot.png', Buffer.from('png-bytes'));
      route = (r) =>
        r.url.startsWith('/uploads.json')
          ? { status: 201, body: { upload: { token: 'tok' } } }
          : { status: 201, body: { issue: { id: 55 } } };

      const issue = await client().createIssue({ project_id: 'p', subject: 's', files: [file] });

      expect(issue.id).toBe(55);
      const create = callsTo('POST', '/issues.json')[0];
      expect(JSON.parse(create.body.toString()).issue.uploads).toEqual([
        { token: 'tok', filename: 'shot.png' },
      ]);
    });

    it('creates no issue when an upload fails', async () => {
      const file = await writeWorkspaceFile('shot.png', Buffer.from('x'));
      route = (r) =>
        r.url.startsWith('/uploads.json')
          ? { status: 422, body: { errors: ['Too large'] } }
          : { status: 201, body: { issue: { id: 55 } } };

      await expect(
        client().createIssue({ project_id: 'p', subject: 's', files: [file] })
      ).rejects.toThrow(/Too large/);

      expect(callsTo('POST', '/issues.json')).toHaveLength(0);
    });
  });

  describe('downloadAttachment', () => {
    it('streams the bytes to the workspace and reports path, size and type', async () => {
      const bytes = randomBytes(200_000);
      route = (r) => {
        if (r.url.startsWith('/issues/7.json')) {
          return issueReply([attachment(3, { filesize: bytes.length, filename: 'My shot.png' })]);
        }
        if (r.url.startsWith('/attachments/download/3/')) {
          return { status: 200, raw: bytes, headers: { 'Content-Type': 'image/png' } };
        }
        return { status: 404 };
      };

      const saved = await client().downloadAttachment(7, 3);

      const expected = path.join(workspace, '.speedwave', 'redmine', '3-My_shot.png');
      expect(saved).toEqual({
        id: 3,
        filename: 'My shot.png',
        content_type: 'image/png',
        size: bytes.length,
        path: expected,
      });
      expect(sha(await fsp.readFile(expected))).toBe(sha(bytes));
      expect(callsTo('GET', '/attachments/download/3/')[0].headers['x-redmine-api-key']).toBe(
        'secret-key'
      );
    });

    it('reduces a hostile filename to a basename without separators or leading dots', async () => {
      route = (r) =>
        r.url.startsWith('/issues/7.json')
          ? issueReply([attachment(3, { filename: '../../.ssh/..evil' })])
          : { status: 200, raw: Buffer.from('x'), headers: { 'Content-Type': 'image/png' } };

      const saved = await client().downloadAttachment(7, 3);

      expect(saved.path).toBe(path.join(workspace, '.speedwave', 'redmine', '3-evil'));
    });

    it('overwrites the same file on a repeated download', async () => {
      let version = 'first';
      route = (r) =>
        r.url.startsWith('/issues/7.json')
          ? issueReply([attachment(3, { filesize: version.length })])
          : { status: 200, raw: Buffer.from(version), headers: { 'Content-Type': 'image/png' } };

      const one = await client().downloadAttachment(7, 3);
      version = 'second!';
      const two = await client().downloadAttachment(7, 3);

      expect(two.path).toBe(one.path);
      expect(await fsp.readFile(two.path, 'utf8')).toBe('second!');
      expect(await fsp.readdir(path.dirname(two.path))).toEqual(['3-file-3.png']);
    });

    it('points to getIssueFull and calls no attachment URL for an attachment of another issue', async () => {
      route = (r) =>
        r.url.startsWith('/issues/7.json') ? issueReply([attachment(3)]) : { status: 200 };

      const error = await client()
        .downloadAttachment(7, 99)
        .catch((e: Error) => e);

      expect((error as Error).message).toContain('attachment_id');
      expect((error as Error).message).toContain('getIssueFull');
      expect((error as Error).message).toContain('"attachments"');
      expect(received.some((r) => r.url.startsWith('/attachments'))).toBe(false);
    });

    it('fails instead of saving a login page when Redmine answers with HTML', async () => {
      route = (r) =>
        r.url.startsWith('/issues/7.json')
          ? issueReply([attachment(3)])
          : {
              status: 200,
              raw: Buffer.from('<html>login</html>'),
              headers: { 'Content-Type': 'text/html' },
            };

      await expect(client().downloadAttachment(7, 3)).rejects.toThrow(/web page/);

      const dir = path.join(workspace, '.speedwave', 'redmine');
      expect(await fsp.readdir(dir).catch(() => [])).toEqual([]);
    });

    it('says the API key may not be allowed when Redmine redirects to its own login page', async () => {
      route = (r) =>
        r.url.startsWith('/issues/7.json')
          ? issueReply([attachment(3)])
          : { status: 302, headers: { Location: `${baseUrl}/login` } };

      await expect(client().downloadAttachment(7, 3)).rejects.toThrow(
        /API key may not be allowed to view attachments/
      );

      const dir = path.join(workspace, '.speedwave', 'redmine');
      expect(await fsp.readdir(dir).catch(() => [])).toEqual([]);
    });

    it('points at host_url when the download is redirected to another origin', async () => {
      route = (r) =>
        r.url.startsWith('/issues/7.json')
          ? issueReply([attachment(3)])
          : { status: 301, headers: { Location: 'https://elsewhere.example/attachments/3' } };

      await expect(client().downloadAttachment(7, 3)).rejects.toThrow(/host_url/);
    });

    it('requests the download path built from the attachment, not the content_url path', async () => {
      route = (r) =>
        r.url.startsWith('/issues/7.json')
          ? issueReply([attachment(3, { content_url: `${baseUrl}/somewhere/else.png?x=1` })])
          : { status: 200, raw: Buffer.from('x'), headers: { 'Content-Type': 'image/png' } };

      await client().downloadAttachment(7, 3);

      expect(received.filter((r) => r.url.startsWith('/attachments'))[0].url).toBe(
        '/attachments/download/3/file-3.png'
      );
    });

    it('keeps a path prefix of host_url when building the download URL', async () => {
      route = (r) =>
        r.url.startsWith('/redmine/issues/7.json')
          ? issueReply([attachment(3)])
          : { status: 200, raw: Buffer.from('x'), headers: { 'Content-Type': 'image/png' } };
      const prefixed = new RedmineClient({ url: `${baseUrl}/redmine`, apiKey: 'secret-key' });

      await prefixed.downloadAttachment(7, 3);

      expect(received.some((r) => r.url === '/redmine/attachments/download/3/file-3.png')).toBe(
        true
      );
    });

    it('downloads an attachment whose content_type is null', async () => {
      route = (r) =>
        r.url.startsWith('/issues/7.json')
          ? issueReply([attachment(3, { content_type: null })])
          : { status: 200, raw: Buffer.from('x'), headers: { 'Content-Type': 'image/png' } };

      const saved = await client().downloadAttachment(7, 3);

      expect(await fsp.readFile(saved.path, 'utf8')).toBe('x');
    });

    it('still refuses a web page for an attachment whose content_type is null', async () => {
      route = (r) =>
        r.url.startsWith('/issues/7.json')
          ? issueReply([attachment(3, { content_type: null })])
          : { status: 200, raw: Buffer.from('<html/>'), headers: { 'Content-Type': 'text/html' } };

      await expect(client().downloadAttachment(7, 3)).rejects.toThrow(/web page/);
    });

    it('closes the connection when the download is answered 404 with a body', async () => {
      route = (r) =>
        r.url.startsWith('/issues/7.json') ? issueReply([attachment(3)]) : 'endless-404';

      await client()
        .downloadAttachment(7, 3)
        .catch(() => undefined);
      await vi.waitFor(() => expect(responsesFinished).toContain(false));
    });

    it('refuses a service directory that is a symlink out of the workspace', async () => {
      const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'redmine-out-'));
      await fsp.mkdir(path.join(workspace, '.speedwave'));
      await fsp.symlink(outsideDir, path.join(workspace, '.speedwave', 'redmine'));
      route = (r) =>
        r.url.startsWith('/issues/7.json')
          ? issueReply([attachment(3)])
          : { status: 200, raw: Buffer.from('x'), headers: { 'Content-Type': 'image/png' } };

      await expect(client().downloadAttachment(7, 3)).rejects.toThrow(/outside the workspace/);

      expect(await fsp.readdir(outsideDir)).toEqual([]);
      await fsp.rm(outsideDir, { recursive: true });
    });

    it('fails when the bytes received differ from the size Redmine reports and saves nothing', async () => {
      route = (r) =>
        r.url.startsWith('/issues/7.json')
          ? issueReply([attachment(3, { filesize: 50, content_type: 'text/html' })])
          : {
              status: 200,
              raw: Buffer.from('<html>login</html>'),
              headers: { 'Content-Type': 'text/html' },
            };

      await expect(client().downloadAttachment(7, 3)).rejects.toThrow(/18 bytes.*50/);

      expect(await fsp.readdir(path.join(workspace, '.speedwave', 'redmine'))).toEqual([]);
    });

    it.each([
      [403, 'Permission denied'],
      [404, 'attachment_id=3'],
      [404, 'include ["attachments"]'],
    ])(
      'turns a %i on the download into a readable message naming the attachment',
      async (status, text) => {
        route = (r) =>
          r.url.startsWith('/issues/7.json') ? issueReply([attachment(3)]) : { status };

        const error = await client()
          .downloadAttachment(7, 3)
          .catch((e: unknown) => e);

        expect(RedmineClient.formatError(error, { issue_id: 7, attachment_id: 3 })).toContain(text);
        expect(await fsp.readdir(path.join(workspace, '.speedwave')).catch(() => [])).toEqual([]);
      }
    );

    it('leaves no partial file when the connection drops mid-download', async () => {
      route = (r) => (r.url.startsWith('/issues/7.json') ? issueReply([attachment(3)]) : 'destroy');

      await expect(client().downloadAttachment(7, 3)).rejects.toThrow();

      const dir = path.join(workspace, '.speedwave', 'redmine');
      expect(await fsp.readdir(dir)).toEqual([]);
    });

    it('rejects an issue of another project before reading its attachments', async () => {
      route = (r) =>
        r.url.startsWith('/projects/mine.json')
          ? { status: 200, body: { project: { id: 1 } } }
          : issueReply([attachment(3)], 99);

      await expect(client('mine').downloadAttachment(7, 3)).rejects.toThrow(
        /Project scope violation/
      );

      expect(received.some((r) => r.url.startsWith('/attachments'))).toBe(false);
    });
  });

  describe('deleteAttachment', () => {
    it('deletes an attachment that belongs to the issue', async () => {
      route = (r) => (r.method === 'DELETE' ? { status: 204 } : issueReply([attachment(3)]));

      await client().deleteAttachment(7, 3);

      expect(callsTo('DELETE', '/attachments/3.json')).toHaveLength(1);
    });

    it('points to getIssueFull and sends no DELETE for an attachment of another issue', async () => {
      route = (r) => (r.method === 'DELETE' ? { status: 204 } : issueReply([attachment(3)]));

      await expect(client().deleteAttachment(7, 99)).rejects.toThrow(/getIssueFull/);

      expect(callsTo('DELETE', '/attachments')).toHaveLength(0);
    });

    it('rejects an issue of another project before deleting', async () => {
      route = (r) =>
        r.url.startsWith('/projects/mine.json')
          ? { status: 200, body: { project: { id: 1 } } }
          : r.method === 'DELETE'
            ? { status: 204 }
            : issueReply([attachment(3)], 99);

      await expect(client('mine').deleteAttachment(7, 3)).rejects.toThrow(
        /Project scope violation/
      );

      expect(callsTo('DELETE', '/attachments')).toHaveLength(0);
    });
  });
});
