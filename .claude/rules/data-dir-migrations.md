---
paths:
  - 'crates/**/*.rs'
  - 'desktop/src-tauri/**/*.rs'
---

# Data directory migrations

Every change to the data directory (`~/.speedwave`, `consts::data_dir()`) at start-up goes through one crate, `crates/speedwave-migrations` ([ADR-113](../../docs/adr/ADR-113-startup-migrations-in-one-crate.md)). The CLI (`main.rs`) and Desktop (`main.rs`, before `SetupState::load`) call `speedwave_migrations::run_all(consts::data_dir())` first, on every start. It holds an exclusive lock on `<data_dir>/migrations.lock`; a second process waits and runs every migration again, so a migration recognises finished work by the state of the files and writes no "done" marker. A failure to take the lock ends the CLI and makes Desktop show a dialog and exit.

- **A new path in the data directory must not match `LEGACY_PATHS`** (`crates/speedwave-migrations/src/legacy_files/mod.rs`). The migration deletes every match at each start, so code that writes a matching path loses its data on the next launch. Check the list before adding a file name, a directory or a token file. Review enforces it; there is no unit test of this rule.
- **A path the code stops writing is added to `LEGACY_PATHS`** in the same change that removes the writer: a pattern (`{project}`, `{service}`, `{plugin}` stand for directory entries that exist; the last segment is a literal, or a literal with a prefix or suffix around a placeholder), a reason and `added_in` (the release that ships the entry). Verify with `git log -S` that no live code still reads or writes the path before listing it.
- **A new migration is a module `<name>/mod.rs` in `speedwave-migrations`**, named for what it does, without a number, with a module comment that says what it migrates, the Jira key and `Added in: v<release>`. Register it in `MIGRATIONS` (`lib.rs`), where the order is explicit. It takes the data directory and returns `Ok(())` or an error text with counts and names only, never values (`no-user-content-in-logs.md`).
- **Segments that come from the disk come only from `read_dir` entries**, never through a symlink and never from user input; a pattern may not contain `..`, a separator or end in a bare placeholder (`parse_pattern` rejects it).
- A migration that is no longer reachable by a supported update is deleted with its tests; `Added in` says when that is.
