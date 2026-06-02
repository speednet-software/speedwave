# ADR-050: Host Timezone Propagation Into Containers

**Status:** Accepted

**Date:** 2026-05-06

## Context

Speedwave containers (claude, mcp-hub, all MCP workers, plugin workers) inherit no timezone information from the host. The Debian-slim base of `Containerfile.claude` and the alpine bases of `Containerfile.mcp-base` and `mcp-servers/hub/Containerfile` default to **UTC**. As a result, time-sensitive output produced inside the claude container is rendered in UTC — most visibly Claude Code's "your usage limit will reset at HH:MM" message, which appears 1–2 hours off for users in CET/CEST and similarly skewed for any zone other than UTC.

The fix surface has two halves:

1. **Detection on the host.** The Tauri process knows the host's IANA timezone via the OS (`/etc/localtime` symlink on macOS, `Get-TimeZone` on Windows).
2. **Propagation into containers.** The mechanism must work uniformly across Lima (macOS) and WSL2 (Windows), and must extend to plugin worker containers built by a separate repository (`speedwave-plugins`) without breaking their existing contract.

A bind-mount of `/etc/localtime` was considered (the Docker convention). Rejected because Windows has no equivalent file and the per-platform divergence would invert the "single SSOT for container env" rule already established in `compose.rs`.

## Decision

### Detection

`crates/speedwave-runtime/src/tz.rs::detect_host_timezone()` returns the host IANA zone as a `String` (never errors):

- **Unix (macOS):** read `/etc/localtime` as a symlink; extract the path suffix after the last `zoneinfo/` segment (e.g. `/var/db/timezone/zoneinfo/...`). Fall back to `$TZ` if the symlink is missing or doesn't point into `zoneinfo/`. The fallback validates `$TZ` against an IANA-shape regex to reject glibc-isms like `:Europe/Warsaw` and path-traversal strings.[^1][^2]
- **Windows:** invoke `powershell -NoProfile -NonInteractive -Command "(Get-TimeZone).Id"` (5 s deadline) and map the Windows zone ID to IANA via an inline `WINDOWS_TO_IANA` table sourced from CLDR `windowsZones.xml` (territory `001`).[^3][^4]
- **Fallback:** on any failure, log `warn!` and return `"Etc/UTC"`. Never panics, never returns `Err`.

### Propagation

A new helper `compose::inject_host_timezone(&yaml, &tz)` walks every entry under `services:` in the rendered compose document and appends `TZ=<tz>` to the service's `environment` sequence. It is idempotent (skips services that already carry a `TZ` entry) and creates an empty `environment` sequence for services that lack one.

The helper is invoked **after** `apply_plugins()` so plugin services injected dynamically also receive `TZ`. This keeps the SSOT single (one Rust function injects into one location) and avoids duplicating `TZ=${HOST_TZ}` seven-plus times in `compose.template.yml`.

### `tzdata` in base images

Setting `TZ=Europe/Warsaw` is a no-op without the zoneinfo database. The decision adds `tzdata` to four base images:

- `containers/Containerfile.claude` (`apt-get install ... tzdata`)
- `containers/mcp-servers/Containerfile.mcp-base` (`apk add --no-cache tzdata`)
- `mcp-servers/hub/Containerfile` (`apk add --no-cache curl tzdata`)
- `mcp-servers/office/Dockerfile` (Debian/bookworm, `apt-get install ... tzdata` — ADR-055)

The Playwright worker uses `mcr.microsoft.com/playwright:*-jammy`, which already ships `tzdata` from the Ubuntu base — no change.

This pair (detection in `tz.rs` ↔ `tzdata` in these base images) is recorded in CLAUDE.md as a new SSOT-alignment row. Adding another base image is a compile-time invitation to reread that row.

### Plugins

The plugin contract (per CLAUDE.md plugin-contract table) gains an additive guarantee: plugin workers receive `TZ` in their environment. Plugin authors who want named-zone resolution should install `tzdata`; plugin authors who don't will see a fixed offset, which is still strictly better than the previous UTC-only behavior. The plugin manifest schema and signature surface are untouched, so no coordinated release with `speedwave-plugins` is required.

## Consequences

**Positive.**

- Claude Code's limit reset times match the host clock.
- Worker logs (Slack, Redmine, etc.) timestamp in local time.
- Plugin workers automatically benefit without a contract bump.

**Negative.**

- Three base images grow by the size of `tzdata` (~3.5 MB installed on Debian, ~3.5 MB on Alpine).[^5][^6]
- Windows zone-ID mapping table must be refreshed when CLDR ships changes. CLDR's release schedule is two major releases per year (Spring and Fall), so the table must be revisited on roughly that cadence — though most releases ship no Windows-zone changes.[^7]
- A user changing their host timezone after starting containers will not see the change reflected until the next compose render (`speedwave start` / project restart). Acceptable — Claude Code reset windows are session-scoped, and the alternative (live-reloading `TZ` into running containers) violates KISS.

[^1]: IANA tz database — authoritative source of zone names: <https://www.iana.org/time-zones>

[^2]: glibc `TZ` env var format (`:Europe/Warsaw` colon-prefix variant rejected to prevent path leaks): <https://www.gnu.org/software/libc/manual/html_node/TZ-Variable.html>

[^3]: PowerShell `Get-TimeZone` cmdlet documentation: <https://learn.microsoft.com/powershell/module/microsoft.powershell.management/get-timezone>

[^4]: CLDR `windowsZones.xml` (territory `001` default mapping): <https://github.com/unicode-org/cldr/blob/main/common/supplemental/windowsZones.xml>

[^5]: Debian `tzdata` package — installed size 3,572 kB on bookworm: <https://packages.debian.org/bookworm/tzdata>

[^6]: Alpine `tzdata` package — installed size approximately 3.5 MiB: <https://pkgs.alpinelinux.org/package/edge/main/x86_64/tzdata>

[^7]: CLDR release schedule — major releases every March (`-1`) and October (`-2`): <https://cldr.unicode.org/index/downloads>
