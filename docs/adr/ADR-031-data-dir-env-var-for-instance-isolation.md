# ADR-031: SPEEDWAVE_DATA_DIR Environment Variable for Instance Isolation

> **Status:** Accepted
> **Date:** 2026-03-19

---

## Context

Developers cannot run `make dev` alongside an installed production Speedwave app. Both instances share:

- The same Lima VM (`~/.speedwave/lima/`)
- The same data directory (`~/.speedwave/`)
- The same container names and networks (prefix `speedwave_`)
- The same MCP OS worker files (PID, auth token, port)

This causes conflicts and data corruption when a dev build and a production app run simultaneously. The problem is inherent to having a single hardcoded data directory: two Speedwave processes that share `~/.speedwave/` will fight over the Lima VM, overwrite each other's compose files, and collide on container names.

## Decision

A single environment variable `SPEEDWAVE_DATA_DIR` overrides the default `~/.speedwave/` data directory. All paths that previously used `~/.speedwave/` are derived from this variable.

### 1. Resolution via `OnceLock`

`consts::data_dir()` reads `SPEEDWAVE_DATA_DIR` once per process using `OnceLock<PathBuf>`. This guarantees thread safety and process-wide consistency — every call returns the same path.

### 2. Instance name derived from basename

The Lima VM name and compose project prefix are derived from the data directory basename by stripping leading dots:

| `SPEEDWAVE_DATA_DIR` | Basename         | Instance name   |
| -------------------- | ---------------- | --------------- |
| `~/.speedwave`       | `.speedwave`     | `speedwave`     |
| `~/.speedwave-dev`   | `.speedwave-dev` | `speedwave-dev` |
| `/opt/sw-test`       | `sw-test`        | `sw-test`       |

The instance name must match `^[a-z][a-z0-9-]{0,63}$` — the same validation used for plugin slugs.

### 3. Pure functions for testability

Two pure functions enable unit testing without process-level side effects:

- `data_dir_from(env_val, home)` — resolves the data directory from an optional env value and a home path
- `derive_instance_name_from(data_dir)` — extracts and validates the instance name from a path

The `OnceLock`-based `data_dir()`, `lima_vm_name()`, and `compose_prefix()` functions call these pure functions internally.

### 4. Makefile default for dev

The `Makefile` sets `SPEEDWAVE_DATA_DIR ?= $(HOME)/.speedwave-dev` so that `make dev`, `make test`, and all other Makefile targets use a separate data directory by default, isolating dev from production without any manual configuration.

### 5. Shell script alignment

`scripts/e2e-vm.sh` derives the instance name using `basename "$SPEEDWAVE_DATA_DIR" | sed 's/^\.//'` — functionally identical to `derive_instance_name_from()`. Both locations carry SSOT comments pointing at each other.

## Consequences

### Positive

- Full isolation between production and dev instances: separate Lima VM, data files, compose projects, tokens, plugins, and MCP OS worker
- Default behavior (without the env var) is identical to before — no migration required for existing users
- Pure helper functions make the resolution logic easy to unit-test without process-level mutation

### Negative

- `OnceLock` means the data dir cannot change mid-process — this is intentional (single-instance design), but rules out dynamic switching
- Shell script (`e2e-vm.sh`) has duplicated basename derivation logic — a pragmatic trade-off for avoiding a Rust binary dependency in CI scripts; both locations carry cross-reference comments

### Non-goals

- Multi-instance support within a single process (ruled out by `OnceLock` design)
- Migration tool for moving data between directories (users create a fresh instance)
- Changing the default data directory name (remains `.speedwave`)

## Rejected Alternatives

### 1. Separate env vars for each resource (VM name, compose prefix, tokens path)

Rejected because a single env var that derives all names is simpler and eliminates the risk of inconsistent overrides. One variable, one source of truth.

### 2. CLI flag instead of env var

Rejected because the env var must be available before `main()` runs (for `OnceLock` initialization) and must propagate consistently to all subprocesses. An env var set in the Makefile achieves both naturally; a CLI flag would require plumbing through every binary and script.

### 3. Config file entry for data directory

Rejected because the config file itself lives inside the data directory (`~/.speedwave/config.json`) — a circular dependency. The data directory must be resolved before any config file can be read.
