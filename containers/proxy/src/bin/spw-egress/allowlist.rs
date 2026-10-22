use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;

use crate::host::{normalize_hostname, parse_port};

const CONFIG_VERSION: u32 = 1;
const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_ENTRIES: usize = 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    version: u32,
    allow: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum HostPattern {
    Exact(String),
    Subdomains(String),
}

#[derive(Debug, PartialEq, Eq)]
struct Entry {
    host: HostPattern,
    port: u16,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Allowlist {
    entries: Vec<Entry>,
}

impl Allowlist {
    pub(crate) fn allows(&self, host: &str, port: u16) -> bool {
        self.entries.iter().any(|entry| {
            entry.port == port
                && match &entry.host {
                    HostPattern::Exact(exact) => exact == host,
                    HostPattern::Subdomains(suffix) => host
                        .strip_suffix(suffix.as_str())
                        .and_then(|prefix| prefix.strip_suffix('.'))
                        .is_some_and(|prefix| !prefix.is_empty()),
                }
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ConfigError {
    Unreadable,
    TooLarge,
    Json,
    Version,
    TooManyEntries,
    Entry(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable => write!(f, "config file is missing or unreadable"),
            Self::TooLarge => write!(f, "config file exceeds {MAX_CONFIG_BYTES} bytes"),
            Self::Json => write!(f, "config file is not valid egress JSON"),
            Self::Version => write!(f, "config version is not {CONFIG_VERSION}"),
            Self::TooManyEntries => write!(f, "config lists more than {MAX_ENTRIES} entries"),
            Self::Entry(entry) => write!(f, "config entry {entry:?} is not host:port"),
        }
    }
}

fn parse_entry(raw: &str) -> Result<Entry, ConfigError> {
    let invalid = || ConfigError::Entry(raw.chars().take(300).collect());
    let (host, port) = raw.rsplit_once(':').ok_or_else(invalid)?;
    let port = parse_port(port).ok_or_else(invalid)?;
    let host = match host.strip_prefix("*.") {
        Some(suffix) => {
            let suffix = normalize_hostname(suffix).map_err(|_| invalid())?;
            if !suffix.contains('.') {
                return Err(invalid());
            }
            HostPattern::Subdomains(suffix)
        }
        None => HostPattern::Exact(normalize_hostname(host).map_err(|_| invalid())?),
    };
    Ok(Entry { host, port })
}

pub(crate) fn parse_config(bytes: &[u8]) -> Result<Allowlist, ConfigError> {
    let raw: RawConfig = serde_json::from_slice(bytes).map_err(|_| ConfigError::Json)?;
    if raw.version != CONFIG_VERSION {
        return Err(ConfigError::Version);
    }
    if raw.allow.len() > MAX_ENTRIES {
        return Err(ConfigError::TooManyEntries);
    }
    let entries = raw
        .allow
        .iter()
        .map(|entry| parse_entry(entry))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Allowlist { entries })
}

fn read_config(path: &std::path::Path) -> Result<Allowlist, ConfigError> {
    let file = std::fs::File::open(path).map_err(|_| ConfigError::Unreadable)?;
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ConfigError::Unreadable)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(ConfigError::TooLarge);
    }
    parse_config(&bytes)
}

pub(crate) struct ConfigStore {
    path: PathBuf,
    last_good: Mutex<Option<Arc<Allowlist>>>,
}

impl ConfigStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            last_good: Mutex::new(None),
        }
    }

    pub(crate) fn current(&self) -> Option<Arc<Allowlist>> {
        let mut last_good = self
            .last_good
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match read_config(&self.path) {
            Ok(allowlist) => {
                let allowlist = Arc::new(allowlist);
                *last_good = Some(Arc::clone(&allowlist));
                Some(allowlist)
            }
            Err(e) => {
                log::warn!(
                    "egress config {} rejected, keeping the last good allowlist: {e}",
                    self.path.display()
                );
                last_good.clone()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test fixture setup, failure aborts the test"
    )]
    use super::*;

    fn allowlist(entries: &[&str]) -> Allowlist {
        let json = serde_json::json!({ "version": 1, "allow": entries });
        parse_config(json.to_string().as_bytes()).unwrap()
    }

    #[test]
    fn exact_entry_matches_only_its_host_and_port() {
        let list = allowlist(&["api.figma.com:443"]);
        assert!(list.allows("api.figma.com", 443));
        assert!(!list.allows("api.figma.com", 80));
        assert!(!list.allows("figma.com", 443));
        assert!(!list.allows("evil.api.figma.com", 443));
        assert!(!list.allows("api.figma.com.evil.net", 443));
    }

    #[test]
    fn wildcard_matches_one_or_more_labels_but_never_the_apex() {
        let list = allowlist(&["*.figma.com:443"]);
        assert!(list.allows("api.figma.com", 443));
        assert!(list.allows("a.b.figma.com", 443));
        assert!(!list.allows("figma.com", 443));
        assert!(!list.allows("notfigma.com", 443));
        assert!(!list.allows("api.figma.com", 8443));
    }

    #[test]
    fn entries_are_normalized_to_lowercase() {
        let list = allowlist(&["API.Figma.COM:443", "*.Example.ORG:443"]);
        assert!(list.allows("api.figma.com", 443));
        assert!(list.allows("www.example.org", 443));
    }

    #[test]
    fn empty_allowlist_allows_nothing() {
        assert!(!allowlist(&[]).allows("api.figma.com", 443));
    }

    #[test]
    fn invalid_entries_reject_the_whole_config() {
        for entry in [
            "api.figma.com",
            "api.figma.com:0",
            "api.figma.com:99999",
            "10.0.0.1:443",
            "[::1]:443",
            "127.1:443",
            "*.com:443",
            "a.*.com:443",
            "*figma.com:443",
            "**.figma.com:443",
            "*.:443",
            ":443",
            "bad host.com:443",
        ] {
            let json = serde_json::json!({ "version": 1, "allow": [entry] });
            assert!(
                matches!(
                    parse_config(json.to_string().as_bytes()),
                    Err(ConfigError::Entry(_))
                ),
                "{entry}"
            );
        }
    }

    #[test]
    fn wrong_version_unknown_fields_and_bad_json_are_rejected() {
        assert_eq!(
            parse_config(br#"{"version":2,"allow":[]}"#),
            Err(ConfigError::Version)
        );
        assert_eq!(
            parse_config(br#"{"version":1,"allow":[],"extra":true}"#),
            Err(ConfigError::Json)
        );
        assert_eq!(parse_config(br#"{"allow":[]}"#), Err(ConfigError::Json));
        assert_eq!(parse_config(b"not json"), Err(ConfigError::Json));
        assert_eq!(parse_config(b""), Err(ConfigError::Json));
    }

    #[test]
    fn too_many_entries_are_rejected() {
        let entries: Vec<String> = (0..=MAX_ENTRIES).map(|i| format!("h{i}.com:443")).collect();
        let json = serde_json::json!({ "version": 1, "allow": entries });
        assert_eq!(
            parse_config(json.to_string().as_bytes()),
            Err(ConfigError::TooManyEntries)
        );
    }

    #[test]
    fn store_denies_everything_until_a_first_load_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("egress.json");
        let store = ConfigStore::new(path.clone());
        assert!(store.current().is_none());
        std::fs::write(&path, "{broken").unwrap();
        assert!(store.current().is_none());
    }

    #[test]
    fn store_picks_up_a_change_without_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("egress.json");
        std::fs::write(&path, r#"{"version":1,"allow":[]}"#).unwrap();
        let store = ConfigStore::new(path.clone());
        assert!(!store.current().unwrap().allows("api.figma.com", 443));
        std::fs::write(&path, r#"{"version":1,"allow":["api.figma.com:443"]}"#).unwrap();
        assert!(store.current().unwrap().allows("api.figma.com", 443));
        std::fs::write(&path, r#"{"version":1,"allow":[]}"#).unwrap();
        assert!(!store.current().unwrap().allows("api.figma.com", 443));
    }

    #[test]
    fn store_keeps_the_last_good_copy_on_invalid_or_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("egress.json");
        std::fs::write(&path, r#"{"version":1,"allow":["api.figma.com:443"]}"#).unwrap();
        let store = ConfigStore::new(path.clone());
        assert!(store.current().unwrap().allows("api.figma.com", 443));
        std::fs::write(&path, r#"{"version":1,"allow":["#).unwrap();
        assert!(store.current().unwrap().allows("api.figma.com", 443));
        std::fs::remove_file(&path).unwrap();
        assert!(store.current().unwrap().allows("api.figma.com", 443));
    }

    #[test]
    fn store_rejects_an_oversized_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("egress.json");
        let padding = " ".repeat(usize::try_from(MAX_CONFIG_BYTES).unwrap());
        std::fs::write(&path, format!(r#"{{"version":1,"allow":[]}}{padding}"#)).unwrap();
        assert_eq!(read_config(&path), Err(ConfigError::TooLarge));
        assert!(ConfigStore::new(path).current().is_none());
    }
}
