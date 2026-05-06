//! Host timezone detection: returns an IANA name for the `TZ` env var injected into every container service.

use std::path::Path;

/// Returns the host IANA timezone name (e.g. `"Europe/Warsaw"`); warns and returns `"Etc/UTC"` on failure.
pub fn detect_host_timezone() -> String {
    let detected = detect_platform();
    match detected {
        Some(tz) => tz,
        None => {
            log::warn!(
                "host timezone detection failed; defaulting to Etc/UTC. \
                 Container clocks (and Claude Code limit timestamps) will be in UTC."
            );
            "Etc/UTC".to_string()
        }
    }
}

#[cfg(unix)]
fn detect_platform() -> Option<String> {
    let env = std::env::var("TZ").ok();
    detect_unix(Path::new("/etc/localtime"), env.as_deref())
}

#[cfg(target_os = "windows")]
fn detect_platform() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    // 5 s deadline; slow PowerShell startup (cold boot, AV scan) must not stall caller.
    let timeout = Duration::from_secs(5);
    let mut child = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-TimeZone).Id",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let start = Instant::now();
    loop {
        match child.try_wait().ok()? {
            Some(status) if status.success() => break,
            Some(_) => return None,
            None => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    log::warn!("Get-TimeZone timed out after {}s", timeout.as_secs());
                    return None;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }

    // Output ~30 bytes (single zone ID line); no pipe-buffer deadlock risk.
    let mut buf = String::new();
    child.stdout.as_mut()?.read_to_string(&mut buf).ok()?;
    detect_windows(buf.trim())
}

/// Extracts IANA name from `/etc/localtime` symlink; falls back to validated `$TZ` env value.
#[cfg(unix)]
pub(crate) fn detect_unix(localtime_path: &Path, tz_env: Option<&str>) -> Option<String> {
    if let Ok(target) = std::fs::read_link(localtime_path) {
        if let Some(zone) = extract_zoneinfo_suffix(&target) {
            return Some(zone);
        }
    }

    tz_env.and_then(|raw| {
        let trimmed = raw.trim();
        if is_valid_iana_name(trimmed) {
            Some(trimmed.to_string())
        } else {
            None
        }
    })
}

/// Maps a Windows timezone ID (as returned by `Get-TimeZone -Id`) to IANA.
#[cfg(target_os = "windows")]
pub(crate) fn detect_windows(windows_tz_id: &str) -> Option<String> {
    windows_to_iana(windows_tz_id).map(|s| s.to_string())
}

/// Returns IANA name for the given Windows timezone ID, or `None` if unmapped.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn windows_to_iana(id: &str) -> Option<&'static str> {
    WINDOWS_TO_IANA
        .iter()
        .find_map(|(win, iana)| if *win == id { Some(*iana) } else { None })
}

/// Extracts IANA name from a `zoneinfo/...` symlink target (Linux + macOS layouts).
fn extract_zoneinfo_suffix(target: &Path) -> Option<String> {
    let s = target.to_str()?;
    let needle = "zoneinfo/";
    let idx = s.rfind(needle)?;
    let suffix = &s[idx + needle.len()..];
    if is_valid_iana_name(suffix) {
        Some(suffix.to_string())
    } else {
        None
    }
}

/// IANA-shape validator: 1–3 segments of `[A-Za-z0-9_+-]`; rejects empty, leading-colon, traversal, absolute.
fn is_valid_iana_name(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let segments: Vec<&str> = s.split('/').collect();
    if segments.len() > 3 {
        return false;
    }
    segments.iter().all(|seg| {
        !seg.is_empty()
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '+' || c == '-')
    })
}

