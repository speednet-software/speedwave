---
name: playwright-browser
description: Browse the web, take screenshots, and interact with pages using Playwright. Triggers on "screenshot", "open page", "browse", "navigate to", "take a screenshot", "full-page screenshot", "check website".
user-invocable: false
model: sonnet
---

# Playwright Browser Automation

You have access to a headless Chromium browser via the `playwright` service in `execute_code`. The browser runs in a hardened container — no filesystem sharing with your workspace.

## Key rules

1. **Screenshots return inline as base64** — they come back as multi-content `[{type:"text",...}, {type:"image", data:"<base64>", mimeType:"image/jpeg"}]`. The `filename` parameter tells Playwright where to write inside its container; you receive the image data directly in the response. Do NOT attempt to access `/tmp/playwright-mcp-output/` as a path in your workspace — it exists only inside the Playwright container.

2. **Always use `browserNavigate` for navigation**, not `browserRunCode`. It's simpler and more reliable.

3. **Always save screenshots to `/tmp/playwright-mcp-output/`** — the only writable path Playwright allows. Example: `filename: "/tmp/playwright-mcp-output/screenshot.jpeg"`

4. **Prefer viewport screenshots over full-page** — full-page (`fullPage: true`) crashes Chromium on heavy pages (news sites, pages with many ads/iframes). Use viewport screenshots by default. Only use `fullPage: true` on simple/lightweight pages when the user explicitly asks.

5. **Use JPEG format** — smaller than PNG, sufficient for most use cases. Set `type: "jpeg"`.

6. **After a crash ("Target crashed" or "Target page, context or browser has been closed")** — call `browserClose({})` first to reset the browser state, then retry with `browserNavigate`.

7. **Handle cookie/consent popups** — many sites show GDPR consent dialogs. After navigating, use `browserSnapshot` to check the page state, then `browserClick` to accept if needed.

## Workflow: Take a screenshot

```javascript
// Step 1: Navigate
await playwright.browserNavigate({ url: 'https://example.com' });

// Step 2: Screenshot (viewport)
const result = await playwright.browserTakeScreenshot({
  type: 'jpeg',
  filename: '/tmp/playwright-mcp-output/page.jpeg',
});

// result is already the image data — return it directly
return result;
```

## Workflow: Full-page screenshot (lightweight pages only)

```javascript
await playwright.browserNavigate({ url: 'https://example.com' });

const result = await playwright.browserTakeScreenshot({
  type: 'jpeg',
  filename: '/tmp/playwright-mcp-output/page-full.jpeg',
  fullPage: true,
});

return result;
```

## Workflow: Recover from crash

```javascript
// Reset browser
await playwright.browserClose({});

// Fresh navigation
await playwright.browserNavigate({ url: 'https://example.com' });

// Continue with screenshot or other actions
```

## Available tools (most common)

| Tool                    | Purpose                                                 |
| ----------------------- | ------------------------------------------------------- |
| `browserNavigate`       | Go to URL                                               |
| `browserTakeScreenshot` | Screenshot (viewport or full-page)                      |
| `browserSnapshot`       | Accessibility tree (for finding elements to click)      |
| `browserClick`          | Click an element (needs ref from snapshot)              |
| `browserType`           | Type text into a field                                  |
| `browserClose`          | Close page / reset browser                              |
| `browserTabs`           | Manage tabs (new, close, list, select)                  |
| `browserRunCode`        | Run arbitrary Playwright code (advanced, use sparingly) |
| `browserEvaluate`       | Run JS in page context                                  |
