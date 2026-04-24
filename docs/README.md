# Speedwave Documentation

Welcome to the Speedwave documentation. Speedwave is an AI platform that connects Claude Code with external services (Slack, SharePoint, GitLab, Redmine, Mail, Calendar) — shipped as a single installable application.

## Getting Started

- [Quickstart](getting-started/README.md)
- [Installation](getting-started/installation.md) — per-platform setup (macOS, Linux, Windows)
- [Configuration](getting-started/configuration.md) — `config.json`, environment variables, `.speedwave.json`

## Guides

- [CLI Usage](guides/cli.md) — terminal-based Claude Code via `speedwave`
- [Desktop App](guides/desktop.md) — chat UI, project management, system integrations
- [Integrations](guides/integrations.md) — Slack, SharePoint, GitLab, Redmine, Mail, Calendar
- [IDE Bridge](guides/ide-bridge.md) — VS Code / JetBrains integration

## Architecture

- [Overview](architecture/README.md) — system diagram and component map
- [Security Model](architecture/security.md) — container hardening, token isolation, threat model
- [Containers](architecture/containers.md) — OCI images, compose templates, per-project isolation
- [Platform Matrix](architecture/platform-matrix.md) — macOS / Linux / Windows specifics
- [Bundled Resources](architecture/bundled-resources.md) — resources injected into the Claude container

## Contributing

- [Development Setup](contributing/development-setup.md) — prerequisites, build, test
- [Testing](contributing/testing.md) — test strategy, coverage, CI
- [Release Signing](contributing/release-signing.md) — macOS code signing, notarization, certificate rotation

## Accessibility

- [Contrast Report](accessibility/contrast-report.md) — WCAG AA verification for design-system color tokens

## Architecture Decision Records

- [ADR Index](adr/README.md) — all architectural decisions

## Root Documents

These files live in the repository root:

- [README](../README.md) — project overview
- [Contributing](../CONTRIBUTING.md) — contribution guidelines
- [Security](../SECURITY.md) — vulnerability reporting
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [Changelog](../CHANGELOG.md)
- [Releasing](../RELEASING.md) — release process and CI pipeline
