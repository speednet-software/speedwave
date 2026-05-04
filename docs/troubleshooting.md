# Troubleshooting

## Calendar / Reminders TCC prompt does not appear

**Symptom:** Enabling the Calendar or Reminders integration shows a toast like:

> Calendar permission was silently rejected by macOS. This usually means a signing or entitlement problem — please reinstall Speedwave from a fresh download.

**Cause:** The TCC system silently rejected the permission request. This happens when:

- The signed binary is missing the required Hardened Runtime entitlement (`com.apple.security.personal-information.calendars` or `com.apple.security.personal-information.reminders`)
- `Info.plist` is missing `NSCalendarsFullAccessUsageDescription` or `NSRemindersFullAccessUsageDescription` (required on macOS 14+)

**Recovery:**

1. Reset the stale TCC entry:
   ```
   tccutil reset Calendar pl.speedwave.desktop
   tccutil reset Reminders pl.speedwave.desktop
   ```
2. Reinstall Speedwave from a fresh download at [speedwave.pl](https://speedwave.pl)
3. Click the Calendar or Reminders toggle again — the system consent dialog should appear

## Calendar / Reminders previously denied

**Symptom:** Enabling the Calendar or Reminders integration shows a toast like:

> Calendar access was previously denied. Open Terminal and run:
> tccutil reset Calendar pl.speedwave.desktop
> Then click the toggle again.

**Cause:** The user previously clicked "Don't Allow" in the TCC consent dialog. Apple removed the `+` button from System Settings → Privacy & Security → Calendars on macOS 14+, so there is no UI path to re-add Speedwave. The `tccutil reset` command is the only recovery path.

**Recovery:**

1. Open Terminal
2. Run the exact command shown in the toast. For Calendar:
   ```
   tccutil reset Calendar pl.speedwave.desktop
   ```
   For Reminders:
   ```
   tccutil reset Reminders pl.speedwave.desktop
   ```
3. Click the toggle again — the consent dialog will reappear

## Contributor verification (macOS)

When contributing changes to Calendar/Reminders signing or entitlements, run:

```bash
# Validate Info.plist and entitlements plists
make test-desktop-build

# Validate Swift logic (macOS only)
make test-swift
```

See also: `docs/contributing/release-signing.md` for the full Path A / Path B / Path C verification procedures.
