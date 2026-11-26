import { pageLib } from './page.js';

const KEEPALIVE_MS = 20_000;
const LOAD_TIMEOUT_MS = 30_000;
const GROUP_TITLE = 'Speedwave';

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
};

const conn = {
  ws: null,
  state: 'disconnected',
  detail: 'Not configured',
  retryMs: 1000,
  retryTimer: null,
};
const attached = new Set();
const groupByWindow = new Map();

const handlers = {
  hello: async () => ({
    extension: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
  }),
  listTabs: async () => (await chrome.tabs.query({})).map(tabInfo),
  openTab: async ({ url, newWindow }) => {
    requireString(url, 'url');
    const tab = newWindow
      ? (await chrome.windows.create({ url, focused: true })).tabs[0]
      : await chrome.tabs.create({ url, active: true });
    await addToGroup(tab);
    return tabInfo(await waitForLoad(tab.id));
  },
  navigate: async ({ tabId, url, action }) => {
    const tab = await resolveTab(tabId);
    if (url) await chrome.tabs.update(tab.id, { url });
    else if (action === 'back') await chrome.tabs.goBack(tab.id);
    else if (action === 'forward') await chrome.tabs.goForward(tab.id);
    else if (action === 'reload') await chrome.tabs.reload(tab.id);
    else throw new Error('navigate needs url or action (back, forward, reload)');
    return tabInfo(await waitForLoad(tab.id));
  },
  closeTab: async ({ tabId }) => {
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  },
  readPage: async ({ tabId, mode = 'interactive', maxChars = 50_000 }) => {
    const tab = await resolveTab(tabId);
    return callPage(tab.id, 'read', { mode, maxChars });
  },
  click: async ({ tabId, ref, selector, x, y }) => {
    const tab = await resolveTab(tabId);
    const point = ref || selector ? await locate(tab.id, ref, selector) : { x, y };
    if (typeof point.x !== 'number' || typeof point.y !== 'number')
      throw new Error('click needs ref, selector or x and y');
    await mouseClick(tab.id, point.x, point.y);
    return settle(tab.id);
  },
  type: async ({ tabId, ref, selector, text, clear, submit }) => {
    requireString(text, 'text');
    const tab = await resolveTab(tabId);
    if (ref || selector) {
      const point = await locate(tab.id, ref, selector);
      await mouseClick(tab.id, point.x, point.y);
    }
    if (clear) await callPage(tab.id, 'selectAll', {});
    await cdp(tab.id, 'Input.insertText', { text });
    if (submit) await pressKey(tab.id, 'Enter');
    return settle(tab.id);
  },
  pressKey: async ({ tabId, key }) => {
    const tab = await resolveTab(tabId);
    await pressKey(tab.id, key);
    return settle(tab.id);
  },
  scroll: async ({ tabId, ref, selector, dy }) => {
    const tab = await resolveTab(tabId);
    return callPage(tab.id, 'scroll', { ref, selector, dy: dy ?? 0 });
  },
  screenshot: async ({ tabId, quality = 70 }) => {
    const tab = await resolveTab(tabId);
    await chrome.tabs.update(tab.id, { active: true });
    const shot = await cdp(tab.id, 'Page.captureScreenshot', { format: 'jpeg', quality });
    return { data: shot.data, mimeType: 'image/jpeg' };
  },
  evalJs: async ({ tabId, code }) => {
    requireString(code, 'code');
    const tab = await resolveTab(tabId);
    return { value: (await evaluate(tab.id, code)) ?? null };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'status') {
    sendResponse({ state: conn.state, text: statusText() });
  } else if (message.type === 'connect') {
    chrome.storage.local.set({ url: message.url, token: message.token, enabled: true }).then(() => {
      conn.retryMs = 1000;
      reconnect();
      sendResponse({ ok: true });
    });
    return true;
  } else if (message.type === 'disconnect') {
    chrome.storage.local.set({ enabled: false }).then(() => {
      closeSocket('Disconnected by you');
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});

chrome.debugger.onDetach.addListener((source) => attached.delete(source.tabId));
chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId));
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => ensureConnected());
setInterval(() => {
  if (conn.ws && conn.ws.readyState === WebSocket.OPEN)
    conn.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }));
}, KEEPALIVE_MS);
ensureConnected();

async function ensureConnected() {
  if (conn.ws && conn.ws.readyState <= WebSocket.OPEN) return;
  if (conn.retryTimer) return;
  await reconnect();
}

