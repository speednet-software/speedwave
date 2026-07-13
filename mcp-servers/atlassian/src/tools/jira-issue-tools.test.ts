/**
 * Tests for the Jira issue tools — definition metadata, the unconfigured path,
 * handler success cases (domain client mocked), and error handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { META_KEYS } from '@speedwave/mcp-shared';
import { createJiraIssueTools } from './jira-issue-tools.js';
import type { AtlassianClient } from '../client.js';

// Mock the domain factory: `createJiraIssuesClient` returns our scripted stub.
const issuesStub = {
  search: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  getTransitions: vi.fn(),
  transition: vi.fn(),
  assign: vi.fn(),
  getMyself: vi.fn(),
  addAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
};
vi.mock('../domains/jira-issues.js', () => ({
  createJiraIssuesClient: () => issuesStub,
}));

/** A non-null AtlassianClient-shaped value (its methods aren't used — domains are mocked). */
const FAKE_CLIENT = {} as AtlassianClient;

/** Find a handler by tool name in a built definition list. */
function handlerFor(name: string) {
  const def = createJiraIssueTools(FAKE_CLIENT).find((d) => d.tool.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def.handler;
}

/** Parse the JSON text out of a successful tool result. */
function payload(result: { content: Array<{ text: string }>; isError?: true }): unknown {
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  Object.values(issuesStub).forEach((m) => m.mockReset());
});

describe('definitions', () => {
  it('exposes exactly the 10 expected tools with camelCase names and no service prefix', () => {
    const names = createJiraIssueTools(FAKE_CLIENT).map((d) => d.tool.name);
    expect(names).toEqual([
      'searchIssues',
      'getIssue',
      'createIssue',
      'updateIssue',
      'getTransitions',
      'transitionIssue',
      'assignIssue',
      'getMyself',
      'addAttachment',
      'deleteAttachment',
    ]);
    expect(names.every((n) => /^[a-z][A-Za-z]+$/.test(n))).toBe(true);
  });

  it('every tool has keywords, an example, and input/output schemas; required fields are declared', () => {
    for (const { tool } of createJiraIssueTools(FAKE_CLIENT)) {
      expect(Array.isArray(tool.keywords) && tool.keywords.length).toBeGreaterThan(0);
      expect(typeof tool.example).toBe('string');
      expect(tool.inputSchema?.type).toBe('object');
      expect(tool.outputSchema?.required).toContain('success');
      expect(Array.isArray(tool.inputExamples) && tool.inputExamples!.length).toBeGreaterThan(0);
    }
  });

  it('marks read-only tools as such and defers loading of the heavier write tools', () => {
    const byName = Object.fromEntries(
      createJiraIssueTools(FAKE_CLIENT).map((d) => [d.tool.name, d.tool])
    );
    expect(byName.searchIssues._meta).toMatchObject({ [META_KEYS.DEFER_LOADING]: false });
    expect(byName.createIssue._meta).toMatchObject({ [META_KEYS.DEFER_LOADING]: true });
    expect(byName.searchIssues.annotations).toBeDefined();
  });

  it('every tool declares strict prefixed-key identity metadata: user-scoped tools point at getMyself, others carry neither the prefixed nor the legacy key', () => {
    const userScopedNames = new Set(['searchIssues', 'createIssue', 'updateIssue', 'assignIssue']);
    for (const { tool } of createJiraIssueTools(FAKE_CLIENT)) {
      const meta = tool._meta as Record<string, unknown> | undefined;
      if (userScopedNames.has(tool.name)) {
        expect(meta?.[META_KEYS.USER_SCOPED], `${tool.name} should be user-scoped`).toBe(true);
        expect(meta?.[META_KEYS.CURRENT_USER_TOOL], `${tool.name} current-user-tool`).toBe(
          'getMyself'
        );
      } else {
        expect(meta?.[META_KEYS.USER_SCOPED], `${tool.name} unexpectedly user-scoped`).toBeFalsy();
      }
      expect(meta?.userScoped, `${tool.name} uses legacy userScoped`).toBeUndefined();
      expect(meta?.currentUserTool, `${tool.name} uses legacy currentUserTool`).toBeUndefined();
    }
  });
});

describe('unconfigured client', () => {
  it('still lists all tools, but every handler returns a not-configured error', async () => {
    const defs = createJiraIssueTools(null);
    expect(defs).toHaveLength(10);
    for (const { handler } of defs) {
      const res = await handler({} as never);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/not configured|configure/i);
    }
  });
});

