# Troubleshooting

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

---

## Local LLM: chat fails with HTTP 422 "Input should be 'user' or 'assistant'"

**Symptom:** You configured a local provider (e.g. unsloth llama-server, a
custom llama.cpp build) and Speedwave reports the server as found, but every
chat attempt fails with an error like:

```
API Error: 422 {"detail":[{"type":"literal_error","loc":["body","messages",1,"role"],
"msg":"Input should be 'user' or 'assistant'","input":"system"}]}
```

**Cause:** Claude Code sends the system prompt as a `{role:"system"}` element
inside the `messages[]` array. Servers that enforce a strict Anthropic Messages
schema (such as some llama-server / unsloth builds) reject this — their schema
requires the system prompt in a separate top-level `system` field, not as a
role inside `messages[]`. Speedwave has no proxy between Claude Code and the
server (ADR-040) and cannot reshape the request.

Starting with Speedwave v0.14, the Settings → LLM Provider discovery probe
detects this incompatibility and shows a warning _before_ you start a session.
If you see the warning, the server is not fully compatible with Claude Code's
Anthropic Messages payload.

**Resolution:** Switch to a server that accepts Claude Code's request shape:

- **Ollama 0.14+** — supports `system` role inside `messages[]`.
- **LM Studio 0.4.1+** — compatible with the Anthropic Messages schema Claude
  Code uses.
- **llama.cpp (January 2026 build or later)** — recent builds accept the full
  Anthropic schema.
- **LiteLLM** — route via the `/anthropic` prefix for full schema translation.

---

## Local LLM: cannot connect — use host.docker.internal, not localhost

**Symptom:** You configured a local LLM server on your machine and entered
`http://localhost:<port>` (or `http://127.0.0.1:<port>`) as the base URL.
Discovery fails with "connection refused" or the chat session cannot reach the
server.

**Cause:** Claude Code runs inside a container (Lima VM on macOS, WSL2 on
Windows). Inside the container, `localhost` and `127.0.0.1` resolve to the
_container itself_, not your host machine. Only `host.docker.internal` is
mapped to the host via the Compose `extra_hosts` entry that Speedwave injects
at container start.

**Why `0.0.0.0` is also wrong:** `0.0.0.0` is a bind address, not a
destination address. It means "listen on all interfaces" when starting a
server, but it is not a valid target for outbound connections. Speedwave's
SSRF validator rejects it.

**Resolution:**

1. Set **Base URL** to `http://host.docker.internal:<port>` in Settings →
   LLM Provider.
2. Start your local server bound to all interfaces so the container can reach
   it from the VM network. For llama-server / llama.cpp:
   ```
   llama-server -H 0.0.0.0 -p 8888 ...
   ```
   For Ollama the default bind already covers the VM network on macOS (Lima
   VZ NAT) and Windows (WSL2 mirrored mode). On Windows you may need to set
   `OLLAMA_HOST=0.0.0.0`.
3. Save the configuration and click **discover models** to verify connectivity.