async function reconnect() {
  clearTimeout(conn.retryTimer);
  conn.retryTimer = null;
  const { url, token, enabled } = await chrome.storage.local.get(['url', 'token', 'enabled']);
  if (!enabled || !url || !token) {
    setState('disconnected', url && token ? 'Disconnected' : 'Not configured');
    return;
  }
  if (conn.ws) conn.ws.onclose = null;
  conn.ws?.close();
  let ws;
  try {
    ws = new WebSocket(`${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`);
  } catch (error) {
    setState('error', `Bad URL: ${error.message}`);
    return;
  }
  conn.ws = ws;
  setState('waiting', 'Connecting to Speedwave Desktop');
  ws.onopen = () => {
    conn.retryMs = 1000;
    setState('waiting', 'Connected to Speedwave Desktop, waiting for a Speedwave session');
  };
  ws.onmessage = (event) => {
    setState('connected', 'Connected to Speedwave');
    handleFrame(ws, event.data);
  };
  ws.onclose = () => {
    if (conn.ws !== ws) return;
    conn.ws = null;
    setState('disconnected', 'Connection lost, retrying');
    conn.retryTimer = setTimeout(reconnect, conn.retryMs);
    conn.retryMs = Math.min(conn.retryMs * 2, 15_000);
  };
}

function closeSocket(detail) {
  clearTimeout(conn.retryTimer);
  conn.retryTimer = null;
  if (conn.ws) {
    conn.ws.onclose = null;
    conn.ws.close();
    conn.ws = null;
  }
  setState('disconnected', detail);
}

async function handleFrame(ws, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message.id || !message.method) return;
  const handler = handlers[message.method];
  let reply;
  try {
    if (!handler) throw new Error(`Unknown method ${message.method}`);
    reply = { jsonrpc: '2.0', id: message.id, result: await handler(message.params ?? {}) };
  } catch (error) {
    reply = { jsonrpc: '2.0', id: message.id, error: { message: error?.message ?? String(error) } };
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
}

function setState(state, detail) {
  conn.state = state;
  conn.detail = detail;
  const badge = { connected: 'ON', waiting: '...', disconnected: '', error: '!' }[state];
  chrome.action.setBadgeText({ text: badge });
  chrome.action.setBadgeBackgroundColor({ color: state === 'connected' ? '#1a7f37' : '#9a6700' });
}

function statusText() {
  return conn.detail;
}

function tabInfo(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url ?? tab.pendingUrl,
    title: tab.title,
    active: tab.active,
    status: tab.status,
    speedwave: tab.groupId !== -1 && [...groupByWindow.values()].includes(tab.groupId),
  };
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${name} must be a non-empty string`);
}

async function resolveTab(tabId) {
  if (typeof tabId === 'number') return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab; pass tabId');
  return tab;
}

async function addToGroup(tab) {
  const existing = groupByWindow.get(tab.windowId);
  if (existing !== undefined) {
    try {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: existing });
      return;
    } catch {
      groupByWindow.delete(tab.windowId);
    }
  }
  const groupId = await chrome.tabs.group({
    tabIds: [tab.id],
    createProperties: { windowId: tab.windowId },
  });
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'blue' });
  groupByWindow.set(tab.windowId, groupId);
}

async function waitForLoad(tabId) {
  const started = Date.now();
  await sleep(250);
  while (Date.now() - started < LOAD_TIMEOUT_MS) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await sleep(200);
  }
  return chrome.tabs.get(tabId);
}

async function settle(tabId) {
  await sleep(300);
  return tabInfo(await waitForLoad(tabId));
}

async function cdp(tabId, method, params) {
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (error) {
      if (!String(error?.message).includes('already attached')) throw error;
    }
    attached.add(tabId);
  }
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function evaluate(tabId, expression) {
  const response = await cdp(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    const details = response.exceptionDetails;
    throw new Error(details.exception?.description ?? details.text ?? 'Evaluation failed');
  }
  return response.result.value;
}

function callPage(tabId, method, args) {
  return evaluate(
    tabId,
    `(${pageLib.toString()})()[${JSON.stringify(method)}](${JSON.stringify(args)})`
  );
}

async function locate(tabId, ref, selector) {
  const point = await callPage(tabId, 'locate', { ref, selector });
  if (!point)
    throw new Error(
      `Element not found: ${ref ? `ref ${ref}` : `selector ${selector}`}. Call readPage again, refs change when the page re-renders.`
    );
  return point;
}

async function mouseClick(tabId, x, y) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
}

async function pressKey(tabId, name) {
  const spec = KEYS[name];
  if (!spec) throw new Error(`Unsupported key ${name}. Supported: ${Object.keys(KEYS).join(', ')}`);
  const base = { key: spec.key ?? name, code: spec.code, windowsVirtualKeyCode: spec.keyCode };
  await cdp(
    tabId,
    'Input.dispatchKeyEvent',
    spec.text ? { ...base, type: 'keyDown', text: spec.text } : { ...base, type: 'rawKeyDown' }
  );
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
