---
name: context7
description: Use Context7 to fetch current library/framework/API/SDK/CLI/cloud-service documentation whenever the user asks about a named technology — including setup, configuration, code examples, version migration, library-specific debugging, best practices, and "is X the right way to do Y" questions. Covers popular technologies such as React, Next.js, Angular, Vue, Svelte, Prisma, Drizzle, Express, NestJS, FastAPI, Django, Flask, Spring Boot, Tailwind, shadcn/ui, and any other named library, SDK, API, CLI tool, or cloud service. Use even when you think you know the answer — your training data may not reflect recent changes. Prefer this over web search for library docs. Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.
user-invocable: false
allowed-tools: mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code
---

When the user asks about a library, framework, API, CLI tool, or cloud service, use Context7 to fetch current documentation instead of relying on training data.

Access is through the Speedwave MCP Hub: use `search_tools` to inspect the schema, then `execute_code` with the injected `context7` global. The two methods exposed on that global are **`resolveLibraryId`** and **`queryDocs`**.

## Steps

1. **Always call `context7.resolveLibraryId` first** — pass the technology name as `libraryName` and the user's full question as `query`. Never pass a library name directly to `queryDocs`; the resolved Context7 ID is required.
2. **Pick the best match** — prefer exact name match, higher `trustScore`/`benchmarkScore`, and source reputation. Try alternate names or queries if results look off. Use a version-specific ID when the user mentions a version (e.g. `/vercel/next.js@v15.1.8`).
3. **Call `context7.queryDocs`** — pass the resolved ID and the user's full question; raise `tokens` up to 15 000 for deep dives.
4. **Answer using the fetched docs.**

Cache the resolved ID — don't re-resolve the same library every turn.

## Guidelines

- Pass the user's full question as `query` in both calls for better relevance ranking.
- Prefer official/primary entries over community forks.
- `libraryName` accepts any indexable source (Git repos, OpenAPI specs, npm packages, llms.txt, Confluence spaces) — not only code libraries.
