# Changelog


## [0.13.2](https://github.com/speednet-software/speedwave/compare/v0.13.1...v0.13.2) (2026-05-30)


### Bug Fixes

* project selector, theme logo, plugin digest, test isolation ([#758](https://github.com/speednet-software/speedwave/issues/758)) ([05ab24b](https://github.com/speednet-software/speedwave/commit/05ab24b26ca60450112589aab3e96e61a20cc2e6))

## [0.13.1](https://github.com/speednet-software/speedwave/compare/v0.13.0...v0.13.1) (2026-05-30)


### Bug Fixes

* **desktop:** Windows wsl.conf automount, theme-aware logo, and wsl.exe log spam ([#752](https://github.com/speednet-software/speedwave/issues/752)) ([2deb41a](https://github.com/speednet-software/speedwave/commit/2deb41ae28d1f275647e0321828d6698bbb501e9))

## [0.13.0](https://github.com/speednet-software/speedwave/compare/v0.12.1...v0.13.0) (2026-05-30)


### Features

* **desktop:** Opus 4.8, theme switch, plugin manifest UX, Windows & runtime fixes ([#747](https://github.com/speednet-software/speedwave/issues/747)) ([d13c59b](https://github.com/speednet-software/speedwave/commit/d13c59b914ed7d60681627757f4a39ca39ca7910))

## [0.12.1](https://github.com/speednet-software/speedwave/compare/v0.12.0...v0.12.1) (2026-05-27)


### Bug Fixes

* runtime compose lock, desktop log/path fixes, e2e bzip2 ([#733](https://github.com/speednet-software/speedwave/issues/733)) ([53e043c](https://github.com/speednet-software/speedwave/commit/53e043c8084c587e08bc48927390f73b8cc5694d))

## [0.12.0](https://github.com/speednet-software/speedwave/compare/v0.11.0...v0.12.0) (2026-05-26)


### ⚠ BREAKING CHANGES

* **linux:** Linux host support dropped ([ADR-059](https://github.com/speednet-software/speedwave/blob/main/docs/adr/ADR-059-drop-linux-support.md)). macOS (Lima) and Windows (WSL2) remain the only supported host platforms. ([#670](https://github.com/speednet-software/speedwave/issues/670))


### Features

* **plugins:** plugin bridge dev UX — stable port, persistent token, plugin detail UI, auto-enable for optional secrets ([#719](https://github.com/speednet-software/speedwave/issues/719))
* **desktop,cli:** image paste end-to-end via file-mount (SPEED-92, ADR-065) ([#713](https://github.com/speednet-software/speedwave/issues/713))
* **desktop:** delete conversation from history sidebar ([#711](https://github.com/speednet-software/speedwave/issues/711))
* **runtime:** local LLM provider end-to-end + VPN inheritance ([#707](https://github.com/speednet-software/speedwave/issues/707))
* **runtime:** playwright reaches host.docker.internal for local dev server testing ([#706](https://github.com/speednet-software/speedwave/issues/706))
* **runtime:** consolidate host-gateway alias to single SSOT + disk-full auto-prune ([#703](https://github.com/speednet-software/speedwave/issues/703))
* **mcp-context7:** native Context7 integration with optional API key ([#673](https://github.com/speednet-software/speedwave/issues/673))
* **mcp-atlassian:** Atlassian (Jira + Confluence) built-in MCP worker ([#635](https://github.com/speednet-software/speedwave/issues/635))
* **mcp-github:** GitHub built-in MCP worker + ADR-053 ([#633](https://github.com/speednet-software/speedwave/issues/633))
* **mcp-sharepoint:** pages/lists CRUD + host-side oauth refresh (ADR-060) ([#671](https://github.com/speednet-software/speedwave/issues/671))
* **office:** built-in mcp-office worker — Word/Excel/PowerPoint/PDF read·write·convert·charts ([#644](https://github.com/speednet-software/speedwave/issues/644))
* **host-exec:** per-project Host Exec worker (ADR-054, SPW-83) + log timestamp SSOT ([#657](https://github.com/speednet-software/speedwave/issues/657))
* **desktop:** meeting transcription — local Whisper + diarization, host audio capture (ADR-056) ([#658](https://github.com/speednet-software/speedwave/issues/658))
* **desktop:** beta-features toggle in tray menu (ADR-055) ([#660](https://github.com/speednet-software/speedwave/issues/660))
* **desktop:** gate office + host-exec behind beta toggle (ADR-058) ([#663](https://github.com/speednet-software/speedwave/issues/663))
* **runtime:** lazy build of enabled worker images (SPW-203) ([#659](https://github.com/speednet-software/speedwave/issues/659))
* **desktop:** clipboard bridge for Claude auth URL + speedwave login wrapper ([#620](https://github.com/speednet-software/speedwave/issues/620))


### Code Refactoring

* **runtime,desktop:** host-side bridges + host MCP worker consolidation ([#708](https://github.com/speednet-software/speedwave/issues/708))
* **desktop,mcp:** unify OAuth device flow + harden state validation ([#714](https://github.com/speednet-software/speedwave/issues/714))


### Bug Fixes

* **runtime,desktop:** release node.exe before Windows installer overwrite ([#712](https://github.com/speednet-software/speedwave/issues/712))
* **runtime:** support `\\wsl.localhost\Speedwave\` project paths with helpful cross-distro error ([#709](https://github.com/speednet-software/speedwave/issues/709))
* **security:** Windows shell ban-list + Windows build CI fixes ([#700](https://github.com/speednet-software/speedwave/issues/700))
* **desktop:** unblock Windows build — pin sherpa-onnx prebuilt to MD-Release variant ([#697](https://github.com/speednet-software/speedwave/issues/697))
* **mcp-sharepoint,desktop:** make OAuth refresh resilient under watchdog restart ([#680](https://github.com/speednet-software/speedwave/issues/680))
* **macos:** Calendar TCC silent-reject + unify 4 OS integrations ([#618](https://github.com/speednet-software/speedwave/issues/618))
* **desktop:** unregister WSL distro and clean bundled Node.js on Windows uninstall ([#613](https://github.com/speednet-software/speedwave/issues/613), [#616](https://github.com/speednet-software/speedwave/issues/616))
* **runtime:** gate per-integration claude-resources by `ENABLED_SERVICES` ([#718](https://github.com/speednet-software/speedwave/issues/718))
* **runtime:** bump Claude Code to 2.1.143 ([#683](https://github.com/speednet-software/speedwave/issues/683))
* **desktop:** hide Claude Code synthetic user entries from chat history ([#710](https://github.com/speednet-software/speedwave/issues/710))
* **mcp-sharepoint:** reject URL-form site_id with clear setup guidance ([#678](https://github.com/speednet-software/speedwave/issues/678))
* **ci:** strip MSYS2 backslash escape from sha256sum output ([#699](https://github.com/speednet-software/speedwave/issues/699))
* **desktop:** stage oauth worker in Windows bundle-build-context.ps1 ([#677](https://github.com/speednet-software/speedwave/issues/677))
* unify MCP worker init around shared SSOT + atomic reconcile, remove Stop hook ([#705](https://github.com/speednet-software/speedwave/issues/705))
* **macos:** raise minimumSystemVersion to 10.15 — required by whisper.cpp ([#668](https://github.com/speednet-software/speedwave/issues/668))
* **desktop:** refresh tray after setup completes, not after create_project ([#665](https://github.com/speednet-software/speedwave/issues/665))
* **runtime:** use OsStr byte sort in compute_plugin_digest ([#666](https://github.com/speednet-software/speedwave/issues/666))
* **desktop:** expose Opus 4.6 + log llm writes + honest default label ([#617](https://github.com/speednet-software/speedwave/issues/617))
* **desktop:** emit PowerShell-shaped Claude auth command on Windows ([#615](https://github.com/speednet-software/speedwave/issues/615))
* **runtime:** propagate host timezone into all containers ([#619](https://github.com/speednet-software/speedwave/issues/619))
* **runtime:** harden plugin manifest validation ([#630](https://github.com/speednet-software/speedwave/issues/630))


### CI/Release

* **release:** close 6 coverage gaps in release-please-config + backmerge AUTO_RESOLVE_FILES; add anti-regression test (`_tests/desktop/backmerge-alignment.bats`) ([#725](https://github.com/speednet-software/speedwave/issues/725))

## [0.11.0](https://github.com/speednet-software/speedwave/compare/v0.10.0...v0.11.0) (2026-05-19)


### Features

* **release:** v0.11.0 — Office worker, meeting transcription, Atlassian/GitHub/Context7 MCPs, host-exec, drop Linux ([#696](https://github.com/speednet-software/speedwave/issues/696)) ([ee399a9](https://github.com/speednet-software/speedwave/commit/ee399a900a21d4a86143c29d54f8259993c0a811))

## [0.10.0](https://github.com/speednet-software/speedwave/compare/v0.9.0...v0.10.0) (2026-05-05)


### Features

* release v0.10.0 — Claude 2.1.126 + 1M context, async plugin install, multi-question AskUser ([#607](https://github.com/speednet-software/speedwave/issues/607)) ([2263af5](https://github.com/speednet-software/speedwave/commit/2263af58ae1b5dcdfd89c363282c14d79a604b75))

## [0.9.0](https://github.com/speednet-software/speedwave/compare/v0.8.0...v0.9.0) (2026-04-29)


### ⚠ BREAKING CHANGES

* **desktop:** plugin.json api_key_env field is no longer honored; LiteLLM proxy container removed. Users on external (non-local) providers must migrate to Anthropic or a local provider.

### Features

* **desktop:** CDK migration, terminal redesign, LLM auto-discover, brand icons + runtime hardening ([#576](https://github.com/speednet-software/speedwave/issues/576)) ([26cfb67](https://github.com/speednet-software/speedwave/commit/26cfb67abd3b7ea7e3173ccb5ef221bd5fd83c25))

## [0.8.0](https://github.com/speednet-software/speedwave/compare/v0.7.5...v0.8.0) (2026-04-16)


### Features

* **ci:** add Phase 3 code review and stop Lima VM on app close ([#500](https://github.com/speednet-software/speedwave/issues/500)) ([426ee68](https://github.com/speednet-software/speedwave/commit/426ee682b5090b8dd33c585bb6273f5be0e8e942))

## [0.7.5](https://github.com/speednet-software/speedwave/compare/v0.7.4...v0.7.5) (2026-04-16)


### Bug Fixes

* **runtime:** auto-rebuild plugins and prune BuildKit cache ([#495](https://github.com/speednet-software/speedwave/issues/495)) ([ef1e11c](https://github.com/speednet-software/speedwave/commit/ef1e11c1f1ad99f7cc29ae4d5f7cd393c4d8c62f))

## [0.7.4](https://github.com/speednet-software/speedwave/compare/v0.7.3...v0.7.4) (2026-04-16)


### Bug Fixes

* **runtime:** auto-prune old bundle images + harden plan-loop tooling ([#481](https://github.com/speednet-software/speedwave/issues/481)) ([#483](https://github.com/speednet-software/speedwave/issues/483)) ([09905b7](https://github.com/speednet-software/speedwave/commit/09905b7f38ea2b4fcc374ddb123ec69165b7037b))

## [0.7.3](https://github.com/speednet-software/speedwave/compare/v0.7.2...v0.7.3) (2026-04-15)


### Bug Fixes

* **security:** add missing macOS entitlements and CloudStorage TCC access ([#476](https://github.com/speednet-software/speedwave/issues/476)) ([3bedaa6](https://github.com/speednet-software/speedwave/commit/3bedaa642d99e175a41183311a3cd864e13a3feb))

## [0.7.2](https://github.com/speednet-software/speedwave/compare/v0.7.1...v0.7.2) (2026-04-15)


### Bug Fixes

* **release:** import Apple cert into keychain before tauri-action on macOS ([#469](https://github.com/speednet-software/speedwave/issues/469)) ([8354e27](https://github.com/speednet-software/speedwave/commit/8354e27ba5e6b406554237a2dcfb002407c9b2fc))
* sign bundled macOS binaries and close vite/rustls-webpki CVEs ([#461](https://github.com/speednet-software/speedwave/issues/461)) ([856afcb](https://github.com/speednet-software/speedwave/commit/856afcb3755c815f14b168ee8a2e7a56927e042a))

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