describe('searchIssues handler', () => {
  it('delegates to the domain client and returns its result', async () => {
    issuesStub.search.mockResolvedValueOnce({
      issues: [{ key: 'PROJ-1' }],
      next_page_token: 't',
      is_last: false,
    });
    const res = await handlerFor('searchIssues')({ jql: 'x', maxResults: 5, nextPageToken: 't0' });
    expect(issuesStub.search).toHaveBeenCalledWith({
      jql: 'x',
      maxResults: 5,
      nextPageToken: 't0',
    });
    expect(payload(res)).toEqual({
      issues: [{ key: 'PROJ-1' }],
      next_page_token: 't',
      is_last: false,
    });
  });

  it('surfaces a thrown error as an error result', async () => {
    issuesStub.search.mockRejectedValueOnce(new Error('boom'));
    const res = await handlerFor('searchIssues')({ jql: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/boom/);
  });
});

describe('getIssue handler', () => {
  it('returns the issue wrapped under `issue`', async () => {
    issuesStub.get.mockResolvedValueOnce({ key: 'PROJ-9' });
    const res = await handlerFor('getIssue')({ issueIdOrKey: 'PROJ-9' });
    expect(issuesStub.get).toHaveBeenCalledWith('PROJ-9');
    expect(payload(res)).toEqual({ issue: { key: 'PROJ-9' } });
  });
});

describe('createIssue handler', () => {
  it('forwards plain text as the body and re-shapes optional fields', async () => {
    issuesStub.create.mockResolvedValueOnce({ key: 'PROJ-2' });
    await handlerFor('createIssue')({
      projectKey: 'PROJ',
      summary: 'S',
      issueType: 'Task',
      bodyText: 'text',
      priority: 'High',
      labels: ['x'],
      assigneeAccountId: 'u1',
    });
    expect(issuesStub.create).toHaveBeenCalledWith({
      projectKey: 'PROJ',
      summary: 'S',
      issueType: 'Task',
      body: 'text',
      priority: 'High',
      labels: ['x'],
      assigneeAccountId: 'u1',
    });
  });

  it('prefers bodyAdf over bodyText', async () => {
    issuesStub.create.mockResolvedValueOnce({ key: 'PROJ-3' });
    const adf = { version: 1 as const, type: 'doc' as const, content: [] };
    await handlerFor('createIssue')({
      projectKey: 'PROJ',
      summary: 'S',
      issueType: 'Task',
      bodyText: 't',
      bodyAdf: adf,
    });
    expect(issuesStub.create.mock.calls[0][0].body).toBe(adf);
  });

  it('passes body as undefined when neither bodyText nor bodyAdf is given', async () => {
    issuesStub.create.mockResolvedValueOnce({ key: 'PROJ-4' });
    await handlerFor('createIssue')({ projectKey: 'PROJ', summary: 'S', issueType: 'Task' });
    expect(issuesStub.create.mock.calls[0][0].body).toBeUndefined();
  });
});

describe('updateIssue handler', () => {
  it('forwards only the provided fields, preferring bodyAdf', async () => {
    issuesStub.update.mockResolvedValueOnce({ key: 'PROJ-1' });
    const adf = { version: 1 as const, type: 'doc' as const, content: [] };
    await handlerFor('updateIssue')({
      issueIdOrKey: 'PROJ-1',
      summary: 'X',
      bodyAdf: adf,
      labels: [],
    });
    expect(issuesStub.update).toHaveBeenCalledWith('PROJ-1', {
      summary: 'X',
      body: adf,
      priority: undefined,
      labels: [],
    });
  });

  it('falls back to bodyText when no bodyAdf', async () => {
    issuesStub.update.mockResolvedValueOnce({ key: 'PROJ-1' });
    await handlerFor('updateIssue')({ issueIdOrKey: 'PROJ-1', bodyText: 't' });
    expect(issuesStub.update.mock.calls[0][1].body).toBe('t');
  });

  it('forwards assigneeAccountId to reassign the issue', async () => {
    issuesStub.update.mockResolvedValueOnce({ key: 'PROJ-1' });
    await handlerFor('updateIssue')({ issueIdOrKey: 'PROJ-1', assigneeAccountId: 'u1' });
    expect(issuesStub.update.mock.calls[0][1].assigneeAccountId).toBe('u1');
  });
});

describe('transitions & assignment handlers', () => {
  it('getTransitions wraps the list', async () => {
    issuesStub.getTransitions.mockResolvedValueOnce([{ id: '1', name: 'Go', to_status: 'Done' }]);
    expect(payload(await handlerFor('getTransitions')({ issueIdOrKey: 'PROJ-1' }))).toEqual({
      transitions: [{ id: '1', name: 'Go', to_status: 'Done' }],
    });
  });

  it('transitionIssue calls the domain method and reports success', async () => {
    issuesStub.transition.mockResolvedValueOnce(undefined);
    expect(
      payload(await handlerFor('transitionIssue')({ issueIdOrKey: 'PROJ-1', transitionId: '5' }))
    ).toEqual({
      transitioned: true,
    });
    expect(issuesStub.transition).toHaveBeenCalledWith('PROJ-1', '5');
  });

  it('assignIssue defaults a missing accountId to null', async () => {
    issuesStub.assign.mockResolvedValueOnce(undefined);
    await handlerFor('assignIssue')({ issueIdOrKey: 'PROJ-1' });
    expect(issuesStub.assign).toHaveBeenCalledWith('PROJ-1', null);
  });

  it('assignIssue forwards an explicit accountId', async () => {
    issuesStub.assign.mockResolvedValueOnce(undefined);
    await handlerFor('assignIssue')({ issueIdOrKey: 'PROJ-1', accountId: 'u9' });
    expect(issuesStub.assign).toHaveBeenCalledWith('PROJ-1', 'u9');
  });
});

describe('getMyself handler', () => {
  it('wraps the account under `user`', async () => {
    issuesStub.getMyself.mockResolvedValueOnce({ account_id: 'me' });
    expect(payload(await handlerFor('getMyself')({}))).toEqual({ user: { account_id: 'me' } });
  });
});

describe('addAttachment handler validation', () => {
  it('errors when issueIdOrKey is missing, with teaching next-step guidance', async () => {
    const res = await handlerFor('addAttachment')({ filePath: '/workspace/bug.png' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/issueIdOrKey/);
    expect(res.content[0].text).toMatch(/Provide the Jira issue key/);
    expect(issuesStub.addAttachment).not.toHaveBeenCalled();
  });

  it('errors when filePath is missing, with teaching next-step guidance', async () => {
    const res = await handlerFor('addAttachment')({ issueIdOrKey: 'PROJ-1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/filePath/);
    expect(res.content[0].text).toMatch(/Provide a path under \/workspace/);
    expect(issuesStub.addAttachment).not.toHaveBeenCalled();
  });
});

describe('addAttachment handler via filePath', () => {
  let ws: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.WORKSPACE_DIR;
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'atl-ws-')));
    process.env.WORKSPACE_DIR = ws;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = prevEnv;
    rmSync(ws, { recursive: true, force: true });
  });

  it('reads a workspace file, derives the filename, and forwards the bytes', async () => {
    writeFileSync(join(ws, 'bug.png'), Buffer.from('real-png-bytes'));
    issuesStub.addAttachment.mockResolvedValueOnce({ id: '1', filename: 'bug.png' });
    const res = await handlerFor('addAttachment')({
      issueIdOrKey: 'PROJ-1',
      filePath: join(ws, 'bug.png'),
    });
    const [key, p] = issuesStub.addAttachment.mock.calls[0];
    expect(key).toBe('PROJ-1');
    expect(p.filename).toBe('bug.png');
    expect(Buffer.isBuffer(p.data)).toBe(true);
    expect(p.data.toString()).toBe('real-png-bytes');
    expect(p.contentType).toBe('application/octet-stream');
    expect(payload(res)).toEqual({ attachment: { id: '1', filename: 'bug.png' } });
  });

  it('accepts a relative path resolved against the workspace root', async () => {
    writeFileSync(join(ws, 'shot.png'), Buffer.from('x'));
    issuesStub.addAttachment.mockResolvedValueOnce({ id: '2' });
    await handlerFor('addAttachment')({ issueIdOrKey: 'PROJ-1', filePath: 'shot.png' });
    expect(issuesStub.addAttachment.mock.calls[0][1].filename).toBe('shot.png');
  });

  it('lets an explicit filename override the basename', async () => {
    writeFileSync(join(ws, 'shot.png'), Buffer.from('x'));
    issuesStub.addAttachment.mockResolvedValueOnce({ id: '3' });
    await handlerFor('addAttachment')({
      issueIdOrKey: 'PROJ-1',
      filePath: 'shot.png',
      filename: 'renamed.png',
    });
    expect(issuesStub.addAttachment.mock.calls[0][1].filename).toBe('renamed.png');
  });

  it('rejects a path that escapes the workspace (no /tokens exfiltration)', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'atl-out-')));
    writeFileSync(join(outside, 'secret'), Buffer.from('token'));
    const res = await handlerFor('addAttachment')({
      issueIdOrKey: 'PROJ-1',
      filePath: join(outside, 'secret'),
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/inside the workspace/);
    expect(issuesStub.addAttachment).not.toHaveBeenCalled();
    rmSync(outside, { recursive: true, force: true });
  });

  it('errors when the file does not exist', async () => {
    const res = await handlerFor('addAttachment')({
      issueIdOrKey: 'PROJ-1',
      filePath: 'nope.png',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
  });

  it('passes an explicit contentType through', async () => {
    writeFileSync(join(ws, 'shot.png'), Buffer.from('x'));
    issuesStub.addAttachment.mockResolvedValueOnce({ id: '4' });
    await handlerFor('addAttachment')({
      issueIdOrKey: 'PROJ-1',
      filePath: 'shot.png',
      contentType: 'image/png',
    });
    expect(issuesStub.addAttachment.mock.calls[0][1].contentType).toBe('image/png');
  });

  it('surfaces a thrown domain error as an error result', async () => {
    writeFileSync(join(ws, 'shot.png'), Buffer.from('x'));
    issuesStub.addAttachment.mockRejectedValueOnce(new Error('boom-attach'));
    const res = await handlerFor('addAttachment')({ issueIdOrKey: 'PROJ-1', filePath: 'shot.png' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/boom-attach/);
  });

  it('errors when filePath points to a directory', async () => {
    mkdirSync(join(ws, 'subdir'));
    const res = await handlerFor('addAttachment')({
      issueIdOrKey: 'PROJ-1',
      filePath: join(ws, 'subdir'),
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Not a regular file/);
    expect(issuesStub.addAttachment).not.toHaveBeenCalled();
  });
});

describe('addAttachment handler size cap', () => {
  let ws: string;
  let prevWorkspace: string | undefined;
  let prevMax: string | undefined;

  beforeEach(() => {
    prevWorkspace = process.env.WORKSPACE_DIR;
    prevMax = process.env.ATLASSIAN_MAX_ATTACHMENT_BYTES;
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'atl-ws-cap-')));
    process.env.WORKSPACE_DIR = ws;
    process.env.ATLASSIAN_MAX_ATTACHMENT_BYTES = '10';
    vi.resetModules();
  });
  afterEach(() => {
    if (prevWorkspace === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = prevWorkspace;
    if (prevMax === undefined) delete process.env.ATLASSIAN_MAX_ATTACHMENT_BYTES;
    else process.env.ATLASSIAN_MAX_ATTACHMENT_BYTES = prevMax;
    rmSync(ws, { recursive: true, force: true });
    vi.resetModules();
  });

  /** Re-import the module fresh so it re-reads `ATLASSIAN_MAX_ATTACHMENT_BYTES` from env. */
  async function freshAddAttachmentDef() {
    const mod = await import('./jira-issue-tools.js');
    return mod.createJiraIssueTools(FAKE_CLIENT).find((d) => d.tool.name === 'addAttachment')!;
  }

  it('rejects a file over the configured byte cap before reading it into memory', async () => {
    writeFileSync(join(ws, 'big.bin'), Buffer.alloc(11, 'x'));
    const def = await freshAddAttachmentDef();
    const res = await def.handler({ issueIdOrKey: 'PROJ-1', filePath: 'big.bin' } as never);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/too large to attach/);
    expect(res.content[0].text).toMatch(/11 bytes > 10 byte limit/);
    expect(issuesStub.addAttachment).not.toHaveBeenCalled();
  });

  it('accepts a file at exactly the byte cap', async () => {
    writeFileSync(join(ws, 'ok.bin'), Buffer.alloc(10, 'x'));
    issuesStub.addAttachment.mockResolvedValueOnce({ id: '1' });
    const def = await freshAddAttachmentDef();
    const res = await def.handler({ issueIdOrKey: 'PROJ-1', filePath: 'ok.bin' } as never);
    expect(res.isError).toBeUndefined();
    expect(issuesStub.addAttachment).toHaveBeenCalledTimes(1);
  });

  it('states the configured byte cap in the tool description', async () => {
    const def = await freshAddAttachmentDef();
    expect(def.tool.description).toMatch(/capped at 10 bytes/);
    expect(def.tool.description).not.toMatch(/streams it/);
  });
});

