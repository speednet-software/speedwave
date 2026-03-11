---
paths:
  - 'docs/**/*.md'
  - '*.md'
---

# Documentation Rules

**Every feature, architectural change, and public API must be documented.** Documentation is not optional — it is a delivery requirement, same as tests.

## Documentation Structure

```
docs/
├── README.md                  <- entry point, table of contents
├── getting-started/           <- quickstart, installation, configuration
├── guides/                    <- CLI, desktop, integrations, IDE bridge
├── architecture/              <- overview, security, containers, platform matrix
├── contributing/              <- dev setup, testing
└── adr/                       <- Architecture Decision Records
```

## Rules

- **New feature -> update relevant guide.** If you add a CLI subcommand, update `docs/guides/cli.md`. If you add an integration, update `docs/guides/integrations.md`. If you change the security model, update `docs/architecture/security.md`.
- **Architectural decision -> write an ADR.** Any decision that affects the system's structure, security model, or platform behavior requires a new ADR in `docs/adr/` following the `ADR-NNN-kebab-case-title.md` naming convention. Update `docs/adr/README.md` index table.
- **New docs section -> link from `docs/README.md`.** Every new file must be reachable from the docs entry point.
- **No orphan docs.** Every Markdown file in `docs/` must be linked from at least one other file.
- **Keep skeletons honest.** Placeholder sections use `<!-- Content to be written: ... -->` HTML comments. When implementing a feature that fills a placeholder — replace it with real content in the same PR.

## ADR Writing Standards

Every factual claim in `docs/adr/` **must** have a footnote with a URL that confirms it. No exceptions.

- Technical specs, version numbers, license types, API behavior, platform requirements — all require a source link
- Use numbered footnotes `[^N]` at the end of each document
- If you cannot find a source, do not state the fact as certain — flag it as unverified
- The goal: anyone reading the ADR can independently verify every claim
