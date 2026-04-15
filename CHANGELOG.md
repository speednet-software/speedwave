# Changelog


## [0.7.1](https://github.com/speednet-software/speedwave/compare/v0.7.0...v0.7.1) (2026-04-13)


### Bug Fixes

* **runtime:** mitigate CLI TUI hang on long streams via NO_FLICKER ([#452](https://github.com/speednet-software/speedwave/issues/452)) ([#454](https://github.com/speednet-software/speedwave/issues/454)) ([f85ff4e](https://github.com/speednet-software/speedwave/commit/f85ff4e34fcc3e9f57719391266900278404f5cd))

## [0.7.0](https://github.com/speednet-software/speedwave/compare/v0.6.1...v0.7.0) (2026-04-13)

Major release with 26 user-visible changes. Highlights: statusline rewrite with live Claude Code data, per-plugin CPU limits, major chat session lifecycle fixes, and MCP spec 2025-11-25 compliance. Batched in [#430](https://github.com/speednet-software/speedwave/pull/430).

### Features

#### Runtime & Containers

* **runtime:** add per-plugin `cpu_limit`, set effort level max ([#406](https://github.com/speednet-software/speedwave/pull/406))
* **containers:** rewrite statusline with real data from Claude Code API ([#401](https://github.com/speednet-software/speedwave/pull/401))
* **containers:** show git branch in statusline ([#402](https://github.com/speednet-software/speedwave/pull/402))

#### Desktop

* **desktop:** redesign chat status bar to match container statusline ([#420](https://github.com/speednet-software/speedwave/pull/420))

#### CLI

* **cli:** add automated plan→review→implement→verify loop ([#375](https://github.com/speednet-software/speedwave/pull/375))

#### CI

* **ci:** rename macOS .dmg files to clarify Apple Silicon vs Intel ([#378](https://github.com/speednet-software/speedwave/pull/378))

### Bug Fixes

#### Desktop

* **desktop:** fix chat session lifecycle — New Chat/Resume hang, race conditions, dev/prod isolation ([#415](https://github.com/speednet-software/speedwave/pull/415))
* **desktop:** redesign integration enable/configure UX ([#399](https://github.com/speednet-software/speedwave/pull/399))
* **desktop:** format Settings timestamps as DD-MM-YYYY HH:MM:SS ([#403](https://github.com/speednet-software/speedwave/pull/403))
* **desktop:** resolve code review findings ([#379](https://github.com/speednet-software/speedwave/pull/379))

#### Runtime

* **runtime:** improve plugin container limits, VM diagnostics, and reconcile flow ([#396](https://github.com/speednet-software/speedwave/pull/396))

#### MCP

* **mcp:** MCP spec 2025-11-25 compliance, self-declaring worker policy, and platform fixes ([#405](https://github.com/speednet-software/speedwave/pull/405))

#### CLI

* **cli:** improve plan-loop convergence and reduce review churn ([#380](https://github.com/speednet-software/speedwave/pull/380))

#### Other

* silence cross-target unused warnings surfaced by e2e ([#429](https://github.com/speednet-software/speedwave/pull/429))

### Dependencies

Extensive Dependabot batch covering Rust (`rust-minor-patch` [#383](https://github.com/speednet-software/speedwave/pull/383), `rust-desktop-minor-patch` [#388](https://github.com/speednet-software/speedwave/pull/388)), npm desktop (group [#397](https://github.com/speednet-software/speedwave/pull/397), `eslint` 9→10 [#390](https://github.com/speednet-software/speedwave/pull/390), `hono` [#410](https://github.com/speednet-software/speedwave/pull/410), `@hono/node-server` [#409](https://github.com/speednet-software/speedwave/pull/409)), npm mcp-servers (group [#417](https://github.com/speednet-software/speedwave/pull/417), `vite` 7→8 [#416](https://github.com/speednet-software/speedwave/pull/416), `eslint` 9→10 [#387](https://github.com/speednet-software/speedwave/pull/387), `@types/node` 24→25 [#386](https://github.com/speednet-software/speedwave/pull/386)), npm e2e (`fast-xml-parser` [#412](https://github.com/speednet-software/speedwave/pull/412), `basic-ftp` [#411](https://github.com/speednet-software/speedwave/pull/411), `lodash` [#377](https://github.com/speednet-software/speedwave/pull/377)).

### Known Issues / Follow-ups

Code review of [#430](https://github.com/speednet-software/speedwave/pull/430) surfaced 11 tracked follow-ups ([#431–#441](https://github.com/speednet-software/speedwave/issues/431)). Notable: silent message drop on session race ([#431](https://github.com/speednet-software/speedwave/issues/431), P2) and plugin tmpfs size configurability ([#435](https://github.com/speednet-software/speedwave/issues/435), P2).

### Upgrade Notes

* **VM memory on 16 GiB hosts:** `desired_vm_memory_gib` formula change ([#396](https://github.com/speednet-software/speedwave/pull/396)) may reduce VM memory from 12 → 8 GiB on 16 GiB hosts. Monitor and tune manually if needed.
* **Plugin `/tmp`:** tmpfs increased from 64m → 512m for all plugins (follow-up [#435](https://github.com/speednet-software/speedwave/issues/435) to make configurable).
* **MCP spec:** workers now self-declare tool policy via `_meta` per ADR-036 — custom workers must be updated.

## [0.6.1](https://github.com/speednet-software/speedwave/compare/v0.6.0...v0.6.1) (2026-04-01)


### Bug Fixes

* **config:** simplify severity headings in review-plan skill ([186fd35](https://github.com/speednet-software/speedwave/commit/186fd35d254148b53cf4c2d55e1b5e54cfd653a0))
* **docs:** trigger release ([5efe385](https://github.com/speednet-software/speedwave/commit/5efe38552c701bf4e9259e06f2e2c6d1ce622af5))

## [0.6.0](https://github.com/speednet-software/speedwave/compare/v0.5.1...v0.6.0) (2026-03-30)


### Features

* **release:** runtime fixes, Redmine improvements, and plan skills ([#331](https://github.com/speednet-software/speedwave/issues/331)) ([baf8bf8](https://github.com/speednet-software/speedwave/commit/baf8bf83c5a830b433b26613ae6b8589348170ba))

## [0.5.1](https://github.com/speednet-software/speedwave/compare/v0.5.0...v0.5.1) (2026-03-25)


### Bug Fixes

* **ci:** force-push backmerge and ghost commit cleanup ([#293](https://github.com/speednet-software/speedwave/issues/293)) ([#310](https://github.com/speednet-software/speedwave/issues/310)) ([cdb9faa](https://github.com/speednet-software/speedwave/commit/cdb9faa08fd84a0a3fcc1db77974f91ddb99de56))

## [0.5.0](https://github.com/speednet-software/speedwave/compare/v0.4.2...v0.5.0) (2026-03-24)


### Features

* **desktop:** auth UX improvements and v0.4.2 release ([#292](https://github.com/speednet-software/speedwave/issues/292)) ([edb12d1](https://github.com/speednet-software/speedwave/commit/edb12d1b785b60cb86105adde64935f0de6a881e))

## [0.4.2](https://github.com/speednet-software/speedwave/compare/v0.4.1...v0.4.2) (2026-03-24)


### Bug Fixes

* **desktop:** auth overlay blocks only chat, setup regressions, OS prereqs ([#284](https://github.com/speednet-software/speedwave/issues/284)) ([68fef67](https://github.com/speednet-software/speedwave/commit/68fef6709232446e3ee61c777d57036713a63f4b))

## [0.4.1](https://github.com/speednet-software/speedwave/compare/v0.4.0...v0.4.1) (2026-03-24)


### Bug Fixes

* **desktop:** setup screen regression and wizard dead-end after v0.4.0 update ([#278](https://github.com/speednet-software/speedwave/issues/278)) ([ead2aad](https://github.com/speednet-software/speedwave/commit/ead2aad7627fd2f8adfb5469e04208ee24176162))

## [0.4.0](https://github.com/speednet-software/speedwave/compare/v0.3.3...v0.4.0) (2026-03-23)


### Features

* **runtime:** OS prerequisite checks, container recovery, and adaptive memory ([#257](https://github.com/speednet-software/speedwave/issues/257)) ([b4577d6](https://github.com/speednet-software/speedwave/commit/b4577d699551e98401c37c0f431e15580e03d0cd))

## [0.3.3](https://github.com/speednet-software/speedwave/compare/v0.3.2...v0.3.3) (2026-03-20)


### Bug Fixes

* **e2e:** repair broken selectors and macOS clean_state after Tailwind migration ([#238](https://github.com/speednet-software/speedwave/issues/238)) ([f798226](https://github.com/speednet-software/speedwave/commit/f798226171fc71c6bc49d66dddb5af2fd79b270f))

## [0.3.2](https://github.com/speednet-software/speedwave/compare/v0.3.1...v0.3.2) (2026-03-20)


### Bug Fixes

* **ci:** fix Windows CLI build, tag creation, backmerge conflicts, and release-please label parsing ([#229](https://github.com/speednet-software/speedwave/issues/229)) ([338dec5](https://github.com/speednet-software/speedwave/commit/338dec5bf4d6f35014f46749fe4c151165a6304f))

## [0.3.1](https://github.com/speednet-software/speedwave/compare/v0.3.0...v0.3.1) (2026-03-20)


### Bug Fixes

* **ci:** fix gitflow pipeline — tag-aware checkout, version sync, backmerge automation ([#221](https://github.com/speednet-software/speedwave/issues/221)) ([fc7f22a](https://github.com/speednet-software/speedwave/commit/fc7f22ae098d227da314f5b551b0e23ceecf2746))

## [0.3.0](https://github.com/speednet-software/speedwave/compare/v0.2.0...v0.3.0) (2026-03-20)


### Features

* release — docs sync, Lima memory fix, plugin system, Swift CI alignment ([#215](https://github.com/speednet-software/speedwave/issues/215)) ([b7b045d](https://github.com/speednet-software/speedwave/commit/b7b045d576547476d5542c5cd23bc57c7d8e5020))
* release — plugin system, Tailwind migration, chat UI, security hardening ([#203](https://github.com/speednet-software/speedwave/issues/203)) ([4155156](https://github.com/speednet-software/speedwave/commit/415515630b159bf7da6eddbcf3bab3b377e8e0c9))
* **runtime:** plugin system, transactional project switching, streaming chat UI, security hardening ([#134](https://github.com/speednet-software/speedwave/issues/134)) ([8dc90cb](https://github.com/speednet-software/speedwave/commit/8dc90cb9c3d307eddb1fc9193d058f83845a971d))


### Bug Fixes

* **ci:** reset release-please manifest to 0.0.1 for clean 0.1.0 release ([#162](https://github.com/speednet-software/speedwave/issues/162)) ([0802a35](https://github.com/speednet-software/speedwave/commit/0802a350bd28370802874cb300f5abcd67f92ce8))
* **ci:** set last-release-sha to v0.0.1 tag to reset version to 0.1.0 ([#160](https://github.com/speednet-software/speedwave/issues/160)) ([6e1a6a7](https://github.com/speednet-software/speedwave/commit/6e1a6a7bb7f2ce91e327fda57e502c56719bef86))
* **ci:** sync claude.yml with dev — allowlist guard, remove redundant permissions ([#129](https://github.com/speednet-software/speedwave/issues/129)) ([24e879a](https://github.com/speednet-software/speedwave/commit/24e879a5ba7698a379805f8e28527307371def2a))
* **ci:** use login allowlist for Claude Code Review trigger ([#89](https://github.com/speednet-software/speedwave/issues/89)) ([8cce77e](https://github.com/speednet-software/speedwave/commit/8cce77e1b27e71f8c6ff80d6987ab502bafa193c))
* **deps:** sync desktop dependencies from dev — Angular 21.2.4, Express 5, audit fixes ([#132](https://github.com/speednet-software/speedwave/issues/132)) ([8bfd1b5](https://github.com/speednet-software/speedwave/commit/8bfd1b53517723d6051eb254948f953114ded0ea))

## [0.2.0](https://github.com/speednet-software/speedwave/compare/v0.1.0...v0.2.0) (2026-03-18)


### Features

* release — plugin system, Tailwind migration, chat UI, security hardening ([#203](https://github.com/speednet-software/speedwave/issues/203)) ([4155156](https://github.com/speednet-software/speedwave/commit/415515630b159bf7da6eddbcf3bab3b377e8e0c9))

## [0.1.0](https://github.com/speednet-software/speedwave/compare/v0.0.1...v0.1.0) (2026-03-15)


### Features

* **runtime:** plugin system, transactional project switching, streaming chat UI, security hardening ([#134](https://github.com/speednet-software/speedwave/issues/134)) ([8dc90cb](https://github.com/speednet-software/speedwave/commit/8dc90cb9c3d307eddb1fc9193d058f83845a971d))


### Bug Fixes

* **ci:** reset release-please manifest to 0.0.1 for clean 0.1.0 release ([#162](https://github.com/speednet-software/speedwave/issues/162)) ([0802a35](https://github.com/speednet-software/speedwave/commit/0802a350bd28370802874cb300f5abcd67f92ce8))
* **ci:** set last-release-sha to v0.0.1 tag to reset version to 0.1.0 ([#160](https://github.com/speednet-software/speedwave/issues/160)) ([6e1a6a7](https://github.com/speednet-software/speedwave/commit/6e1a6a7bb7f2ce91e327fda57e502c56719bef86))
* **ci:** sync claude.yml with dev — allowlist guard, remove redundant permissions ([#129](https://github.com/speednet-software/speedwave/issues/129)) ([24e879a](https://github.com/speednet-software/speedwave/commit/24e879a5ba7698a379805f8e28527307371def2a))
* **ci:** use login allowlist for Claude Code Review trigger ([#89](https://github.com/speednet-software/speedwave/issues/89)) ([8cce77e](https://github.com/speednet-software/speedwave/commit/8cce77e1b27e71f8c6ff80d6987ab502bafa193c))
* **deps:** sync desktop dependencies from dev — Angular 21.2.4, Express 5, audit fixes ([#132](https://github.com/speednet-software/speedwave/issues/132)) ([8bfd1b5](https://github.com/speednet-software/speedwave/commit/8bfd1b53517723d6051eb254948f953114ded0ea))

## Changelog
