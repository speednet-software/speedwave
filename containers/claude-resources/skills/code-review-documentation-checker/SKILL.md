---
name: code-review-documentation-checker
description: Verify if code changes require documentation updates. Use during code review to ensure documentation stays synchronized with code — prevents documentation drift.
user-invocable: false
---

# Documentation Checker

Audit code changes against documentation to prevent documentation drift — the gradual divergence between what code does and what documentation says.

## Core Principles

1. **Documentation must reflect reality** — every public API, configuration option, and behavior should be accurately documented
2. **Outdated docs are worse than no docs** — misleading documentation causes more problems than missing documentation
3. **Examples must work** — code examples in documentation should be valid and current
4. **Changes propagate** — a change in one place often requires updates in multiple documentation locations

## Review Scope

Review the changeset provided by the caller — a diff command, a diff/patch file, or an explicit file list. If no scope was provided, ask what to review; only as a last resort default to the working tree's uncommitted changes. Read enough surrounding code to judge each change in context.

## Project Conventions

Project guideline files are whichever of these exist: `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING*`, style guides, linter and formatter configs. Read them before forming a verdict and evaluate the change against them; escalate a finding by one severity level when it violates an explicit project rule. If no guideline files exist, infer conventions from the surrounding code and flag only clear violations of those conventions or of general best practice.

## Review Process

### 1. Identify Code Changes

Analyze the changeset to identify:

- New functions, methods, or classes
- Modified function signatures (parameters, return types)
- Changed or removed functionality
- New configuration options or environment variables
- Modified interfaces or type definitions
- Changed error messages or codes
- New dependencies or removed dependencies

### 2. Locate Related Documentation

For each change, identify documentation that may need updates:

**Project-level:** `*.md` in root, `docs/` directory, AI-assistant guideline files (`CLAUDE.md`, `AGENTS.md`) when present

**Code-level:** the language's doc-comment format (JSDoc/TSDoc, rustdoc, Python docstrings, Javadoc, godoc, XML docs), type definitions. Comment accuracy itself belongs to code-review-comment-analyzer — here check only whether changed behavior leaves documented claims stale.

**API documentation:** OpenAPI/Swagger specs, endpoint descriptions

**User documentation:** `docs/`, configuration guides

### 3. Analyze Documentation Gaps

For each identified change, check:

**Accuracy:** Does documentation describe current behavior? Are parameter names, types, return values correct? Are examples still valid?

**Completeness:** Is new functionality documented? Are all parameters documented? Are edge cases and error conditions described?

**Consistency:** Is terminology consistent across docs? Do cross-references still work?

### 4. Prioritize Findings

- Critical: documentation is actively misleading or examples are broken
- Important: new public API lacks documentation, or a significant behavior change is undocumented
- Suggestion: minor improvements, enhanced clarity, optional additions

## Special Considerations

**Focus on public interfaces** — internal implementation details don't always need documentation. Public APIs, exported functions, and user-facing features are priority.

**Consider the audience:**

- `README.md` targets new users and evaluators
- API docs target developers integrating with the code
- AI-assistant guideline files (`CLAUDE.md`, `AGENTS.md`), when present, target AI assistants working with the codebase
- `docs/` targets the team

**Check for cascade effects** — a renamed function may be referenced in multiple docs. A changed config option may appear in examples throughout.

**Verify examples** — mentally trace through code examples. Flag examples that use deprecated or renamed APIs. Note examples missing error handling that's now required.

Report missing documentation for new public surface as Important findings anchored to the code that needs documenting.

## Output Contract

Use exactly three severity levels:

- **Critical** — must fix before merge: a definite bug, an exploitable vulnerability, a violation of an explicit project rule, or a change that corrupts data or breaks consumers.
- **Important** — should fix: a probable defect, a significant design or maintainability problem, or a gap likely to cause real trouble soon.
- **Suggestion** — worth considering: a clear, optional improvement.

Report only findings you would defend in a peer review: each needs a concrete failure scenario or a specific violated rule or convention, not a theoretical possibility. Quality over quantity — when unsure, leave it out.

Structure the report exactly as follows, substituting this skill's `name` for `SKILL_NAME`:

```
# SKILL_NAME report

Scope: <what was reviewed>

## Critical

- `file:line` — <finding in 1-2 sentences>. Fix: <concrete suggestion>.

## Important

- <same bullet format>

## Suggestions

- <same bullet format>
```

Omit severity sections with no findings. If nothing qualifies, output the heading and scope line followed by `No findings.` Do not emit numeric scores, ratings, or grades.
