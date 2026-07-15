# E2E Rig Pipeline Discipline (`scripts/e2e-vm.sh` + engine-level bats)

Rules for the clean-install rig pipeline and the engine-level bats suites (`_tests/e2e/engine-contract.bats`, `_tests/e2e/update-dirty-state.bats`). All were learned from live rig failures — each rule names the failure it prevents.

## The live window (spec-phase split)

- The WDIO suite ends with `07-factory-reset.spec.ts`, which wipes the project, data dir, and VM/distro. Anything needing a provisioned engine or the live `e2e-test` project must run in the **live window**: Phase 3 runs wdio with `SPW_E2E_SPEC_PHASE=pre-reset` (all specs minus 07), then the bats suites, then `SPW_E2E_SPEC_PHASE=reset-only` (07 alone, so factory-reset coverage and rig cleanup are preserved). Phase 2 runs the full suite (no env set).
- `SPW_E2E_SPEC_PHASE` is read by `desktop/e2e/wdio.conf.ts::resolveSpecs`: empty/`all` → full list, unknown values throw (fail-loud). Never position an engine-dependent step "after the suite" — that is a factory-reset machine.
- macOS only: the app stops the Lima VM when it exits, and Lima has no on-demand start (WSL does) — the bats step must `limactl start` (bundled binary, prod `LIMA_HOME`) before the engine preflight.

## Windows transport rules (all empirically verified on the rig)

- Anything crossing the `wsl.exe ... --` interop boundary is re-parsed by the distro's default shell: payloads carrying `$`-constructs meant for the inner shell MUST be base64-wrapped (`echo <b64> | base64 -d | sh` — the runtime's `wrap_base64_sh` shape). Quoted metachar payloads without `$` survive as data; bare-spliced scripts do not.
- The rig's sshd hands command lines to cmd.exe, which ignores single quotes: never place a pipe/redirect intended for a remote POSIX shell in a cmd.exe-parsed segment (resolve host-side instead, like the CLI-path lookup). Never caret-escape POSIX-side files — `^` is only a cmd.exe escape.
- Env vars injected into `windows_ps` scripts go through the `ps_squote` prefix pattern (guard: `_tests/e2e/e2e-vm-excludes.bats`).
- The engine bats suites ship to `WINDOWS_CONTRACT_STAGING` (own dir) — other pipeline steps `rm -rf` the main staging dir between phases.

## Suite discipline

- Engine access in bats only via the word-split `ENGINE_EXEC` contract (`${ENGINE_EXEC+set}` distinguishes unset from empty-on-purpose); every bats invocation carries `--print-output-on-failure`.
- Everything planted lives under a test-owned prefix/sentinel id and is reaped in teardown even on failure; plants are asserted (exact counts) before the behavior under test runs — a silently failed plant must fail loudly, never pass vacuously.
