# Chrome Bridge (PoC)

Speedwave plugin that lets Claude drive the user's own Chrome: open windows and tabs, read pages, click, type, press keys, scroll, take screenshots and evaluate JavaScript.

```
Claude (container) -> mcp-hub -> mcp-chrome worker (container)
                                   |  ws, header x-chrome-bridge-auth
                                   v
                     Speedwave Desktop host bridge (plugin host_bridge, Pairing mode)
                                   ^  ws, ?token=
                                   |
                     Chrome extension (extension/, MV3 service worker)
                                   |  chrome.debugger (CDP), chrome.tabs
                                   v
                                 pages
```

No Speedwave code changes: the worker and the extension meet in the generic plugin host bridge that the Figma plugin uses. The extension drives pages through the DevTools protocol (`Runtime.evaluate`, `Input.dispatchMouseEvent`, `Input.insertText`, `Page.captureScreenshot`), so clicks and keys are trusted events and `evalJs` is not blocked by a page's CSP. Chrome shows its "started debugging this browser" bar while it is attached.

## Layout

- `plugin.json`: manifest, `host_bridge` on port 60124 with a persistent token.
- `src/`: MCP worker. `bridge.ts` is the JSON-RPC client to the extension, `tools.ts` the 11 tools, `server/` a copy of the Figma plugin's MCP server.
- `extension/`: unpacked Chrome extension. `background.js` holds the connection and the command handlers, `page.js` the code evaluated in the page (page reader with `[eN]` refs, element lookup).
- `claude-resources/skills/chrome-browser/`: skill telling Claude how to use the tools.
- `scripts/build-plugin-zip.sh`: builds `dist/chrome-0.1.0.zip` (unsigned).
- `scripts/smoke.mjs`: end-to-end check with headless Chromium, the real extension, the real worker and a relay that mimics the host bridge pairing.

## Try it

On the Mac, from the repository root:

1. `cd addons/chrome-bridge && npm ci && ./scripts/build-plugin-zip.sh`
2. Start a dev instance (it sets `SPEEDWAVE_ALLOW_UNSIGNED=1`): `make dev DEV_INSTANCE=chrome-poc`
3. In that Speedwave Desktop, install `addons/chrome-bridge/dist/chrome-0.1.0.zip` as a plugin and enable it for a project.
4. In a separate Chrome profile: `chrome://extensions`, Developer mode, Load unpacked, pick `~/.speedwave-chrome-poc/plugins/chrome/extension/` (or `addons/chrome-bridge/extension/` directly).
5. Copy URL and Token from the plugin's Bridge connection card into the extension popup, click Connect. The popup says "waiting for a Speedwave session" until the worker pairs.
6. In the chat: "open example.com in a new Chrome window and tell me what is on it".

## Tests

- `npm test`: unit tests of the bridge client against a fake extension.
- `node scripts/smoke.mjs`: needs Playwright and a full Chromium (`PLAYWRIGHT_DIR` points at the `playwright` package, default `~/.cache/pw-try/node_modules/playwright`).
