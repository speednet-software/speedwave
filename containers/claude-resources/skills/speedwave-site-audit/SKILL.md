---
name: speedwave-site-audit
description: >
  Audit a website against a bundled checklist of best-practice rules (Foundations, SEO,
  Accessibility, Security, Performance, Privacy, Resilience, i18n, Well-Known URIs, Agent
  Readiness) and report which pass, fail, or are skipped — with evidence. Use when the user
  asks to "audit a site", "check if a website is built correctly", "review accessibility /
  SEO / security of a page", or "run the website checklist". Works on one URL or every URL
  from the sitemap (pairs with speedwave-sitemap). Always runs a final verifier pass.
  Do not use for: producing a sitemap (use speedwave-sitemap), or fixing the issues — this
  skill only reports.
argument-hint: '<url> [--scope page|sitemap] [--categories C1,C2] [--output_path P]'
allowed-tools: WebFetch mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code Write Agent
---

# Site Audit

Audit pages against `rules.json` (bundled beside this file) and report pass/fail/skip per rule, per page, with evidence. You report findings — you never fix the site.

## Step 1 — Scope the audit (always ask)

Before auditing, ask the user two things unless they already said them:

1. **Which pages?**
   - **This URL only** — audit the single page the user named.
   - **The whole site (sitemap)** — invoke the `speedwave-sitemap` skill to get the URL inventory, then audit each URL. This is the tandem: sitemap produces the list, you audit it.
2. **Which categories?** Offer the category list from `rules.json` `meta.categories` (Foundations, SEO, Accessibility, Security, Well-Known URIs, Agent Readiness, Performance, Privacy, Resilience, Internationalisation) plus **All**. Audit only the chosen categories' rules.

For a host dev server the user calls "localhost:PORT", treat it the same way `speedwave-sitemap` does — rewrite to `http://host.docker.internal:PORT` for any rendered check (see Step 3).

## Step 2 — Load the rules

Read `rules.json` from this skill's directory. If `/workspace/.speedwave/audit-rules.json` exists, use it instead (project override). Each rule carries: `id`, `category`, `status` (required/recommended/optional/avoid), `check_method`, `what_to_look_for`, `pass_when`, `fail_when`, `evidence_hint`. Filter to the chosen categories.

## Step 3 — Check Playwright availability (gating)

13 rules have `check_method: rendered` — they need a live browser (contrast, keyboard focus, reduced-motion, touch-target size, Core Web Vitals, BFCache, GPC, offline fallback, CJK line-break, locale formatting, plural rules, WebMCP). Probe: `search_tools { query: "browser", detail_level: "full_schema" }`.

- **Playwright available** → run rendered checks via the Playwright integration (see Playwright sandbox rules below).
- **Playwright disabled** → do NOT guess a rendered verdict. Mark every `rendered` rule `status: "skipped"`, `reason: "playwright-disabled"`, and tell the user once that enabling Playwright unlocks those 13 rules. All non-rendered rules still run.

## Step 4 — Audit each page against each rule

Per page, evaluate each in-scope rule by its `check_method`:

- **`static_html`** — `WebFetch` the page; inspect the raw HTML for the signal in `what_to_look_for`.
- **`http_header`** — `WebFetch` the page and read response headers/status. Three rules are **DNS-over-HTTPS** (`security.dns-caa`, `security.dnssec`, `agent-readiness.dns-aid`): their `what_to_look_for` gives the exact `https://dns.google/resolve?...` URL — `WebFetch` it and read the JSON `Answer`/`AD` flag.
- **`sitemap`** — inspect the site's `sitemap.xml` (reuse the inventory from `speedwave-sitemap` when available).
- **`rendered`** — drive Playwright (Step 3).

Assign each rule one verdict: **pass** (meets `pass_when`), **fail** (meets `fail_when`), **skipped** (couldn't check — say why), or **n/a** (rule's precondition absent, e.g. an OIDC well-known on a site with no login). Capture the evidence named in `evidence_hint` (a quoted tag, a header line, a control name). Never assert a verdict without the evidence.

## Step 5 — Verifier pass (always)

