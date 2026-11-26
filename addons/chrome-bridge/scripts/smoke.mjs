import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { WebSocketServer } = require('ws');
const playwrightDir =
  process.env.PLAYWRIGHT_DIR ?? join(homedir(), '.cache/pw-try/node_modules/playwright');
const { chromium } = createRequire(join(playwrightDir, 'package.json'))('playwright');

const TOKEN = 'smoke-token';
let rpcId = 0;
const PAGE = `<!doctype html><html><head><title>Smoke page</title><script src="/app.js" defer></script></head>
<body><h1>Chrome bridge smoke</h1><p>Some intro text.</p>
<a href="/second">Go to second page</a>
<form id="f"><label for="name">Your name</label><input id="name" name="name" placeholder="Type here">
<select name="color"><option>red</option><option>green</option></select>
<button type="submit">Send</button></form>
<button id="counter">Clicked 0 times</button><div id="out"></div></body></html>`;
const APP = `let n = 0;
document.getElementById('counter').addEventListener('click', (e) => { n++; e.target.textContent = 'Clicked ' + n + ' times'; });
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); document.getElementById('out').textContent = 'Hello ' + document.getElementById('name').value; });`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

const site = await listen(
  createServer((req, res) => {
    const headers = { 'content-security-policy': "script-src 'self'" };
    if (req.url === '/app.js')
      res.writeHead(200, { ...headers, 'content-type': 'text/javascript' }).end(APP);
    else if (req.url === '/second')
      res
        .writeHead(200, { ...headers, 'content-type': 'text/html' })
        .end('<title>Second</title><h2>Second page</h2>');
    else res.writeHead(200, { ...headers, 'content-type': 'text/html' }).end(PAGE);
  })
);
const relay = await startRelay();
const workerPort = 39000 + Math.floor(Math.random() * 1000);
const worker = spawn('node', [join(root, 'dist/index.js')], {
  env: {
    ...process.env,
    PORT: String(workerPort),
    HOST: '127.0.0.1',
    CHROME_BRIDGE_URL: `ws://127.0.0.1:${relay.port}/`,
    CHROME_BRIDGE_TOKEN: TOKEN,
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

let context;
try {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${join(root, 'extension')}`,
      `--load-extension=${join(root, 'extension')}`,
    ],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(sw.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.fill('#url', `ws://127.0.0.1:${relay.port}/`);
  await popup.fill('#token', TOKEN);
  await popup.click('#connect');
  await popup.waitForFunction(
    () => document.getElementById('status').textContent.includes('waiting'),
    null,
    { timeout: 10_000 }
  );
  check('popup connects to the relay', true, await popup.textContent('#status'));
  check(
    'relay saw the extension with the query token and an Origin',
    relay.desktopOrigin?.startsWith('chrome-extension://'),
    relay.desktopOrigin
  );

  await waitForHealth(workerPort);
  const call = (name, args = {}) => mcpCall(workerPort, name, args);

  const tools = await mcpRequest(workerPort, 'tools/list', {});
  check(
    'worker lists 11 tools',
    tools.result?.tools?.length === 11,
    tools.result?.tools?.map((t) => t.name).join(', ')
  );

  const opened = await call('openTab', { url: `http://127.0.0.1:${site.port}/`, newWindow: true });
  const tab = JSON.parse(opened.content[0].text);
  check(
    'openTab opens a window and waits for load',
    tab.title === 'Smoke page' && tab.speedwave === true,
    JSON.stringify(tab)
  );

  const page = (await call('readPage', { tabId: tab.tabId })).content[0].text;
  check(
    'readPage lists interactive elements with refs',
    /\[e\d+\] link "Go to second page"/.test(page) && /textbox|input type=text/.test(page),
    `\n${page}`
  );
  const ref = (pattern) =>
    page
      .split('\n')
      .find((line) => pattern.test(line))
      ?.match(/\[(e\d+)\]/)?.[1];

  await call('click', { tabId: tab.tabId, ref: ref(/Clicked 0 times/) });
  const afterClick = (await call('readPage', { tabId: tab.tabId })).content[0].text;
  check('click sends a real click', afterClick.includes('Clicked 1 times'));

  await call('type', {
    tabId: tab.tabId,
    ref: ref(/input type=text/),
    text: 'Zażółć 🙂',
    submit: true,
  });
  const text = (await call('readPage', { tabId: tab.tabId, mode: 'text' })).content[0].text;
  check(
    'type fills a field and submits with Enter',
    text.includes('Hello Zażółć 🙂'),
    text.split('\n').slice(-2).join(' | ')
  );

  await call('type', { tabId: tab.tabId, ref: ref(/input type=text/), text: 'Ann', clear: true });
  const value = JSON.parse(
    (await call('evalJs', { tabId: tab.tabId, code: "document.getElementById('name').value" }))
      .content[0].text
  );
  check(
    'type with clear replaces the value; evalJs runs under a strict CSP',
    value.value === 'Ann',
    JSON.stringify(value)
  );

  const asyncEval = JSON.parse(
    (
      await call('evalJs', {
        tabId: tab.tabId,
        code: '(async () => { await new Promise(r => setTimeout(r, 50)); return [1, 2].map(x => x * 2) })()',
      })
    ).content[0].text
  );
  check('evalJs awaits promises', JSON.stringify(asyncEval.value) === '[2,4]');

  const thrown = await call('evalJs', { tabId: tab.tabId, code: 'nope()' });
  check(
    'evalJs reports page exceptions as tool errors',
    thrown.isError === true && thrown.content[0].text.includes('nope'),
    thrown.content[0].text
  );

  const shot = await call('screenshot', { tabId: tab.tabId });
  check(
    'screenshot returns a JPEG image',
    shot.content[0].type === 'image' &&
      shot.content[0].mimeType === 'image/jpeg' &&
      shot.content[0].data.length > 1000
  );

  await call('click', { tabId: tab.tabId, ref: ref(/Go to second page/) });
  const second = (await call('readPage', { tabId: tab.tabId, mode: 'all' })).content[0].text;
  check(
    'clicking a link navigates',
    second.includes('Title: Second') && second.includes('## Second page')
  );

  const back = JSON.parse(
    (await call('navigate', { tabId: tab.tabId, action: 'back' })).content[0].text
  );
  check('navigate back', back.title === 'Smoke page', back.title);

  const tabs = JSON.parse((await call('listTabs')).content[0].text);
  check(
    'listTabs sees the tab',
    tabs.some((t) => t.tabId === tab.tabId)
  );

  const missing = await call('click', { tabId: tab.tabId, ref: 'e9999' });
  check(
    'stale ref gives a teaching error',
    missing.isError === true && missing.content[0].text.includes('readPage again'),
    missing.content[0].text
  );

  await call('closeTab', { tabId: tab.tabId });
  const afterClose = JSON.parse((await call('listTabs')).content[0].text);
  check('closeTab closes it', !afterClose.some((t) => t.tabId === tab.tabId));

  relay.dropPair();
  await new Promise((r) => setTimeout(r, 500));
  const reconnected = await call('listTabs');
  check(
    'worker and extension pair again after the relay drops them',
    !reconnected.isError,
    reconnected.content[0].text.slice(0, 80)
  );
} catch (error) {
  check('smoke run finished without an exception', false, error.stack);
} finally {
  await context?.close();
  worker.kill();
  relay.close();
  site.server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  );
}

async function startRelay() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));
  const state = {
    pending: {},
    buffers: {},
    pair: null,
    port: wss.address().port,
    desktopOrigin: null,
  };
  wss.on('connection', (socket, request) => {
    const url = new URL(request.url, 'http://x');
    const role =
      request.headers['x-chrome-bridge-auth'] === TOKEN
        ? 'worker'
        : url.searchParams.get('token') === TOKEN
          ? 'desktop'
          : null;
    if (!role) return socket.close(4001, 'unauthorized');
    if (role === 'desktop') state.desktopOrigin = request.headers.origin;
    state.pending[role]?.close();
    state.pending[role] = socket;
    state.buffers[role] = [];
    socket.on('message', (data) => {
      const other = state.pair?.find((s) => s !== socket);
      if (other) other.send(data.toString());
      else state.buffers[role]?.push(data.toString());
    });
    socket.on('close', () => {
      if (state.pending[role] === socket) delete state.pending[role];
      if (state.pair?.includes(socket)) {
        const pair = state.pair;
        state.pair = null;
        pair.forEach((s) => s.close());
      }
    });
    if (state.pending.worker && state.pending.desktop) {
      const { worker: w, desktop: d } = state.pending;
      const buffered = state.buffers;
      state.pending = {};
      state.buffers = {};
      state.pair = [w, d];
      buffered.worker?.forEach((m) => d.send(m));
      buffered.desktop?.forEach((m) => w.send(m));
    }
  });
  state.dropPair = () => state.pair?.forEach((s) => s.close());
  state.close = () => {
    wss.clients.forEach((c) => c.terminate());
    wss.close();
  };
  return state;
}

async function waitForHealth(port) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('worker did not start');
}

async function mcpRequest(port, method, params) {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return response.json();
}

async function mcpCall(port, name, args) {
  const response = await mcpRequest(port, 'tools/call', { name, arguments: args });
  if (response.error) throw new Error(`${name}: ${JSON.stringify(response.error)}`);
  return response.result;
}
