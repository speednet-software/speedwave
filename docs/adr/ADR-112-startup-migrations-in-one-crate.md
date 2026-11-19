# ADR-112: Startup migrations of the data directory in one crate

> **Status:** Accepted
> **Date:** 2026-11-19
> **Context:** SPEED-1013. Step 4 of SPEED-579 (secrets at rest) adds a migration that must finish before anything reads a secret. The migrations that existed were spread over the CLI start, the Desktop `setup` hook, the config read, the mcp-os spawn and the plugin load.

## Context

Seven migrations of `~/.speedwave` ran at five different moments: `legacy_token_cleanup` and `oauth_state_migration` at the CLI and Desktop start, `config::migrate_drop_log_level_in` and `config::heal_llm_config_on_disk` in the Desktop `setup` hook, `compose::proxy::migrate_legacy_local_key_in` on every config read, `host_mcp_process::lock::migrate_legacy_with_target` when mcp-os spawned, and `plugin::migrate_legacy_image_pending` when a plugin loaded. They shared no lock and none recorded since which release it was needed, so nobody could tell when it was safe to delete.

## Decision

1. **One entry point.** `crates/speedwave-migrations` (package `speedwave-migrations`, depends on `speedwave-runtime`) exposes `run_all(data_dir)`. The CLI and Desktop call it before they load the config, on every start, also before the setup wizard has finished. A whole-run error (the lock cannot be taken) ends the CLI with a message and makes Desktop show a dialog and exit, so no project starts on an unmigrated data directory.
2. **One lock.** `run_all` holds an exclusive lock on `<data_dir>/migrations.lock`, at the root of the data directory because the migrations do not protect one file. A second process waits and then runs every migration again; each migration recognises finished work by the state of the files, with no "done" marker.
3. **Described migrations.** Every migration is a module `<name>/mod.rs` of that crate, named for what it does and without a number. Its module comment says what it migrates, the Jira key and `Added in: v<release>`, so a later release can delete it. The list and its order are `MIGRATIONS` in `lib.rs`. `MigrationReport` carries the names of the executed and failed migrations, never values.
4. **`legacy_files`.** The first migration deletes the paths in `LEGACY_PATHS` (`crates/speedwave-migrations/src/legacy_files/mod.rs`): a pattern with `{project}`, `{service}` and `{plugin}` placeholders, a reason and `added_in`. The list was built from the git history of paths the code once wrote and no longer does. Placeholders match only entries that `read_dir` returns, never through a symlink, and a pattern may not end in a bare placeholder, so a pattern cannot leave the data directory or match every child.
5. **The seven old migrations are removed with their code and tests.** Updating from the releases those migrations covered (`v0.11.0` to `v0.14.1`) is no longer supported. The in-memory `config::migrate_llm` stays, because every config read still runs it. `oauth_json_key_for`, `IDENTITY_KEYS` and `ensure_provider_data_object` are not migrations; they moved to `oauth_persist.rs` for the Desktop save path.

## Consequences

- A new path in the data directory must not match `LEGACY_PATHS`; the rule is in `.claude/rules/data-dir-migrations.md` and is kept by review.
- `tokens/<project>/local-llm/{api_key,custom_headers}` are not in the list: Desktop still writes them and the compose renderer reads them.
- The removed `migrate_legacy_local_key_in` copied a legacy `local-llm/api_key` into the `llm` token namespace; a project that never saved its local key after that release has to enter it again.
