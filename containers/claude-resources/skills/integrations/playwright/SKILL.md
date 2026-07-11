---
name: playwright
description: Use Playwright integration to browse the web, take screenshots, and interact with web pages in a headless Chromium browser. Use whenever the user asks to screenshot a page, navigate to a URL, check what is on a website, fill a form, click through a flow, or extract content from a rendered page. Use even when you think you know the page content, websites change constantly, only the live browser reflects current rendering, JS-injected content, and dynamic state. Do not use for fetching plain HTML or JSON that does not need JavaScript rendering (use WebFetch), scraping that violates the site's terms of service, anything requiring credentials the user has not provided, or local file access (the Playwright container has no /workspace mount).
user-invocable: false
allowed-tools: mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code
---

# Playwright Browser Automation

Access via MCP Hub: `search_tools` to discover methods, `execute_code` with the injected `playwright` global. Runs as headless Chromium in a hardened container: **no filesystem sharing with `/workspace`**.

## Workflow

1. `search_tools { query: "browser", detail_level: "full_schema" }` to find the right method.
2. `execute_code` using exact parameter names from the schema.

## Pitfalls

- **Screenshots return inline as base64**: multi-content `[{type:"text",...}, {type:"image", data:"<base64>", mimeType:"image/jpeg"}]`. The `filename` parameter writes inside the Playwright container only. Do NOT access `/tmp/playwright-mcp-output/` from `/workspace`, it does not exist there.

- **No file bridge**: to get a PDF or screenshot into `/workspace`, use the base64 return value and write it from the Claude container.

- **Navigate, wait, act**: after `browserNavigate`, wait for the page to settle (`wait_for_selector` or page idle) before clicking or reading. Do NOT click immediately after navigate.

- **Page state persists within one `execute_code` call** but resets on the next call: plan multi-step flows inside a single `execute_code` block.

- **Prefer viewport screenshots**: `fullPage: true` can crash Chromium on ad-heavy or iframe-heavy pages. Use it only for simple pages when the user explicitly requests full-page.

- **After a crash** ("Target crashed" / "Target page, context or browser has been closed"): call `browserClose({})` first, then retry with `browserNavigate`.

- **Public URLs only**: no auth-walled sites unless you script the login flow explicitly.

## Confirmation rule

Most Playwright use is read-only (screenshots, scraping). Confirm with the user before interacting with auth-walled or paid services, or performing any write/destructive action on a live site.
