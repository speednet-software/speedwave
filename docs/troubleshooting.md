# Troubleshooting

## Local LLM: models discover but chat fails silently

**Symptom:** A local provider (LM Studio / Ollama / llama.cpp) lists models in
Settings, but a chat with that model never answers.

**Cause:** A `base_url` with a loopback host (`http://127.0.0.1:<port>`,
`localhost`) reaches the LLM during host-side discovery but not during a session:
sessions originate inside the proxy container, where `127.0.0.1` is the
container itself, not the host running the LLM.

**Recovery:** Re-save the provider in Settings → LLM providers. Loopback hosts
are now canonicalized to `http://host.docker.internal:<port>`, which the proxy
container can reach. New saves are fixed automatically.

**Note:** The provider form discovers models only when you click **discover
models** (after entering the base URL and any API key) — it no longer probes
automatically. The model field and Save appear only after a successful
discovery (or a previously saved model). A discovery failure shows a specific
reason (authentication failed → check the API key; reachable but HTTP error;
not reachable → server down).

---

## Chat session ends immediately ("ended unexpectedly") on a managed enterprise account

**Symptom:** Every Desktop chat turn or CLI session exits right after start with
a generic "session ended unexpectedly" error. Personal accounts on the same
machine work fine.

**Cause:** Claude Code 2.1.163+ honors the `requiredMinimumVersion` /
`requiredMaximumVersion` managed (organization) settings: if the pinned Claude
Code version inside the Speedwave container falls outside your organization's
allowed range, the binary refuses to start. Speedwave pins the version per
release (`defaults.rs::CLAUDE_VERSION`) and disables the auto-updater, so the
in-container version can only change with a Speedwave update.

**Recovery:** Check the version your organization allows (ask your admin) and
update Speedwave to a release whose pinned Claude Code version falls inside the
range. The pinned version is listed in the diagnostics ZIP
(`system-info.txt` → `claude_pinned`).

---

## "WARNING: image has Claude Code X but the pinned version is Y" in container logs

**Symptom:** The claude container log shows a version-skew warning at start.

**Cause:** The container image was built for a different Claude Code version
than the one this Speedwave release pins — typically an interrupted or skipped
image rebuild after an update.

**Recovery:** Run `speedwave update` (or restart the project from Desktop,
which reconciles images) so the claude image is rebuilt for the pinned version.

---

## Git worktrees created inside the chat session look broken on the host

**Symptom:** A worktree created by Claude inside the container (e.g. under
`.claude/worktrees/`) shows up on the host, but `git worktree list` or `git
status` on the host reports broken paths.

**Cause:** The container mounts the project at `/workspace`, so worktree
metadata records absolute `/workspace/...` paths that do not exist on the
host. Additionally, Claude Code manages its own worktrees under
`.claude/worktrees/` (locking, periodic sweeps) — the same directory
convention used for host-side worktrees.

**Recovery:** Treat container-created worktrees as container-only. On the
host, `git worktree prune` removes the stale registrations; keep host-side
worktrees and container-side worktrees separate.

---

## Repository `.claude/settings.json` permission rules affect Speedwave sessions

Claude Code applies `deny` permission rules from a repository's committed
`.claude/settings.json` even in bypass-permissions mode (which Speedwave uses
inside the hardened container). Since Claude Code 2.1.162/2.1.166 these rules
are matched more strictly (wildcards, `$HOME` references, `WebFetch` domain
rules). If a tool call is unexpectedly blocked, check the project's committed
`.claude/settings.json` for `deny` rules before suspecting Speedwave.

---

## Claude container exits with code 137 during multi-agent runs

**Symptom:** The claude container is killed (exit 137) while running many
background agents or sub-agents (`claude agents`, nested sub-agent fan-out).

**Cause:** All agents inside the container share one fixed resource envelope
(6 GiB memory / 2 CPUs — see `resources.rs::CLAUDE_RESOURCES`); a wide agent
fan-out can exhaust it. 137 here means the whole container hit its memory cap,
not that a single conversation leaked.

