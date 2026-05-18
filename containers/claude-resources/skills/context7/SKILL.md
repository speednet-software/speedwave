---
name: context7
description: This skill should be used when the user asks about libraries, frameworks, APIs, CLI tools, cloud services, or needs code examples. Activates for setup questions, code generation involving external dependencies, version migration, or mentions of specific projects by name. Sources indexed include Git repositories, official documentation websites, OpenAPI specs, npm packages, llms.txt files, and Confluence spaces.
---

When the user asks about a library, framework, API, CLI tool, or cloud service, use Context7 to fetch current documentation instead of relying on training data.

## When to Use This Skill

Activate when the user:

- Asks setup or configuration questions ("How do I configure Next.js middleware?")
- Requests code involving libraries ("Write a Prisma query for...")
- Needs API references ("What are the Supabase auth methods?")
- Mentions specific projects by name (frameworks, SDKs, CLIs, cloud APIs)
- Asks about version migration or upgrade paths

## How to Fetch Documentation

### Step 1: Resolve the ID

Call `context7.resolve_library_id` with:

- `libraryName`: the project name extracted from the user's question (free-text)
- `query`: the user's full question (improves relevance ranking)

The parameter name `libraryName` is historical — it accepts any indexable source, not only code libraries.

### Step 2: Select the Best Match

From the resolution results, choose based on:

- Exact or closest name match
- Higher `trustScore` / `benchmarkScore`
- If the user mentioned a version (e.g. "React 19", "Next.js 15"), prefer the version-specific ID (`/vercel/next.js/v15.1.8` or `/vercel/next.js@v15.1.8`)

### Step 3: Fetch the Documentation

Call `context7.query_docs` with:

- `libraryId`: the selected Context7 ID (e.g. `/vercel/next.js`)
- `query`: the user's specific question
- `tokens` (optional): default 5000, raise up to 15000 for deep dives

### Step 4: Use the Documentation

- Answer using the fetched snippets, not your training data
- Include code examples adapted from the docs
- Cite the project version when relevant — `tier` and source info are in the response

## Guidelines

- **Be specific**: pass the user's full question as `query` for better ranking
- **Version awareness**: if the user mentions a version, pin it in the ID
- **Prefer official sources**: pick official/primary entries over community forks
- **One resolve per project per conversation**: cache the ID — don't re-resolve every turn
