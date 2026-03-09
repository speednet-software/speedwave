# Contributing to Speedwave

Thank you for your interest in contributing to Speedwave! This document provides guidelines and instructions for contributing.

## Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/speednet-software/speedwave/issues) to avoid duplicates
2. Use the [Bug Report](https://github.com/speednet-software/speedwave/issues/new?template=bug_report.yml) template
3. Include steps to reproduce, expected vs actual behavior, and your environment details

### Suggesting Features

1. Check [existing issues](https://github.com/speednet-software/speedwave/issues) to avoid duplicates
2. Use the [Feature Request](https://github.com/speednet-software/speedwave/issues/new?template=feature_request.yml) template
3. Describe the problem you're solving and the proposed solution

### Development Setup

```bash
# Clone the repository
git clone https://github.com/speednet-software/speedwave.git
cd speedwave

# Install all prerequisites and dependencies
make setup-dev
```

### Running Tests

```bash
# Run all tests (Rust + MCP)
make test

# Run linting, clippy, type-check, and formatting
make check

# Full quality gate (check + test + coverage + audit)
make check-all
```

### Making Changes

1. Fork the repository and create a feature branch from `dev`
2. Make your changes
3. Ensure all tests pass: `make test`
4. Ensure code quality checks pass: `make check`
5. Commit your changes using [Conventional Commits](#commit-conventions)
6. Push to your fork and submit a Pull Request

## Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Commit messages are validated by commitlint via a git hook.

Format: `type(scope): description`

Types:

- `feat` — new feature
- `fix` — bug fix
- `docs` — documentation changes
- `style` — formatting, missing semicolons, etc. (no code change)
- `refactor` — code change that neither fixes a bug nor adds a feature
- `test` — adding or updating tests
- `chore` — maintenance tasks (dependencies, CI, build scripts)
- `perf` — performance improvements
- `ci` — CI/CD changes

Examples:

```
feat(runtime): add nerdctl support for Linux
fix(cli): handle missing config file gracefully
docs: update installation instructions
chore(deps): bump tokio to 1.40
```

**Version bumps from commits:** Conventional commits drive automated releases via [release-please](https://github.com/googleapis/release-please):

- `fix:` → patch bump (e.g. `0.3.0` → `0.3.1`)
- `feat:` → minor bump (e.g. `0.3.0` → `0.4.0`)
- `BREAKING CHANGE` footer → major bump (minor while `0.x`)

## Pull Request Process

1. Fill in the PR template completely
2. Link related issues using `Closes #123` or `Fixes #123`
3. Ensure CI passes (tests, linting, security checks)
4. Request review from maintainers
5. Address review feedback promptly
6. PRs require at least one approval before merging

## Project Structure

See [CLAUDE.md](CLAUDE.md) for a detailed overview of the repository structure, architecture, and engineering principles.
