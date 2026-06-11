# ADR-074: Reconstruct host-bridge env from disk for off-Desktop compose renders

**Status:** Accepted
**Date:** 2026-06-11

## Context

[ADR-063](ADR-063-host-bridge-generic.md) introduced the generic
`HostBridge` and two optional manifest knobs — `preferred_port` and
`persistent_token` — for plugins that pair a containerized worker with
an external app the user configures once (e.g. a design-tool companion
app declaring `preferred_port: 60123`, `persistent_token: true`).

The bridge listener (the loopback WebSocket relay) lives only in the
Speedwave **Desktop** process (`desktop/src-tauri/src/bridges/`). At
compose-render time, `compose::render_compose` takes a `HostBridgesInfo`
and the plugin injection path applies each registration's
`url_env`/`token_env` to the matching worker service. Desktop populates
that list from its live, running bridges
(`reconcile::current_bridges_info`).

The **off-Desktop** callers had no equivalent: the CLI launch, the
`update` path, and project-add all passed `HostBridgesInfo::default()`
(an empty list). Two failures followed:

1. A worker launched from the terminal never received its bridge
   URL/token env vars, so every bridge tool returned
   `BRIDGE_NOT_CONFIGURED` — even with Desktop running.
2. Both interfaces key the compose stack by project directory and so
   share **one** per-project compose file and **one** `mcp-<slug>`
   worker container. A CLI render rewrote the worker service without
   the bridge env, and `compose up` recreated it[^1] — breaking the
   bridge in the **Desktop** session too, until Desktop re-rendered.

The connection parameters, however, are deterministic and on disk
whenever the manifest opts into both knobs from ADR-063: the port is
the fixed `preferred_port`, and the token is persisted at
`<data_dir>/plugin-state/<slug>/bridge-token`. So an off-Desktop
context can reconstruct exactly what a running Desktop process binds,
without querying it.

## Decision

Off-Desktop `render_compose` callers reconstruct the bridge
registrations from disk instead of passing an empty list. This does
**not** move the listener — Desktop still owns it; the CLI becomes a
second client of the same Desktop-hosted relay. Speedwave has no
background daemon ([ADR-008](ADR-008-no-background-daemon.md)), so the
listener exists only while Speedwave Desktop is open; a bridge from the
terminal therefore requires Desktop to be running.

### New runtime API (`compose/mod.rs`)

- `host_bridges_from_disk() -> HostBridgesInfo` — iterates
  signature-verified plugins (the same `list_verified_*` source the
  plugin injection path uses) and, for each, reads the persisted token
  and builds a registration. The dir-parameterized core
  (`host_bridges_from_disk_in`) makes both the zero-plugins and the
  list-error degradation branch unit-testable.
- `build_host_bridge_registration(manifest, token) -> Option<HostBridgeRegistration>`
  — pure mapping. A registration is produced **only** when the manifest
  declares a `host_bridge` with `persistent_token == true` **and** a
  `preferred_port`, and a valid persisted token is present.
- `plugin::read_persistent_bridge_token_from(plugins_dir, slug)` — reads
  `plugin-state/<slug>/bridge-token`; rejects symlinks, trims, and
  validates the value is a UUID so a malformed or multi-line value
  never reaches compose env injection.

Every off-Desktop `render_compose` caller calls
`host_bridges_from_disk()` and passes the result through: the CLI
launch (`speedwave-cli` `main()`), the update path
(`update::update_containers`), and project-add
(`project::add_project_with_validated_dir`). The Desktop callers
(`containers_cmd`, `setup_wizard`) keep using the live
`reconcile::current_bridges_info()`. Without fixing the `update` path
in particular, the stomp survived: `speedwave update` re-rendered the
shared per-project compose with an empty list and recreated the worker
without the bridge env, breaking an active bridge in the running
Desktop session.

### Eligibility is deliberately narrow

A plugin with a kernel-assigned random port or a per-session rotating
token is **not** reconstructable off-process, so its CLI workers keep
degrading to `BRIDGE_NOT_CONFIGURED`. This is documented behavior, not
a silent gap: the two manifest opt-ins are the contract for CLI parity.

Hard-failing `validate_manifest` when `persistent_token: true` is set
without a `preferred_port` was considered and **rejected**: validation
runs on every load (`list_verified_plugins`) and in the startup audit
(`audit_all` — Desktop recovery dialog, CLI exit 2), so a new error
would brick already-installed plugins, and per the plugin
breaking-change rule it would require coordinating with the plugins
repository first. The existing install-time `log::warn!` in
`validate_manifest` plus the graceful degradation above is the
deliberate trade-off.

### Security: verified manifest, unsigned-state token