/// Windows zone ID → IANA map (CLDR windowsZones.xml territory 001; ~140 entries, linear scan is fine).
#[cfg(any(target_os = "windows", test))]
const WINDOWS_TO_IANA: &[(&str, &str)] = &[
    ("Dateline Standard Time", "Etc/GMT+12"),
    ("UTC-11", "Etc/GMT+11"),
    ("Aleutian Standard Time", "America/Adak"),
    ("Hawaiian Standard Time", "Pacific/Honolulu"),
    ("Marquesas Standard Time", "Pacific/Marquesas"),
    ("Alaskan Standard Time", "America/Anchorage"),
    ("UTC-09", "Etc/GMT+9"),
    ("Pacific Standard Time (Mexico)", "America/Tijuana"),
    ("UTC-08", "Etc/GMT+8"),
    ("Pacific Standard Time", "America/Los_Angeles"),
    ("US Mountain Standard Time", "America/Phoenix"),
    ("Mountain Standard Time (Mexico)", "America/Mazatlan"),
    ("Mountain Standard Time", "America/Denver"),
    ("Yukon Standard Time", "America/Whitehorse"),
    ("Central America Standard Time", "America/Guatemala"),
    ("Central Standard Time", "America/Chicago"),
    ("Easter Island Standard Time", "Pacific/Easter"),
    ("Central Standard Time (Mexico)", "America/Mexico_City"),
    ("Canada Central Standard Time", "America/Regina"),
    ("SA Pacific Standard Time", "America/Bogota"),
    ("Eastern Standard Time (Mexico)", "America/Cancun"),
    ("Eastern Standard Time", "America/New_York"),
    ("Haiti Standard Time", "America/Port-au-Prince"),
    ("Cuba Standard Time", "America/Havana"),
    ("US Eastern Standard Time", "America/Indianapolis"),
    ("Turks And Caicos Standard Time", "America/Grand_Turk"),
    ("Paraguay Standard Time", "America/Asuncion"),
    ("Atlantic Standard Time", "America/Halifax"),
    ("Venezuela Standard Time", "America/Caracas"),
    ("Central Brazilian Standard Time", "America/Cuiaba"),
    ("SA Western Standard Time", "America/La_Paz"),
    ("Pacific SA Standard Time", "America/Santiago"),
    ("Newfoundland Standard Time", "America/St_Johns"),
    ("Tocantins Standard Time", "America/Araguaina"),
    ("E. South America Standard Time", "America/Sao_Paulo"),
    ("SA Eastern Standard Time", "America/Cayenne"),
    ("Argentina Standard Time", "America/Argentina/Buenos_Aires"),
    ("Greenland Standard Time", "America/Nuuk"),
    ("Montevideo Standard Time", "America/Montevideo"),
    ("Magallanes Standard Time", "America/Punta_Arenas"),
    ("Saint Pierre Standard Time", "America/Miquelon"),
    ("Bahia Standard Time", "America/Bahia"),
    ("UTC-02", "Etc/GMT+2"),
    ("Azores Standard Time", "Atlantic/Azores"),
    ("Cape Verde Standard Time", "Atlantic/Cape_Verde"),
    ("UTC", "Etc/UTC"),
    ("GMT Standard Time", "Europe/London"),
    ("Greenwich Standard Time", "Atlantic/Reykjavik"),
    ("Sao Tome Standard Time", "Africa/Sao_Tome"),
    ("Morocco Standard Time", "Africa/Casablanca"),
    ("W. Europe Standard Time", "Europe/Berlin"),
    ("Central Europe Standard Time", "Europe/Budapest"),
    ("Romance Standard Time", "Europe/Paris"),
    ("Central European Standard Time", "Europe/Warsaw"),
    ("W. Central Africa Standard Time", "Africa/Lagos"),
    ("GTB Standard Time", "Europe/Bucharest"),
    ("Middle East Standard Time", "Asia/Beirut"),
    ("Egypt Standard Time", "Africa/Cairo"),
    ("E. Europe Standard Time", "Europe/Chisinau"),
    ("Syria Standard Time", "Asia/Damascus"),
    ("West Bank Standard Time", "Asia/Hebron"),
    ("South Africa Standard Time", "Africa/Johannesburg"),
    ("FLE Standard Time", "Europe/Kyiv"),
    ("Israel Standard Time", "Asia/Jerusalem"),
    ("South Sudan Standard Time", "Africa/Juba"),
    ("Kaliningrad Standard Time", "Europe/Kaliningrad"),
    ("Sudan Standard Time", "Africa/Khartoum"),
    ("Libya Standard Time", "Africa/Tripoli"),
    ("Namibia Standard Time", "Africa/Windhoek"),
    ("Jordan Standard Time", "Asia/Amman"),
    ("Arabic Standard Time", "Asia/Baghdad"),
    ("Turkey Standard Time", "Europe/Istanbul"),
    ("Arab Standard Time", "Asia/Riyadh"),
    ("Belarus Standard Time", "Europe/Minsk"),
    ("Russian Standard Time", "Europe/Moscow"),
    ("E. Africa Standard Time", "Africa/Nairobi"),
    ("Volgograd Standard Time", "Europe/Volgograd"),
    ("Iran Standard Time", "Asia/Tehran"),
    ("Arabian Standard Time", "Asia/Dubai"),
    ("Astrakhan Standard Time", "Europe/Astrakhan"),
    ("Azerbaijan Standard Time", "Asia/Baku"),
    ("Russia Time Zone 3", "Europe/Samara"),
    ("Mauritius Standard Time", "Indian/Mauritius"),
    ("Saratov Standard Time", "Europe/Saratov"),
    ("Georgian Standard Time", "Asia/Tbilisi"),
    ("Caucasus Standard Time", "Asia/Yerevan"),
    ("Afghanistan Standard Time", "Asia/Kabul"),
    ("West Asia Standard Time", "Asia/Tashkent"),
    ("Qyzylorda Standard Time", "Asia/Qyzylorda"),
    ("Ekaterinburg Standard Time", "Asia/Yekaterinburg"),
    ("Pakistan Standard Time", "Asia/Karachi"),
    ("India Standard Time", "Asia/Kolkata"),
    ("Sri Lanka Standard Time", "Asia/Colombo"),
    ("Nepal Standard Time", "Asia/Kathmandu"),
    ("Central Asia Standard Time", "Asia/Bishkek"),
    ("Bangladesh Standard Time", "Asia/Dhaka"),
    ("Omsk Standard Time", "Asia/Omsk"),
    ("Myanmar Standard Time", "Asia/Yangon"),
    ("SE Asia Standard Time", "Asia/Bangkok"),
    ("Altai Standard Time", "Asia/Barnaul"),
    ("W. Mongolia Standard Time", "Asia/Hovd"),
    ("North Asia Standard Time", "Asia/Krasnoyarsk"),
    ("N. Central Asia Standard Time", "Asia/Novosibirsk"),
    ("Tomsk Standard Time", "Asia/Tomsk"),
    ("China Standard Time", "Asia/Shanghai"),
    ("North Asia East Standard Time", "Asia/Irkutsk"),
    ("Singapore Standard Time", "Asia/Singapore"),
    ("W. Australia Standard Time", "Australia/Perth"),
    ("Taipei Standard Time", "Asia/Taipei"),
    ("Ulaanbaatar Standard Time", "Asia/Ulaanbaatar"),
    ("Aus Central W. Standard Time", "Australia/Eucla"),
    ("Transbaikal Standard Time", "Asia/Chita"),
    ("Tokyo Standard Time", "Asia/Tokyo"),
    ("North Korea Standard Time", "Asia/Pyongyang"),
    ("Korea Standard Time", "Asia/Seoul"),
    ("Yakutsk Standard Time", "Asia/Yakutsk"),
    ("Cen. Australia Standard Time", "Australia/Adelaide"),
    ("AUS Central Standard Time", "Australia/Darwin"),
    ("E. Australia Standard Time", "Australia/Brisbane"),
    ("AUS Eastern Standard Time", "Australia/Sydney"),
    ("West Pacific Standard Time", "Pacific/Port_Moresby"),
    ("Tasmania Standard Time", "Australia/Hobart"),
    ("Vladivostok Standard Time", "Asia/Vladivostok"),
    ("Lord Howe Standard Time", "Australia/Lord_Howe"),
    ("Bougainville Standard Time", "Pacific/Bougainville"),
    ("Russia Time Zone 10", "Asia/Srednekolymsk"),
    ("Magadan Standard Time", "Asia/Magadan"),
    ("Norfolk Standard Time", "Pacific/Norfolk"),
    ("Sakhalin Standard Time", "Asia/Sakhalin"),
    ("Central Pacific Standard Time", "Pacific/Guadalcanal"),
    ("Russia Time Zone 11", "Asia/Kamchatka"),
    ("New Zealand Standard Time", "Pacific/Auckland"),
    ("UTC+12", "Etc/GMT-12"),
    ("Fiji Standard Time", "Pacific/Fiji"),
    ("Chatham Islands Standard Time", "Pacific/Chatham"),
    ("UTC+13", "Etc/GMT-13"),
    ("Tonga Standard Time", "Pacific/Tongatapu"),
    ("Samoa Standard Time", "Pacific/Apia"),
    ("Line Islands Standard Time", "Pacific/Kiritimati"),
];

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn iana(s: &str) -> Option<String> {
        Some(s.to_string())
    }

    #[test]
    fn extract_zoneinfo_suffix_linux() {
        let p = Path::new("/usr/share/zoneinfo/America/New_York");
        assert_eq!(extract_zoneinfo_suffix(p), iana("America/New_York"));
    }

    #[test]
    fn extract_zoneinfo_suffix_macos() {
        let p = Path::new("/var/db/timezone/zoneinfo/Europe/Warsaw");
        assert_eq!(extract_zoneinfo_suffix(p), iana("Europe/Warsaw"));
    }

    #[test]
    fn extract_zoneinfo_suffix_three_segments() {
        let p = Path::new("/usr/share/zoneinfo/America/Argentina/Buenos_Aires");
        assert_eq!(
            extract_zoneinfo_suffix(p),
            iana("America/Argentina/Buenos_Aires")
        );
    }

    #[test]
    fn extract_zoneinfo_suffix_no_zoneinfo_marker() {
        let p = Path::new("/etc/localtime");
        assert_eq!(extract_zoneinfo_suffix(p), None);
    }

    #[test]
    fn is_valid_iana_name_accepts_typical_zones() {
        assert!(is_valid_iana_name("Europe/Warsaw"));
        assert!(is_valid_iana_name("America/Argentina/Buenos_Aires"));
        assert!(is_valid_iana_name("UTC"));
        assert!(is_valid_iana_name("Etc/GMT+12"));
        assert!(is_valid_iana_name("Etc/GMT-9"));
    }

    #[test]
    fn is_valid_iana_name_rejects_malformed() {
        assert!(!is_valid_iana_name(""));
        assert!(!is_valid_iana_name(":Europe/Warsaw"));
        assert!(!is_valid_iana_name("../etc/passwd"));
        assert!(!is_valid_iana_name("/Europe/Warsaw"));
        assert!(!is_valid_iana_name("Europe/Warsaw/extra/segments"));
        assert!(!is_valid_iana_name("Europe//Warsaw"));
        assert!(!is_valid_iana_name("Europe Warsaw"));
        assert!(!is_valid_iana_name("Europe/Warsaw\n"));
    }

    #[cfg(unix)]
    #[test]
    fn detect_unix_reads_symlink_to_zoneinfo() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("localtime");
        symlink("/usr/share/zoneinfo/Europe/Warsaw", &link).unwrap();
        assert_eq!(detect_unix(&link, None), iana("Europe/Warsaw"));
    }

    #[cfg(unix)]
    #[test]
    fn detect_unix_reads_macos_style_symlink() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("localtime");
        symlink("/var/db/timezone/zoneinfo/America/New_York", &link).unwrap();
        assert_eq!(detect_unix(&link, None), iana("America/New_York"));
    }

    #[cfg(unix)]
    #[test]
    fn detect_unix_falls_back_to_tz_env() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert_eq!(
            detect_unix(&missing, Some("Europe/Berlin")),
            iana("Europe/Berlin")
        );
    }

    #[cfg(unix)]
    #[test]
    fn detect_unix_rejects_malformed_tz_env() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert_eq!(detect_unix(&missing, Some(":Europe/Warsaw")), None);
        assert_eq!(detect_unix(&missing, Some("../etc/passwd")), None);
        assert_eq!(detect_unix(&missing, Some("")), None);
        assert_eq!(detect_unix(&missing, Some("   ")), None);
    }

    #[cfg(unix)]
    #[test]
    fn detect_unix_returns_none_with_no_signals() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert_eq!(detect_unix(&missing, None), None);
    }

    #[cfg(unix)]
    #[test]
    fn detect_unix_handles_non_symlink_regular_file_fallback_to_env() {
        let dir = tempfile::tempdir().unwrap();
        let regular = dir.path().join("localtime");
        std::fs::write(&regular, b"binary tzdata").unwrap();
        // read_link on a regular file errors -> fall back to env
        assert_eq!(
            detect_unix(&regular, Some("Asia/Tokyo")),
            iana("Asia/Tokyo")
        );
    }

    #[cfg(unix)]
    #[test]
    fn detect_unix_symlink_to_unrelated_path_falls_back_to_env() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("localtime");
        symlink("/some/other/path", &link).unwrap();
        assert_eq!(detect_unix(&link, Some("Asia/Tokyo")), iana("Asia/Tokyo"));
    }

    #[test]
    fn windows_to_iana_known_zones() {
        assert_eq!(
            windows_to_iana("Central European Standard Time"),
            Some("Europe/Warsaw")
        );
        assert_eq!(
            windows_to_iana("Pacific Standard Time"),
            Some("America/Los_Angeles")
        );
        assert_eq!(windows_to_iana("UTC"), Some("Etc/UTC"));
        assert_eq!(windows_to_iana("Tokyo Standard Time"), Some("Asia/Tokyo"));
    }

    #[test]
    fn windows_to_iana_unknown_returns_none() {
        assert_eq!(windows_to_iana("Bogus Zone"), None);
        assert_eq!(windows_to_iana(""), None);
    }

    #[test]
    fn detect_host_timezone_never_panics() {
        // Smoke test: must always return a non-empty string, on any platform,
        // regardless of host configuration.
        let tz = detect_host_timezone();
        assert!(!tz.is_empty());
    }
}