**Recovery:** Reduce parallel agent fan-out inside chat sessions. The limits
are deliberate (ADR-068); they are ceilings shared by everything running in
the claude container.

---

## After upgrading: OS integration is disabled and a banner appears

**Symptom:** After installing a new Speedwave version, the Integrations view
shows an amber banner like _"OS integration disabled — macOS does not currently
grant Speedwave permission for `<service>`"_. The Calendar / Reminders / Mail /
Notes toggle was previously ON and is now OFF.

**Cause:** Speedwave 0.11.0 changed how each native macOS CLI binary
(`calendar-cli`, `reminders-cli`, `mail-cli`, `notes-cli`) identifies itself to
the macOS Transparency, Consent and Control (TCC) system. Each binary now
embeds its own `Info.plist` with a unique sub-identifier
(`pl.speedwave.desktop.<service>`). TCC indexes permission grants by
identifier — your previous grant was bound to the old identifier (e.g.
`calendar-cli`) which no longer exists, so macOS reports the new identifier as
"never asked". Speedwave detects this on startup and disables the toggle to
keep the UI honest with the actual macOS state.

**Recovery:**

Click each affected toggle once. macOS shows a fresh consent dialog. Click
_Allow_. The integration is now bound to the new identifier and the banner does
not reappear.

This is a one-time migration. See ADR-049 for the rationale.

---

## Calendar / Reminders / Mail / Notes permission previously denied

**Symptom:** Enabling an OS integration shows a toast like:

> Calendar access was previously denied. Open Terminal and run:
> tccutil reset Calendar pl.speedwave.desktop.calendar
> Then click the toggle again.

**Cause:** The user previously clicked _Don't Allow_ in the TCC consent dialog.
Apple removed the `+` button from System Settings → Privacy & Security on
macOS 14+, so there is no UI path to re-add Speedwave. The `tccutil reset`
command is the only recovery path.

**Recovery:** Run the exact command shown in the toast. The TCC service name
and the bundle identifier depend on the integration:

| Integration | TCC service   | Identifier                       | Full command                                             |
| ----------- | ------------- | -------------------------------- | -------------------------------------------------------- |
| Calendar    | `Calendar`    | `pl.speedwave.desktop.calendar`  | `tccutil reset Calendar pl.speedwave.desktop.calendar`   |
| Reminders   | `Reminders`   | `pl.speedwave.desktop.reminders` | `tccutil reset Reminders pl.speedwave.desktop.reminders` |
| Mail        | `AppleEvents` | `pl.speedwave.desktop.mail`      | `tccutil reset AppleEvents pl.speedwave.desktop.mail`    |
| Notes       | `AppleEvents` | `pl.speedwave.desktop.notes`     | `tccutil reset AppleEvents pl.speedwave.desktop.notes`   |

> **Note:** Mail and Notes use the `AppleEvents` TCC service (not `Mail` or
> `Notes`) because they communicate via Apple Events, which TCC scopes per
> (sender, target) under that single service name. Running `tccutil reset Mail`
> would not reset the right entry — this is _not_ an oversight in the message.

After the reset, click the toggle again and choose _Allow_ in the consent
dialog.

---

## Calendar / Reminders TCC prompt does not appear

**Symptom:** Enabling the Calendar or Reminders integration shows a toast like:

> Calendar permission was silently rejected by macOS. This usually means a
> signing or entitlement problem — please reinstall Speedwave from a fresh
> download.

**Cause:** macOS TCC silently rejected the permission request without showing
the consent dialog. On macOS 14+ this happens when the binary calling EventKit
lacks an embedded `Info.plist` containing `NSCalendarsFullAccessUsageDescription`
or `NSRemindersFullAccessUsageDescription` — the parent `.app`'s Info.plist
does not propagate across `posix_spawn` to a child CLI binary.

This was the _original_ Calendar TCC bug fixed in 0.11.0 by embedding
`Info.plist` directly into each native CLI's Mach-O `__TEXT,__info_plist`
section. If you see this message on 0.11.0 or later, the bundle is corrupted
or has been tampered with — the embedded section is required by build and
verified by signing.

