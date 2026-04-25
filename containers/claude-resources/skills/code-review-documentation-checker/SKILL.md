---
name: code-review-documentation-checker
description: Verify if code changes require documentation updates. Use during code review to ensure documentation stays synchronized with code — prevents documentation drift.
user-invocable: false
model: opus
---

# Documentation Checker

Audit code changes against documentation to prevent documentation drift — the gradual divergence between what code does and what documentation says.

## Core Principles

1. **Documentation must reflect reality** — every public API, configuration option, and behavior should be accurately documented
2. **Outdated docs are worse than no docs** — misleading documentation causes more problems than missing documentation
3. **Examples must work** — code examples in documentation should be valid and current
4. **Changes propagate** — a change in one place often requires updates in multiple documentation locations

## Review Process

### 1. Identify Code Changes

Analyze the git diff to identify:

- New functions, methods, or classes
- Modified function signatures (parameters, return types)
- Changed or removed functionality
- New configuration options or environment variables
- Modified interfaces or type definitions
- Changed error messages or codes
- New dependencies or removed dependencies

### 2. Locate Related Documentation

For each change, identify documentation that may need updates:

**Project-level:** `*.md` in root, `docs/` directory, `CLAUDE.md`

**Code-level:** JSDoc/TSDoc comments, inline comments explaining complex logic, type definitions

**API documentation:** OpenAPI/Swagger specs, endpoint descriptions

**User documentation:** `docs/`, configuration guides

### 3. Analyze Documentation Gaps

For each identified change, check:

**Accuracy:** Does documentation describe current behavior? Are parameter names, types, return values correct? Are examples still valid?

**Completeness:** Is new functionality documented? Are all parameters documented? Are edge cases and error conditions described?

**Consistency:** Is terminology consistent across docs? Do cross-references still work?

### 4. Prioritize Findings

- **CRITICAL**: Documentation is actively misleading or examples are broken
- **IMPORTANT**: New public API lacks documentation or significant behavior change undocumented
- **SUGGESTION**: Minor improvements, enhanced clarity, or optional additions

## Output Format

```markdown
## Summary

Brief overview of documentation analysis scope and key findings.

## Documentation Updates Required

### Critical Issues

- **[file:section]**: [What's wrong and why it's critical]
  - Current: [What docs say]
  - Actual: [What code does]
  - Fix: [Specific update needed]

### Important Updates

- **[file:section]**: [What needs updating]
  - Reason: [Why this matters]
  - Suggestion: [How to update]

### Suggestions

- **[file:section]**: [Optional improvement]

## New Documentation Needed

- **[function/type/feature]**: Missing documentation
  - Location: Where to add it
  - Content: What to document

## Verified Up-to-Date

- List of documentation that was checked and is current

## Documentation Quality Score

[1-10 rating with brief justification]
```

## Special Considerations

**Focus on public interfaces** — internal implementation details don't always need documentation. Public APIs, exported functions, and user-facing features are priority.

**Consider the audience:**

- `README.md` targets new users and evaluators
- API docs target developers integrating with the code
- `CLAUDE.md` targets AI assistants working with the codebase
- `docs/` targets the team

**Check for cascade effects** — a renamed function may be referenced in multiple docs. A changed config option may appear in examples throughout.

**Verify examples** — mentally trace through code examples. Flag examples that use deprecated or renamed APIs. Note examples missing error handling that's now required.
