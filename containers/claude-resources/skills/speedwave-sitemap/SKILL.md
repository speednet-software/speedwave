---
name: speedwave-sitemap
description: >
  Provide the URL inventory of a website as structured JSON for other skills to consume.
  First tries to extract an existing sitemap (robots.txt + common sitemap.xml paths, expanding
  sitemap indexes); if none is found, crawls the site via the Playwright integration (same-domain,
  bounded). Use whenever another skill or the user needs "the list of pages", "the sitemap",
  "all URLs of a site", or a page inventory to audit. Returns JSON only — no SEO analysis,
  no reports, no recommendations.
  Do not use for: auditing the pages, generating a sitemap from templates, or anything beyond
  producing the URL list.
argument-hint: "<url> [max_pages] [max_depth] [include_subdomains] [output_path]"
allowed-tools: WebFetch mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code Write
---

# Sitemap Provider

Produce one artifact: a JSON inventory of a site's URLs. Two acquisition strategies, tried in order. **No analysis** — you are a data source for other skills.

## Inputs

- `url` (required) — the site to inventory, e.g. `https://example.com`. For a server running on the **host** (a local dev server like `make dev` on `:4270`), the user will say "localhost:PORT" — rewrite it to `http://host.docker.internal:PORT` (see Reaching a host dev server below). A bare `localhost` reaches the worker container itself, not the host.
- `max_pages` (optional, default `200`) — crawl cap. Only applies to the crawl strategy.
- `max_depth` (optional, default `3`) — crawl depth from the start URL. Crawl strategy only.
- `include_subdomains` (optional, default `false`) — if `false`, restrict to the exact host of `url`.
- `output_path` (optional, default `/workspace/.speedwave/sitemap/sitemap.json`) — where to write the JSON. Keep outputs under `/workspace/.speedwave/sitemap/` so they never clutter the project root; create the directory if missing. Only `/workspace/.speedwave/` survives as the project's Speedwave-managed output area.

## Strategy 1 — Extract an existing sitemap (cheap, no browser)

1. `WebFetch` `<origin>/robots.txt` and extract every `Sitemap:` line.
2. If robots.txt yields nothing, probe common paths: `/sitemap.xml`, `/sitemap_index.xml`, `/sitemap-index.xml`, `/sitemap/sitemap.xml`.
3. For each sitemap found, `WebFetch` it. If it is a `<sitemapindex>`, recurse into each child `<loc>`. If it is a `<urlset>`, collect every `<loc>` (capture `<lastmod>` when present).
4. If at least one URL was collected, this is your result — set `source: "sitemap"` on every entry and skip Strategy 2.

`WebFetch` upgrades HTTP→HTTPS and is best for public sites with a published sitemap. A host dev server is usually HTTP-only and rarely publishes a sitemap, so for `host.docker.internal` targets expect Strategy 2 to run.

## Strategy 2 — Crawl via Playwright (when no sitemap was found)

Use the Playwright integration through the MCP Hub. It renders JS, so it catches SPA links a raw fetch misses.

**Reaching a host dev server.** Inside the Playwright container, `localhost` is the container, not the host. To reach a server the user runs on their machine, navigate to `http://host.docker.internal:<port>` — Speedwave injects that alias into the Playwright container for exactly this (ADR-062), so no per-platform gateway IP is needed. Seed the crawl with the `host.docker.internal` URL and keep the same-host check against `host.docker.internal` (not `localhost`), or every discovered link is treated as off-site and the crawl stops at one page.

1. Probe availability: `search_tools { query: "browser", detail_level: "full_schema" }`.
   - **If it returns nothing**, the Playwright integration is disabled. Do NOT fail silently: return whatever Strategy 1 produced, and if that was also empty, tell the user plainly: *"No sitemap.xml found and the Playwright integration is disabled — enable it for this project to crawl the site, or point me at a site that publishes a sitemap."* Stop.
2. Run a bounded breadth-first crawl. Use the exact method names from the schema. The crawl logic:
   - Maintain a queue of `{ url, depth }`, a `visited` set, and an `enqueued` set, seeded with the start URL at depth 0.
   - For each dequeued URL: `browserNavigate`, read the rendered DOM, collect same-host `<a href>` links, record `{ url, finalUrl, status, title, depth }`.
   - Enqueue not-yet-seen kept links at `depth+1` while `depth < max_depth` and `visited.size < max_pages`.
3. Set `source: "crawl"` on every entry. Respect the caps strictly. If you hit a cap, set `meta.truncated: true`.

Read the **Playwright sandbox rules** below before writing any `execute_code` — they are non-obvious and cost several wasted rounds when ignored.

## Playwright sandbox rules

The `execute_code` runner is restricted. Follow these or the crawl thrashes:

- **Drive the browser via `playwright.browserRunCode({ code: "async (page) => { … }" })`.** Pass the page-driver function as a string; `await` the call.
- **Forbidden text patterns** are rejected before execution — even inside strings. Never write `eval(`, `$$eval(`, or `globalThis`. Use `page.evaluate(fn)` for DOM work and `page.$$(...)` (not `$$eval`).
- **The Node runner has no `URL`, no `document`, no DOM globals** — only the browser context does. Resolve/normalize/filter links *inside* `page.evaluate((host) => { /* new URL(a.href) works here */ }, host)` and return plain strings. Plain `Set`/`Array`/`JSON` work fine in the runner.
- **State does NOT persist between `execute_code` calls** (fresh process each time) and **one call has a ~90s budget**. A crawl larger than one budget must persist its own state. Use the page's **`localStorage`** (per-origin, survives navigation and calls): read state at the start of each call, process a batch, write state back, return a small progress summary (`{ visitedCount, queueLen, done }`). Repeat the same `execute_code` until `done`, then read the records out of `localStorage` in a final call.
- **Use `waitUntil: "domcontentloaded"`, not `networkidle`** — `networkidle` adds seconds per page and is unnecessary for link extraction.
- **No `/workspace` in the Playwright container** — return data as the call's value; write the file from the Claude container (see Output).

## Output

Assemble the final JSON **in the Claude container** (from Strategy 1's parsed locs, or the records read out of Strategy 2's `localStorage` on the final call) and `Write` it to `output_path`. Shape:

```json
{
  "meta": {
    "start_url": "https://example.com",
    "source": "sitemap",
    "count": 42,
    "truncated": false
  },
  "urls": [
    { "url": "https://example.com/", "status": 200, "source": "sitemap", "depth": 0, "lastmod": "2026-05-01", "title": null },
    { "url": "https://example.com/about", "status": 200, "source": "crawl", "depth": 1, "lastmod": null, "title": "About" }
  ]
}
```

- `lastmod` and `title` are best-effort: `null` when the strategy did not provide them (sitemaps rarely give titles; crawls rarely give lastmod).
- `meta.source` is `"sitemap"` or `"crawl"` — whichever produced the URLs.
- After writing, report the path and the count to the caller. Nothing more.

## Rules

- **You are a provider, not an auditor.** Never comment on SEO, broken links, or page quality. Just the inventory.
- **Stay on the requested site.** Never follow off-domain links into the crawl (subdomains only when explicitly enabled).
- **Bounded by default.** The caps exist so a crawl cannot run away — honor them even when the user seems to want "everything".
- **Degrade, never fail silently.** If no URLs can be obtained, say why and what the user can do; do not write an empty file and claim success.
