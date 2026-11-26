import { BridgeClient, BridgeError } from './bridge.js';
import { errorResult, jsonResult, textResult } from './server/index.js';
import type { Tool, ToolDefinition, ToolsCallResult } from './server/index.js';

type Annotations = NonNullable<Tool['annotations']>;

interface ToolSpec {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  annotations: Annotations;
  example: string;
  run: (bridge: BridgeClient, params: Record<string, unknown>) => Promise<ToolsCallResult>;
}

const READ: Annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const WRITE: Annotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const DESTRUCTIVE: Annotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};

const tabId = {
  type: 'number',
  description:
    'Tab id from listTabs or openTab. Omit to use the active tab of the last focused window.',
};
const target = {
  ref: { type: 'string', description: 'Element ref from readPage, e.g. "e12".' },
  selector: { type: 'string', description: 'CSS selector, used when no ref is given.' },
};

const forward =
  (method: string, timeoutMs?: number) =>
  async (bridge: BridgeClient, params: Record<string, unknown>): Promise<ToolsCallResult> =>
    jsonResult(await bridge.call(method, params, timeoutMs));

const SPECS: ToolSpec[] = [
  {
    name: 'listTabs',
    description:
      'List every open Chrome tab with its id, window, URL, title and whether Speedwave opened it.',
    properties: {},
    annotations: READ,
    example: 'await chrome.listTabs()',
    run: forward('listTabs'),
  },
  {
    name: 'openTab',
    description:
      'Open a URL in a new tab, or in a new window with newWindow: true. Waits for the page to load and returns the tab. Tabs opened here join the "Speedwave" tab group.',
    properties: {
      url: { type: 'string', description: 'Absolute URL to open.' },
      newWindow: { type: 'boolean', description: 'Open a new browser window instead of a tab.' },
    },
    required: ['url'],
    annotations: WRITE,
    example: "await chrome.openTab({ url: 'https://example.com', newWindow: true })",
    run: forward('openTab'),
  },
  {
    name: 'navigate',
    description:
      'Load a URL in a tab, or go back, forward or reload. Waits for the load to finish.',
    properties: {
      tabId,
      url: { type: 'string', description: 'Absolute URL to load.' },
      action: {
        type: 'string',
        enum: ['back', 'forward', 'reload'],
        description: 'Used when no url is given.',
      },
    },
    annotations: WRITE,
    example: "await chrome.navigate({ tabId: 123, url: 'https://example.com/login' })",
    run: forward('navigate'),
  },
  {
    name: 'closeTab',
    description: 'Close a tab.',
    properties: { tabId },
    required: ['tabId'],
    annotations: DESTRUCTIVE,
    example: 'await chrome.closeTab({ tabId: 123 })',
    run: forward('closeTab'),
  },
  {
    name: 'readPage',
    description:
      'Read the page. mode "interactive" (default) lists links, buttons and form fields with refs for click/type; "all" adds headings and text; "text" returns the visible text only.',
    properties: {
      tabId,
      mode: { type: 'string', enum: ['interactive', 'all', 'text'] },
      maxChars: { type: 'number', description: 'Truncate the output, default 50000.' },
    },
    annotations: READ,
    example: "await chrome.readPage({ tabId: 123, mode: 'all' })",
    run: async (bridge, params) => textResult(String(await bridge.call('readPage', params))),
  },
  {
    name: 'click',
    description:
      'Click an element by ref or CSS selector, or a point by x/y in CSS pixels of the viewport. Sends real mouse events.',
    properties: {
      tabId,
      ...target,
      x: { type: 'number' },
      y: { type: 'number' },
    },
    annotations: WRITE,
    example: "await chrome.click({ tabId: 123, ref: 'e12' })",
    run: forward('click'),
  },
  {
    name: 'type',
    description:
      'Type text into an element (focused by ref or selector), or into the focused element. clear empties the field first, submit presses Enter after typing.',
    properties: {
      tabId,
      ...target,
      text: { type: 'string' },
      clear: { type: 'boolean' },
      submit: { type: 'boolean' },
    },
    required: ['text'],
    annotations: WRITE,
    example: "await chrome.type({ tabId: 123, ref: 'e7', text: 'hello', submit: true })",
    run: forward('type'),
  },
  {
    name: 'pressKey',
    description:
      'Press a key in the page: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, PageUp, PageDown, Home, End, Space.',
    properties: { tabId, key: { type: 'string' } },
    required: ['key'],
    annotations: WRITE,
    example: "await chrome.pressKey({ tabId: 123, key: 'Escape' })",
    run: forward('pressKey'),
  },
  {
    name: 'scroll',
    description: 'Scroll an element into view (ref or selector) or scroll the page by dy pixels.',
    properties: { tabId, ...target, dy: { type: 'number' } },
    annotations: WRITE,
    example: 'await chrome.scroll({ tabId: 123, dy: 800 })',
    run: forward('scroll'),
  },
  {
    name: 'screenshot',
    description:
      'Screenshot of the visible part of a tab as a JPEG image. Activates the tab first.',
    properties: {
      tabId,
      quality: { type: 'number', description: 'JPEG quality 1-100, default 70.' },
    },
    annotations: READ,
    example: 'return await chrome.screenshot({ tabId: 123 })',
    run: async (bridge, params) => {
      const shot = (await bridge.call('screenshot', params)) as { data: string; mimeType: string };
      return { content: [{ type: 'image', data: shot.data, mimeType: shot.mimeType }] };
    },
  },
  {
    name: 'evalJs',
    description:
      'Evaluate a JavaScript expression in the page (main world, through the DevTools protocol, not blocked by the page CSP). Promises are awaited. For statements wrap them in an async IIFE: "(async () => { ...; return x })()". Returns the value as JSON.',
    properties: { tabId, code: { type: 'string' } },
    required: ['code'],
    annotations: DESTRUCTIVE,
    example: "await chrome.evalJs({ tabId: 123, code: 'document.title' })",
    run: forward('evalJs'),
  },
];

/**
 * Builds the MCP tool definitions served by this worker.
 */
export function createToolDefinitions(bridge: BridgeClient): ToolDefinition[] {
  return SPECS.map((spec) => ({
    tool: {
      name: spec.name,
      description: spec.description,
      inputSchema: {
        type: 'object',
        properties: spec.properties,
        ...(spec.required ? { required: spec.required } : {}),
      },
      annotations: spec.annotations,
      example: spec.example,
      keywords: ['chrome', 'browser', 'tab', 'page'],
    },
    handler: async (params) => {
      try {
        return await spec.run(bridge, params);
      } catch (error) {
        if (error instanceof BridgeError) return errorResult(`${error.code}: ${error.message}`);
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  }));
}
