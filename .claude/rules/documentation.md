---
paths:
  - 'crates/**/*.rs'
  - 'desktop/src-tauri/**/*.rs'
  - 'mcp-servers/**/*.ts'
  - 'docs/**/*.md'
  - '*.md'
---

# Documentation Rules

Project documentation is exactly two things; there are no user guides, reference manuals, or architecture overviews in-repo:

- **ADRs (`docs/adr/`)** for big changes: any decision affecting the system's structure, security model, or platform behavior gets a new ADR named `ADR-NNN-kebab-case-title.md` plus an entry in the `docs/adr/README.md` index table. ADRs are historical records: never rewrite an accepted ADR to reflect later changes; supersede it with a new one and update its status in the index.
- **Rules (`.claude/rules/`)**: the working guidance, kept next to the code it describes. A missing guideline becomes a new self-contained rule file; a change that invalidates a rule statement fixes the rule in the same commit.

User-facing documentation (guides, installation, security overview, troubleshooting, reference) lives on the external site https://speedwave.dev/docs, maintained outside this repo. Do not create Markdown files under `docs/` outside `docs/adr/`; user-facing links in code, READMEs, and error messages point at the site, never at in-repo doc paths.

## ADR Writing Standards

Every factual claim in `docs/adr/` **must** have a footnote with a URL that confirms it. No exceptions.

- Technical specs, version numbers, license types, API behavior, platform requirements — all require a source link
- Use numbered footnotes `[^N]` at the end of each document
- If you cannot find a source, do not state the fact as certain — flag it as unverified
- The goal: anyone reading the ADR can independently verify every claim