**Recovery:**

1. Reset any stale TCC entry from the legacy identifier:
   ```
   tccutil reset Calendar calendar-cli
   tccutil reset Reminders reminders-cli
   tccutil reset Calendar pl.speedwave.desktop.calendar
   tccutil reset Reminders pl.speedwave.desktop.reminders
   ```
2. Reinstall Speedwave from a fresh download at [GitHub Releases](https://github.com/speednet-software/speedwave/releases).
3. Click the toggle again — the system consent dialog should appear.

---

## SharePoint: "cannot reach oauth worker"

**Symptom:** SharePoint tools fail with a message containing:

> cannot reach oauth worker: ... Restart the project from Speedwave Desktop.

or:

> oauth worker did not respond within 30s. Restart the project from Speedwave Desktop.

**Cause:** The host-side `oauth` worker rotated its loopback port (e.g. it was respawned by the watchdog), and the SharePoint container is still pointing at the old port via `WORKER_OAUTH_URL` until its compose is re-rendered. Until containers are recreated, OAuth refresh requests hit a dead socket — surfaced as `OAuthRefreshError(worker_unreachable)` / `OAuthRefreshError(timeout)`.

**Recovery:** Restart the project from Speedwave Desktop. The compose render that runs on start picks up the live oauth port and re-issues the env var into every consumer container. The watchdog also recreates containers automatically after a respawn — most users see this error only during the short window between the worker coming back up and containers picking up the new env.

---

## Mail / Notes integration shows "<App>.app is not running"

**Symptom:** Enabling the Mail or Notes integration shows a toast like:

> Mail.app is not running. Open Mail.app and try again — this is not a
> permission problem.

**Cause:** Mail and Notes integrations use Apple Events to drive the host app.
If the target app (Mail.app or Notes.app) is not running, TCC's
`AEDeterminePermissionToAutomateTarget` returns `procNotFound` and Speedwave
correctly distinguishes this from a permission problem — `tccutil reset` would
not help, you need to actually open the app.

**Recovery:** Open Mail.app or Notes.app from Finder / Spotlight, then click
the toggle again.

---

## Contributor verification (macOS)

When contributing changes to Calendar/Reminders/Mail/Notes signing,
entitlements, embedded `Info.plist`, or the unified `PermissionGate`, run:

```bash
# Verify Info.plist files and entitlements plists are well-formed and
# carry the expected keys / sub-identifiers
make test-desktop-build

# Verify Swift logic — the unified PermissionGate, AppleEventsGate
# OSStatus mapping, composeErrorMessage tccutil text, etc.
make test-swift

# Verify the Rust ↔ Swift contract — parse_permission_output handles
# the new sub-identifier and AppleEvents service strings
make test-rust
```

After a fresh build, you can verify each native CLI's embedded section
manually:

```bash
# Each line should print "Contents of (__TEXT,__info_plist) section" + hex
for svc in calendar reminders mail notes; do
  bin="native/macos/$svc/.build/arm64-apple-macosx/release/$svc-cli"
  echo "=== $svc ==="
  otool -s __TEXT __info_plist "$bin" | head -3
done

# Each binary's CFBundleIdentifier must be pl.speedwave.desktop.<svc>
for svc in calendar reminders mail notes; do
  bin="native/macos/$svc/.build/arm64-apple-macosx/release/$svc-cli"
  thin=$(mktemp)
  lipo -thin arm64 "$bin" -output "$thin"
  segedit "$thin" -extract __TEXT __info_plist /tmp/sw-${svc}-plist.plist
  echo "$svc: $(plutil -extract CFBundleIdentifier raw /tmp/sw-${svc}-plist.plist)"
  rm "$thin"
done
```

See also: `docs/contributing/release-signing.md` for the full macOS signing,
local verification, and local notarization procedures, and `docs/adr/ADR-049-tcc-sub-identifiers-and-applevents-gate.md`
for the architectural rationale.