After auditing all pages, **always** spawn one verifier agent (`Agent`) over the assembled report. Give it the findings and the rule definitions and ask it to find: false positives (a fail whose evidence doesn't actually meet `fail_when`), false negatives (a pass that ignores a real violation), and verdicts asserted without evidence. Downgrade or correct any finding the verifier overturns. Only the verified report is final.

## Playwright sandbox rules

Same restrictions as `speedwave-sitemap` — read before any `execute_code`:

- Drive the browser via `playwright.browserRunCode({ code: "async (page) => { … }" })`; `await` the call.
- Forbidden text patterns are rejected even inside strings — never write `eval(`, `$$eval(`, or `globalThis`. Use `page.evaluate(fn)`; for computed styles read them inside `page.evaluate`.
- The Node runner has no `URL`/`document`/DOM globals — only the browser context does. Do contrast/focus/style inspection inside `page.evaluate`.
- One `execute_code` call has a ~90s budget and no state persists between calls. Audit pages in batches; for many pages, persist progress in the page's `localStorage` and repeat until done.
- Use `waitUntil: "domcontentloaded"`. Reach a host dev server via `http://host.docker.internal:PORT` (Speedwave injects the alias, ADR-062).
- No `/workspace` in the Playwright container — return verdicts/evidence as the call's value; write the report from the Claude container.

## Output

Write two files into the output directory (default `/workspace/.speedwave/site-audit/`, set by `output_path`; create it). Keep outputs under `/workspace/.speedwave/` so they never clutter the project root.

First, the machine-readable `audit.json` (shape below):

```json
{
  "meta": {
    "scope": "sitemap",
    "categories": ["Accessibility", "Security"],
    "pages_audited": 12,
    "rules_per_page": 32,
    "playwright": "available",
    "verified": true
  },
  "pages": [
    {
      "url": "https://example.com/",
      "findings": [
        {
          "id": "foundations.doctype",
          "category": "Foundations",
          "status": "required",
          "verdict": "pass",
          "evidence": "<!doctype html>"
        },
        {
          "id": "accessibility.image-alt-text",
          "category": "Accessibility",
          "status": "required",
          "verdict": "fail",
          "evidence": "<img src=hero.jpg> has no alt"
        },
        {
          "id": "accessibility.colour-contrast",
          "category": "Accessibility",
          "status": "required",
          "verdict": "skipped",
          "reason": "playwright-disabled"
        }
      ]
    }
  ],
  "summary": { "pass": 0, "fail": 0, "skipped": 0, "na": 0 }
}
```

Then write a **human-readable report** to `report.md` in the same directory AND print its body in the chat. It is the primary deliverable for the user; the JSON is for other tools.

The report has, per page, one Markdown table — every in-scope rule as a row, grouped by category, in `rules.json` order:

```markdown
# Site audit — https://example.com/

**Scope:** sitemap (12 pages) · **Categories:** Accessibility, Security · **Playwright:** available · **Verified:** yes

## https://example.com/ ✅ 28 · ❌ 3 · ⏭️ 1

### Accessibility

| Rule                             | Status   | Result  | Evidence                         |
| -------------------------------- | -------- | ------- | -------------------------------- |
| Image alt text                   | required | ❌ FAIL | `<img src=hero.jpg>` has no alt  |
| Visible keyboard focus indicator | required | ✅ PASS | every control shows a focus ring |
| Colour contrast                  | required | ⏭️ SKIP | playwright-disabled              |
| OIDC discovery doc               | optional | ➖ N/A  | site has no login                |

### Security

| Rule                | Status   | Result  | Evidence                                                                  |
| ------------------- | -------- | ------- | ------------------------------------------------------------------------- |
| HSTS header present | required | ✅ PASS | `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` |
```

Rules for the table:

- One row per in-scope rule, even passes — the user wants the full checklist ticked off, not just failures.
- `Result` glyphs: ✅ PASS, ❌ FAIL, ⏭️ SKIP, ➖ N/A. `Status` is the rule's required/recommended/optional/avoid.
- `Evidence` quotes the captured proof (`evidence_hint`); for SKIP put the reason, for N/A put why it doesn't apply.
- Each page section header carries a per-page tally (✅/❌/⏭️). End the report with an **overall summary table** across all pages: counts of PASS/FAIL/SKIP/N/A per category, and a FAIL count split by `status` (required fails first — they matter most).
- Sort failures to the top within each category table when a page has many rules, so the eye lands on problems first.

After writing both files, print the `report.md` body in the chat and state the two paths. Nothing more.

## Rules

- **Report, never fix.** State findings with evidence; do not edit the site or suggest patches unless asked.
- **Evidence or no verdict.** A fail without quoted evidence is not a finding — mark it skipped and say why.
- **Degrade, never fake.** A check you can't run (Playwright off, page unreachable) is `skipped` with a reason, never a guessed pass/fail.
- **Respect the sitemap caps.** When auditing the whole site, audit the URLs `speedwave-sitemap` returns — don't crawl further yourself.
