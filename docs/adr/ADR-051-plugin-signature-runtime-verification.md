# ADR-051: Plugin Signature as a Runtime Invariant

**Status:** Accepted

**Date:** 2026-05-08

## Context

Speedwave verifies plugin Ed25519 signatures against an embedded Speednet public key during `speedwave plugin install`. The verifier itself is correct: it computes a deterministic SHA-256 of every file under the plugin tree (excluding `SIGNATURE`), then verifies the signature against that digest using `ed25519-dalek`.[^1][^2]

The defect was structural — `verify_plugin_signature` was called from exactly one production site, `install_plugin_with_base` in `crates/speedwave-runtime/src/plugin.rs`. Every code path that subsequently _read_ the plugin tree trusted the on-disk contents blindly:

- `apply_plugins` in `compose.rs` rendered MCP services and bind-mounted `claude-resources/` into the claude container.
- `ensure_plugin_images_from_dir`, `ensure_all_plugin_images_from_dir`, `build_pending_from_dir`, and `build_single_plugin_image` read each plugin's `Containerfile` and invoked `prepare_build_context` + `build_image`.
- The CLI's `plugin list` and the Desktop's `get_plugins` listed manifests without revalidation.

`~/.speedwave/plugins/<slug>/` is writable by the user. A local attacker (npm postinstall, browser RCE, malware running as the user) could either:

1. **Drop a fresh directory** with a forged `plugin.json` (and no `SIGNATURE`), and Speedwave would build its `Containerfile` (`RUN <arbitrary>` runs at build time) and bind-mount its `claude-resources/hooks/` into the claude container (executed on every Claude tool call), or
2. **Modify a legitimately-signed plugin** post-install. The signature was never reread, so any later change to the tree was invisible — including swapping the `Containerfile` or replacing a skill with attacker-supplied content.

The signing system was therefore an install-time gate, not a runtime integrity invariant. The fix is to treat the signature as the latter: every read of the tree must observe a state that matches the signature, and any mutation must invalidate the verdict.

A secondary bundle of weaknesses surfaced during the audit:

- The `image_pending` build marker was written _into_ the signed tree (`<plugin>/.image_pending`), so install of a fresh MCP plugin permanently invalidated its own digest.
- `compute_plugin_digest` followed symlinks via `is_dir()` and `read()`, so an attacker could drop `claude-resources/skills/foo.md → /etc/passwd` and the signed digest would fold in arbitrary host content.
- Install used `remove_dir_all + copy_dir_recursive` with no lock and no atomic rename, so two concurrent installs for the same slug could produce a half-A/half-B tree.
- `make build-tauri` produced production installers (.dmg, .app, .exe) whose bundled `speedwave` CLI was a _debug_ build — and the `SPEEDWAVE_ALLOW_UNSIGNED` bypass in `signing::unsigned_bypass_active` is `cfg(debug_assertions)`-gated, which only flips off in the release profile.[^3]
- `validate_manifest` accepted `LD_PRELOAD` / `DYLD_*` / `NODE_OPTIONS` in `extra_env`, accepted `mem_limit: "999g"` (989 GiB), allowed `token_mount: read_write` for any plugin (despite ADR-009 reserving it for SharePoint), and admitted slugs that derived a compose name colliding with built-in services (`hub` → `mcp-hub`).

## Decision

### Signature is verified on every load, not just install

`signing::verify_plugin_signature_cached` (new) is the only verifier production code uses. It computes the plugin's content digest once per call, looks it up in a process-global `Mutex<HashMap<canonical PathBuf, CacheEntry>>`, and returns the cached verdict if the digest matches. On miss, it runs Ed25519 verification with the freshly-computed digest passed in (`verify_plugin_signature_with_digest`) — no double hashing. SHA-256 is the integrity check itself, so it always runs; the cache eliminates only the ~150 µs Ed25519 step. `signing::invalidate_cache` clears the verdict on install/remove.

Stat-only cache keys (mtime + len) were rejected: `utimensat` makes those trivially spoofable.[^4]

### Trusted-path loaders

The runtime exposes two loaders. `list_verified_plugins` returns `Vec<VerifiedPlugin { manifest, dir }>` — fail-closed, with `dir.file_name() == manifest.slug` enforced. Callers (`apply_plugins`, image builders, Claude wiring) use `vp.dir`; they never reconstruct a path via `plugins_base.join(manifest.slug)`. Without the dir/slug enforcement an attacker dropping `evil/plugin.json` whose `slug: "good"` would silently re-route every caller to a different on-disk tree.