The manifest fields that drive injection (`url_env`, `token_env`,
`preferred_port`) are read from `list_verified_plugins()`, preserving
the Ed25519 runtime-verification invariant of
[ADR-051](ADR-051-plugin-signature-runtime-verification.md). The token
lives under `plugin-state/<slug>/`, which ADR-051 keeps **outside** the
signed tree, so reading it separately does not weaken that guarantee.
The reader rejects symlinks (symmetric with the `secrets/<project>/*`
token reads in compose) and accepts only UUID-shaped content.
`HostBridgeRegistration` carries the token as a bearer secret, so it
implements a redacting `Debug` instead of deriving it.

### SSOT for the token filename

`BRIDGE_TOKEN_FILENAME` ("bridge-token") moves to
`speedwave_runtime::plugin`; the Desktop bridge re-exports it. Both the
writer (Desktop) and the reader (off-Desktop renders) now share one
constant, pinned by a literal test so a rename stays a deliberate
cross-component change.

## Files touched

| File                                                                                                                                           | Change                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `crates/speedwave-runtime/src/plugin.rs`                                                                                                       | + `BRIDGE_TOKEN_FILENAME` (SSOT), `read_persistent_bridge_token_from` (symlink-rejecting, UUID-validated) + tests     |
| `crates/speedwave-runtime/src/compose/mod.rs`                                                                                                  | + `host_bridges_from_disk{,_in}`, `collect_host_bridges`, `build_host_bridge_registration`, redacting `Debug` + tests |
| `crates/speedwave-cli/src/main.rs`                                                                                                             | build registrations from disk before `render_compose` + structural test                                               |
| `crates/speedwave-runtime/src/update.rs`                                                                                                       | `update_containers` reconstructs bridges from disk + structural test                                                  |
| `crates/speedwave-runtime/src/project.rs`                                                                                                      | `add_project_with_validated_dir` reconstructs bridges from disk + structural test                                     |
| `desktop/src-tauri/src/bridges/plugin_host_bridge.rs`                                                                                          | `BRIDGE_TOKEN_FILENAME` becomes a `pub use` re-export from runtime                                                    |
| `docs/guides/integrations.md`                                                                                                                  | "Bridge plugins — dev UX" documents the CLI path                                                                      |
| `CLAUDE.md`, `docs/adr/ADR-051-plugin-signature-runtime-verification.md`, `docs/adr/ADR-015-plugin-system.md`, `docs/architecture/security.md` | enumerate `bridge-token` as a second `plugin-state/` file (0600 secret)                                               |

## Consequences

### Positive

- Any bridge plugin that opts into the two knobs works from a
  `speedwave` terminal session while Speedwave Desktop is running.
- The stomp is gone: both interfaces compute identical bridge env, so
  the worker service renders byte-identical and `compose up` does not
  recreate it. Fixing the injection asymmetry also fixes the
  cross-interface breakage.

### Negative

- A bridge still requires Speedwave Desktop to be running, because the
  listener lives there. A fully Desktop-less CLI bridge would require
  extracting the listener into a host-side worker the CLI can spawn
  (single-owner arbitration via the lock file, mirroring `host_exec` /
  `oauth`). That is a larger change and is **out of scope** here.
- `list_verified_plugins()` runs once more per off-Desktop render (in
  `host_bridges_from_disk`, in addition to the call inside
  `render_compose`). Signature verification is cached
  (`verify_plugin_signature_cached`, ADR-051), so the second call is
  negligible.

### Neutral

- No filtering by the project's enabled-plugin set. The plugin
  injection path applies env only for the enabled, slug-matched worker,
  so a registration for an installed-but-disabled plugin is inert.

## References

- [ADR-063](ADR-063-host-bridge-generic.md) — the generic `HostBridge`
  and the `preferred_port` / `persistent_token` manifest knobs this
  ADR consumes.
- [ADR-051](ADR-051-plugin-signature-runtime-verification.md) —
  Ed25519 signature as a runtime invariant; mutable per-plugin state
  under `plugin-state/`.
- [ADR-008](ADR-008-no-background-daemon.md) — no background daemon;
  the listener's lifetime is the Desktop process.
- `docs/guides/integrations.md` → "Bridge plugins — dev UX".

## Footnotes

[^1]:
    Docker Compose recreates a service's containers when the service
    definition changes between `up` invocations; an unchanged
    definition is left running as-is.
    <https://docs.docker.com/reference/cli/docker/compose/up/>
    nerdctl implements Compose-compatible commands (`nerdctl compose up`)
    and is the runtime Speedwave drives, so the same recreate-on-change
    behavior applies.
    <https://github.com/containerd/nerdctl/blob/main/docs/compose.md>
