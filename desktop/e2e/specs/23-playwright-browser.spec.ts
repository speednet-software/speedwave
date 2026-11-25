/**
 * Playwright worker E2E test.
 *
 * The Playwright MCP worker image is built only when the integration is
 * enabled, and no other spec enables it, so this is the one place the rigs
 * build and run it. On the provider project (e2e-test) it:
 *   - enables the built-in playwright integration and waits for the row to run
 *     (the first enable builds the image and pulls the ~1 GB browser base image);
 *   - drives one real browser call inside the worker container: an MCP
 *     Streamable HTTP session on 127.0.0.1:3000 that outlives the old
 *     heartbeat window, then browser_navigate and browser_snapshot against a
 *     page served from inside the container (no external network);
 *   - disables the integration again so later specs see the same state.
 *
 * Runs after spec 22 and before spec 07 (factory reset, always last).
 * All assertions use data-testid attributes, never UX-volatile text.
 */

import { composePrefix, engineExec } from '../helpers/engine';
import { openIntegrations, toggleIntegration, rowStatus } from '../helpers/llm';
import { switchToProject, activeProjectSlug } from '../helpers/projects';
import { confirmRestartAndWait } from '../helpers/shell';

const PROJECT = 'e2e-test';
const SERVICE = 'playwright';
const CONTAINER = `${composePrefix()}_${PROJECT}_mcp_playwright`;
const MARKER = 'speedwave-e2e-ok';
const ENABLE_WAIT_MS = 1_200_000;

const BROWSER_SCRIPT = String.raw`
const http = require('node:http');

const MCP_URL = 'http://127.0.0.1:3000/mcp';
const PAGE =
  '<html><head><title>speedwave-e2e</title></head><body><h1 id="m">speedwave-e2e-ok</h1></body></html>';
const MARKER = 'speedwave-e2e-ok';

function parseBody(contentType, text) {
  if (contentType.includes('text/event-stream')) {
    const datas = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter((l) => l.length > 0);
    let last = null;
    for (const d of datas) {
      const msg = JSON.parse(d);
      if (msg.id !== undefined || last === null) last = msg;
    }
    return last;
  }
  return text.trim() ? JSON.parse(text) : null;
}

async function post(body, headers) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 300));
  return { res, msg: parseBody(res.headers.get('content-type') || '', text) };
}

function textOf(result) {
  return (result.content || []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
}

async function main() {
  const out = {
    ok: false,
    navigateIsError: true,
    snapshotHasMarker: false,
    snapshotChars: 0,
    navigateText: '',
    snapshotText: '',
    error: null,
  };
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'speedwave-e2e', version: '0' },
      },
    });
    if (init.msg && init.msg.error) throw new Error('initialize: ' + JSON.stringify(init.msg.error));
    const sid = init.res.headers.get('mcp-session-id');
    if (!sid) throw new Error('no mcp-session-id header');
    const version = (init.msg && init.msg.result && init.msg.result.protocolVersion) || '2025-06-18';
    const session = { 'mcp-session-id': sid, 'mcp-protocol-version': version };

    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    await new Promise((resolve) => setTimeout(resolve, 8000));

    const nav = await post(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'browser_navigate', arguments: { url: 'http://127.0.0.1:' + port + '/' } },
      },
      session
    );
    if (nav.msg && nav.msg.error) throw new Error('browser_navigate: ' + JSON.stringify(nav.msg.error));
    out.navigateIsError = Boolean(nav.msg && nav.msg.result && nav.msg.result.isError);
    out.navigateText = textOf((nav.msg && nav.msg.result) || {}).slice(0, 2000);

    const snap = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } },
      session
    );
    if (snap.msg && snap.msg.error) throw new Error('browser_snapshot: ' + JSON.stringify(snap.msg.error));
    const text = textOf((snap.msg && snap.msg.result) || {});
    out.snapshotChars = text.length;
    out.snapshotText = text.slice(0, 500);
    out.snapshotHasMarker = text.includes(MARKER);
    out.ok = !out.navigateIsError && out.snapshotHasMarker;
  } catch (err) {
    out.error = String(err && err.message ? err.message : err);
  } finally {
    server.close();
  }
  console.log(JSON.stringify(out));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.log(JSON.stringify({ ok: false, navigateIsError: true, snapshotHasMarker: false, snapshotChars: 0, error: String(err) }));
    process.exit(0);
  }
);
`;

function runBrowserScript(): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(CONTAINER)) {
    throw new Error(`runBrowserScript: unsafe container name '${CONTAINER}'`);
  }
  const b64 = Buffer.from(BROWSER_SCRIPT, 'utf8').toString('base64');
  return engineExec(['sh', '-c', `echo ${b64} | base64 -d | nerdctl exec -i ${CONTAINER} node -`]);
}

describe('Playwright browser', function () {
  let enabled = false;

  before(async function () {
    this.timeout(180_000);
    if ((await activeProjectSlug()) !== PROJECT) {
      await switchToProject(PROJECT);
    }
    expect(await activeProjectSlug()).toBe(PROJECT);
    await openIntegrations();
  });

  it('enables Playwright and the worker reaches running', async function () {
    this.timeout(ENABLE_WAIT_MS + 120_000);
    await toggleIntegration(SERVICE);
    enabled = true;
    await confirmRestartAndWait(ENABLE_WAIT_MS);
    await openIntegrations();
    await browser.waitUntil(async () => (await rowStatus(SERVICE)) === 'running', {
      timeout: 120_000,
      interval: 3_000,
      timeoutMsg: `${SERVICE} row did not reach running after enable`,
    });
  });

  it('drives the browser through the MCP server inside the worker', async function () {
    this.timeout(180_000);
    const stdout = runBrowserScript();
    const lastLine =
      stdout
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .pop() ?? '';
    let result: { navigateIsError?: boolean; snapshotHasMarker?: boolean };
    try {
      result = JSON.parse(lastLine);
    } catch {
      throw new Error(`browser script printed no JSON, stdout: ${stdout}`);
    }
    const passed = result.navigateIsError === false && result.snapshotHasMarker === true;
    if (!passed) throw new Error(`browser script result: ${lastLine}`);
  });

  after(async function () {
    if (!enabled) return;
    this.timeout(ENABLE_WAIT_MS);
    await openIntegrations();
    await toggleIntegration(SERVICE);
    await confirmRestartAndWait();
    await openIntegrations();
    await browser.waitUntil(async () => (await rowStatus(SERVICE)) === 'disabled', {
      timeout: 120_000,
      interval: 3_000,
      timeoutMsg: `${SERVICE} row did not reach disabled after disable`,
    });
  });
});