`list_for_ui` is the tolerant counterpart. It returns one `PluginListEntry` per directory with a `verification_status` discriminator (`Verified` / `MissingSignature` / `InvalidSignature` / `DirSlugMismatch` / `ManifestInvalid`) and a `verification_error` string. The Desktop UI uses this so users can see _what_ is broken; the green pill becomes red with a short label and a tooltip.

`audit_all` is the startup pass. It collects every failure into a `Vec<(slug, reason)>` and is called both from the Desktop `.setup()` callback and from the CLI before any non-recovery action. Both surfaces show the user every failed plugin in one report.

### Runtime invariants in compose

`apply_plugins` switched from `list_installed_plugins` to `list_verified_plugins`, so a single tampered plugin aborts the whole compose render. It also re-runs `validate_manifest` at render time, so growing the validator (PR1's added rules: dangerous env keys, mem/cpu caps, slug collision, `token_mount: read_write` rejection) does not silently grandfather installed plugins.

`services.insert(...)` for an MCP plugin now bails on key collision instead of silently overwriting. `claude-resources/` mounts go through `ensure_resources_dir_safe`, which rejects a symlinked root, a non-directory root, a canonicalisation that escapes the plugin tree, and any nested symlink in the subtree.

### Mutable state outside the signed tree

Per-plugin mutable state lives at `~/.speedwave/plugin-state/<slug>/`, not under `~/.speedwave/plugins/<slug>/`. The only state today is `image_pending` (signal that the next launch should retry an image build). Reads tolerate the legacy in-tree marker during a migration window so plugins installed before this ADR keep building; new writes always go to `plugin-state/`.

### Atomic install

`install_plugin_with_base` now:

1. Holds an exclusive flock on `<plugins_base>/.install.lock` (`fs2::FileExt`).
2. Extracts the ZIP into `tempfile::tempdir_in(plugins_base)` — same filesystem as the destination, perms 0o700. Closes the predictable `/tmp/speedwave-plugin-<uuid>` TOCTOU.
3. Verifies signature, parses manifest, validates manifest in the tempdir.
4. Copies into `<plugins_base>/<slug>.installing.<uuid>`, then renames the existing `<slug>` (if any) to `<slug>.removing.<uuid>`, then atomic-renames the staging dir into place.
5. Cleans up the `.removing.*` dir; on rename failure, rolls the old dir back into place.

`list_*` functions filter `.installing.*` and `.removing.*`, so the transient dirs are never visible to UI / build / compose.

`copy_dir_recursive` rejects symlinks too, as defence in depth — the same invariant `compute_plugin_digest` enforces, applied earlier.

### Hard-fail at startup with explicit recovery

The Desktop `.setup()` callback runs `audit_all` and, on failure, shows a Tauri 2 dialog with every slug+reason and the CLI commands that fix them, then exits. The dialog uses `.show(callback)` instead of `.blocking_show()` — the latter can deadlock the setup thread on Linux if the window manager isn't ready.[^5]

The CLI runs the same audit _after_ Help and SelfUpdate (which exit before reaching this point) and _before_ any action that touches the runtime. Recovery actions (`Init`, `PluginInstall`, `PluginList`, `PluginRemove`) skip the audit so a user with a bad plugin can list status, install a fresh signed plugin, or remove the broken one even when another plugin is failing. The skip list is an explicit allow-list, so any future `CliAction` variant defaults to gated.

The Desktop dialog deliberately does not say "open Settings" — Settings is behind the audit gate. Recovery instructions point at `speedwave plugin remove <slug>` and manual `~/.speedwave/plugins/<slug>/` cleanup.

### Verified-only commands

Tauri commands that mutate plugin state (`set_plugin_enabled` for enable, `save_plugin_credentials`, `plugin_save_settings`, `plugin_load_settings`) call the new `require_verified` helper. Disable, remove, and credential deletion stay tolerant — those are recovery actions. `plugin_save_settings` additionally caps payload at 64 KiB to prevent a runaway plugin from bloating `user_config.json`.

### Build hygiene

`Makefile` has a new `build-cli-release` target. `build-tauri` depends on it and copies `target/release/speedwave*` into the bundled CLI directory. `build-cli` (debug) is unchanged so `make dev` and ad-hoc developer runs are not slowed down. Behavioral verification: release CLI + `SPEEDWAVE_ALLOW_UNSIGNED=1` + an unsigned plugin exits 2; debug CLI in the same scenario exits 0.

### Manifest validation

`consts::RESERVED_ENV_KEYS` is the SSOT for env keys plugins cannot inject — `PORT` (Speedwave-reserved), dynamic-linker hijacks (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, …), language-runtime hijacks (`NODE_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`), and shell-environment hijacks (`PATH`, `HOME`, `SHELL`, `IFS`, `BASH_ENV`, `ENV`). Comparison is case-insensitive.

`validate_manifest` rejects `mem_limit > PLUGIN_MEM_LIMIT_MAX_MIB` (16 384 MiB), `cpu_limit > PLUGIN_CPU_LIMIT_MAX` (4.0 cores), `token_mount: read_write` for any plugin (ADR-009 reserves it for built-in services), and slugs that produce a compose name in `BUILT_IN_SERVICES` (`hub`, `claude`, etc.).

## Consequences

### Positive

- A local attacker who can write under `~/.speedwave/plugins/` can no longer reach RCE — neither by dropping a forged tree nor by mutating a previously-legit one. Every read goes through `list_verified_plugins` or `list_for_ui`; both check the signature, both notice tamper.
- Bundle integrity has a build-side and a runtime-side gate. The runtime gate makes the build gate a defense-in-depth, not the only line of defense.
- The user has a defined recovery path. Hard-failing without it would force users to inspect the filesystem; the explicit CLI skip-list and verified-only-on-mutation rule give them one.

### Negative

- SHA-256 of every plugin tree runs on every load. For the in-tree plugin set (small, < 10 plugins, < 100 KiB total) this is ~milliseconds; not a hot path. The cache eliminates only Ed25519, not SHA-256, because SHA-256 is the integrity check itself.
- Any pre-PR-2 install that produced an `.image_pending` inside the signed tree fails verification on first launch. The migration helper tolerates a legacy in-tree marker during reads but does not re-sign — affected users must reinstall the plugin (a single zip drop), which the dialog/CLI message explains.
- Plugins legitimately containing symlinks (rare) are now rejected. The `speedwave-plugins` repo was checked; none use symlinks.

### Neutral

- The `validate_manifest` ruleset got stricter, and the `mem_limit` cap was raised from the planned 8 192 MiB to 16 384 MiB during implementation. The in-tree `presale` plugin requests 12 GiB for ML-heavy presale generation; an 8 GiB cap would have rejected it without giving operators a way to opt in. 16 GiB is the smallest cap that admits the existing legitimate plugin while still rejecting the manifestly-bad values the cap is there to catch (`mem_limit: 999g`, etc.). The cap does not weaken the threat model — the host VM (Lima default 4 GiB on macOS, configurable) still imposes the real ceiling at runtime; the manifest cap exists to surface absurd values at install time, not to be the resource-management primitive. Future plugins that need more than 16 GiB must either prove the case in a follow-up ADR or be a built-in service.

## Alternatives considered

**Stat-only cache (mtime + len).** Rejected — `utimensat` is in POSIX 2008 and unprivileged.[^4] An attacker could swap a file in place and restore the original mtime/len.

**On-disk cache (`.verified` marker).** Rejected — the marker would have to live outside the signed tree (per the same constraint that motivated `plugin-state/`), and persistence across restarts buys little compared to the security cost (additional path the cache trusts).

**Signed plugins shipped as zips and never extracted.** Rejected — the bind-mount model requires file paths into the host filesystem (claude-resources, plugins/<slug>/Containerfile build context). Mount-from-zip would require a FUSE layer that breaks the OWASP container hardening.

## Footnotes

[^1]: Internet Engineering Task Force, _RFC 8032: Edwards-Curve Digital Signature Algorithm (EdDSA)_. <https://datatracker.ietf.org/doc/html/rfc8032>

[^2]: `ed25519-dalek` v2 documentation. <https://docs.rs/ed25519-dalek/latest/ed25519_dalek/>

[^3]: The Rust Reference, "Conditional compilation": `debug_assertions` is `true` for the dev profile and `false` for the release profile, so `#[cfg(debug_assertions)]` blocks are not compiled into release binaries. <https://doc.rust-lang.org/reference/conditional-compilation.html#debug_assertions>

[^4]: POSIX `utimensat(2)` allows any file owner to set arbitrary atime/mtime. <https://pubs.opengroup.org/onlinepubs/9699919799/functions/utimensat.html>

[^5]: `tauri-apps/plugins-workspace` issue #956: `dialog::blocking_show` can deadlock the setup callback on Linux when the window manager isn't fully ready. <https://github.com/tauri-apps/plugins-workspace/issues/956>