describe('deleteAttachment handler', () => {
  it('is marked destructive in its annotations', () => {
    const def = createJiraIssueTools(FAKE_CLIENT).find((d) => d.tool.name === 'deleteAttachment');
    expect(def?.tool.annotations?.destructiveHint).toBe(true);
    expect(def?.tool.annotations?.readOnlyHint).toBe(false);
  });

  it('delegates to the domain and reports deletion', async () => {
    issuesStub.deleteAttachment.mockResolvedValueOnce(undefined);
    const res = await handlerFor('deleteAttachment')({ attachmentId: '10475' });
    expect(issuesStub.deleteAttachment).toHaveBeenCalledWith('10475');
    expect(payload(res)).toEqual({ deleted: true });
  });

  it('errors when attachmentId is missing, with teaching next-step guidance', async () => {
    const res = await handlerFor('deleteAttachment')({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/attachmentId/);
    expect(res.content[0].text).toMatch(/Provide the Jira attachment ID/);
    expect(issuesStub.deleteAttachment).not.toHaveBeenCalled();
  });

  it('surfaces a thrown domain error (e.g. allowlist scope) as an error result', async () => {
    issuesStub.deleteAttachment.mockRejectedValueOnce(new Error('allowlist configured'));
    const res = await handlerFor('deleteAttachment')({ attachmentId: '10475' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/allowlist/);
  });
});
