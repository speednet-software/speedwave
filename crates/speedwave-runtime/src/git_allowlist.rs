//! Repository allowlist of the git transport.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const GITHUB_GIT_HOST: &str = "github.com";
const GITLAB_DEFAULT_HOST_URL: &str = "https://gitlab.com";
const GITLAB_COM_GIT_HOST: &str = "gitlab.com";

const SKIPPED_DIRS: [&str; 9] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    ".venv",
    "venv",
    ".cache",
];

const NESTED_SCAN_DEPTH: usize = 2;

const GIT_CONFIG_MAX_BYTES: u64 = 1024 * 1024;

/// Integration whose token the proxy holds for the git transport.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitForgeService {
    /// GitHub.com.
    Github,
    /// GitLab (gitlab.com or a self-managed host).
    Gitlab,
}

impl GitForgeService {
    pub(crate) const ALL: [GitForgeService; 2] = [GitForgeService::Github, GitForgeService::Gitlab];

    /// Service for an integration config key (`"github"`, `"gitlab"`).
    pub fn from_config_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.config_key() == key)
    }

    pub(crate) fn config_key(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Gitlab => "gitlab",
        }
    }
}

/// Why an allowlist entry was rejected; the `Display` text is shown to the user.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitEntryError {
    /// The entry is blank.
    Empty,
    /// The entry would cover a whole host.
    WholeHost,
    /// A `*` stands anywhere but as the whole last part.
    MisplacedWildcard,
    /// The entry has fewer than two parts.
    TooFewSegments,
    /// A part is empty, `.` or `..`.
    BadSegment,
    /// The entry holds whitespace, a control character, `%` or a backslash.
    ForbiddenCharacter,
    /// A URL or `host/...` form names another host than the integration's.
    OtherHost,
    /// A URL uses a scheme other than https or ssh.
    UnsupportedScheme,
}

impl fmt::Display for GitEntryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Empty => "The entry is empty.",
            Self::WholeHost => {
                "An entry cannot cover a whole host. Name a repository (owner/repo) or an owner (owner/*)."
            }
            Self::MisplacedWildcard => "A * is allowed only as the whole last part, as in owner/*.",
            Self::TooFewSegments => {
                "The entry needs at least an owner and a repository, as in owner/repo."
            }
            Self::BadSegment => "The entry has an empty part, or a part that is . or ..",
            Self::ForbiddenCharacter => {
                "The entry contains whitespace, a control character, % or a backslash."
            }
            Self::OtherHost => "The entry names another host than this integration uses.",
            Self::UnsupportedScheme => "Only https:// and ssh:// clone URLs are supported.",
        })
    }
}

impl std::error::Error for GitEntryError {}

/// A repository found in the project directory that the user may add to the allowlist.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitRepositorySuggestion {
    /// Normalised allowlist entry (`owner/repo`).
    pub entry: String,
    /// Directory of the repository relative to the project directory, `.` for its root.
    pub source_dir: String,
}

/// Git host of a forge for one project.
pub fn forge_host_in(data_dir: &Path, project: &str, service: GitForgeService) -> Option<String> {
    match service {
        GitForgeService::Github => Some(GITHUB_GIT_HOST.to_string()),
        GitForgeService::Gitlab => gitlab_host_in(data_dir, project),
    }
}

/// Normal form of an allowlist entry for the forge at `host`, or why it is refused.
pub fn normalise_entry(raw: &str, host: &str) -> Result<String, GitEntryError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(GitEntryError::Empty);
    }
    if raw
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '%' || c == '\\')
    {
        return Err(GitEntryError::ForbiddenCharacter);
    }
    normalise_path(path_on_host(raw, host)?)
}

/// Entries the proxy enforces, and the indices of stored entries that do not validate.
pub fn enforced_entries(entries: &[String], host: &str) -> (Vec<String>, Vec<usize>) {
    let mut enforced = BTreeSet::new();
    let mut rejected = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        match normalise_entry(entry, host) {
            Ok(normalised) => {
                enforced.insert(normalised);
            }
            Err(_) => rejected.push(index),
        }
    }
    (enforced.into_iter().collect(), rejected)
}

/// Repositories the project's git remotes name on the forge at `host`.
pub fn suggestions_in(
    project_dir: &Path,
    host: &str,
    listed: &[String],
) -> Vec<GitRepositorySuggestion> {
    let mut found: BTreeMap<String, String> = BTreeMap::new();
    for dir in repository_candidates(project_dir) {
        for url in remote_urls_in(project_dir, &dir) {
            match remote_entry(&url, host) {
                Some(entry) => {
                    found
                        .entry(entry)
                        .or_insert_with(|| source_dir_of(project_dir, &dir));
                }
                None => log::debug!(
                    "a remote of a repository in the project is not a repository on this forge"
                ),
            }
        }
    }
    found
        .into_iter()
        .filter(|(entry, _)| !listed.contains(entry))
        .map(|(entry, source_dir)| GitRepositorySuggestion { entry, source_dir })
        .collect()
}

fn gitlab_host_in(data_dir: &Path, project: &str) -> Option<String> {
    let host_url_path = crate::compose::resolve_tokens_dir_in(data_dir, project)
        .join(GitForgeService::Gitlab.config_key())
        .join("host_url");
    let host_url = match std::fs::read_to_string(&host_url_path) {
        Ok(raw) if raw.trim().is_empty() => GITLAB_DEFAULT_HOST_URL.to_string(),
        Ok(raw) => raw.trim().to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => GITLAB_DEFAULT_HOST_URL.to_string(),
        Err(e) => {
            log::warn!("could not read gitlab host_url, git transport skipped: {e}");
            return None;
        }
    };
    let host = gitlab_git_host(&host_url);
    if host.is_none() {
        log::warn!("gitlab host_url is not an https URL with a plain host: git transport skipped");
    }
    host
}

fn gitlab_git_host(host_url: &str) -> Option<String> {
    let url = url::Url::parse(host_url.trim()).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

fn path_on_host<'a>(raw: &'a str, host: &str) -> Result<&'a str, GitEntryError> {
    if let Some((scheme, _)) = raw.split_once("://") {
        if !scheme.eq_ignore_ascii_case("https") && !scheme.eq_ignore_ascii_case("ssh") {
            return Err(GitEntryError::UnsupportedScheme);
        }
    }
    match split_host(raw, host) {
        Some((authority, path)) => on_host(authority, host)
            .then_some(path)
            .ok_or(GitEntryError::OtherHost),
        None => Ok(raw),
    }
}

fn split_host<'a>(raw: &'a str, host: &str) -> Option<(&'a str, &'a str)> {
    if let Some((_, rest)) = raw.split_once("://") {
        return Some(rest.split_once('/').unwrap_or((rest, "")));
    }
    if let Some(scp_like) = raw
        .split_once(':')
        .filter(|(before, after)| !before.contains('/') && !starts_with_port(after))
    {
        return Some(scp_like);
    }
    raw.split_once('/')
        .filter(|(first, _)| names_a_host(first, host))
}

fn starts_with_port(after_colon: &str) -> bool {
    after_colon
        .split('/')
        .next()
        .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

fn names_a_host(first: &str, host: &str) -> bool {
    let github_owner_cannot_hold_a_dot =
        host_without_port(host).eq_ignore_ascii_case(GITHUB_GIT_HOST) && first.contains('.');
    let public_forge = on_host(first, GITHUB_GIT_HOST) || on_host(first, GITLAB_COM_GIT_HOST);
    first.contains([':', '@'])
        || on_host(first, host)
        || public_forge
        || github_owner_cannot_hold_a_dot
}

fn on_host(authority: &str, host: &str) -> bool {
    let candidate = host_without_port(strip_userinfo(authority));
    !candidate.is_empty() && candidate.eq_ignore_ascii_case(host_without_port(host))
}

fn strip_userinfo(authority: &str) -> &str {
    authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
}

fn host_without_port(authority: &str) -> &str {
    if authority.starts_with('[') {
        return authority.split_inclusive(']').next().unwrap_or(authority);
    }
    authority.split(':').next().unwrap_or_default()
}

fn normalise_path(path: &str) -> Result<String, GitEntryError> {
    let lowered = path.trim_matches('/').to_ascii_lowercase();
    let entry = lowered.strip_suffix(".git").unwrap_or(&lowered);
    if entry == "*" {
        return Err(GitEntryError::WholeHost);
    }
    if entry.is_empty() {
        return Err(GitEntryError::TooFewSegments);
    }
    let segments: Vec<&str> = entry.split('/').collect();
    if segments
        .iter()
        .any(|s| s.is_empty() || *s == "." || *s == "..")
    {
        return Err(GitEntryError::BadSegment);
    }
    let last = segments.len() - 1;
    if segments
        .iter()
        .enumerate()
        .any(|(i, s)| s.contains('*') && !(i == last && *s == "*"))
    {
        return Err(GitEntryError::MisplacedWildcard);
    }
    if segments.len() < 2 {
        return Err(GitEntryError::TooFewSegments);
    }
    Ok(entry.to_string())
}

fn repository_candidates(project_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![project_dir.to_path_buf()];
    let mut frontier = vec![project_dir.to_path_buf()];
    for _ in 0..NESTED_SCAN_DEPTH {
        let mut next = Vec::new();
        for dir in &frontier {
            let entries = match std::fs::read_dir(dir) {
                Ok(entries) => entries,
                Err(e) => {
                    log::debug!("could not list {} for git repositories: {e}", dir.display());
                    continue;
                }
            };
            for entry in entries.flatten() {
                let name = entry.file_name();
                let skipped = name
                    .to_str()
                    .is_some_and(|n| SKIPPED_DIRS.iter().any(|s| s.eq_ignore_ascii_case(n)));
                let is_real_dir = entry.file_type().is_ok_and(|t| t.is_dir());
                if !skipped && is_real_dir {
                    next.push(entry.path());
                }
            }
        }
        next.sort();
        candidates.extend(next.iter().cloned());
        frontier = next;
    }
    candidates
}

fn remote_urls_in(project_dir: &Path, dir: &Path) -> Vec<String> {
    let Some(config) = git_config_of(project_dir, dir) else {
        return Vec::new();
    };
    match read_capped(&config) {
        Ok(text) => remote_urls_of(&text),
        Err(e) => {
            log::warn!(
                "could not read {}, so its remotes are not suggested: {e}",
                config.display()
            );
            Vec::new()
        }
    }
}

fn git_config_of(project_dir: &Path, dir: &Path) -> Option<PathBuf> {
    let dot_git = dir.join(".git");
    let meta = std::fs::symlink_metadata(&dot_git).ok()?;
    let config = if meta.is_dir() {
        dot_git.join("config")
    } else if meta.is_file() {
        let pointer = read_capped(&dot_git).ok()?;
        let gitdir = within_project(
            project_dir,
            &dir.join(pointer.trim().strip_prefix("gitdir:")?.trim()),
        )?;
        let commondir =
            within_project(project_dir, &gitdir.join("commondir")).filter(|p| p.is_file());
        let common = match commondir {
            Some(file) => {
                within_project(project_dir, &gitdir.join(read_capped(&file).ok()?.trim()))?
            }
            None => gitdir,
        };
        common.join("config")
    } else {
        return None;
    };
    let config = within_project(project_dir, &config).filter(|c| c.is_file());
    if config.is_none() {
        log::debug!(
            "the git config of {} is missing, not a regular file or outside the project directory, skipped",
            dir.display()
        );
    }
    config
}

fn read_capped(path: &Path) -> std::io::Result<String> {
    let mut text = String::new();
    std::fs::File::open(path)?
        .take(GIT_CONFIG_MAX_BYTES)
        .read_to_string(&mut text)?;
    Ok(text)
}

fn within_project(project_dir: &Path, path: &Path) -> Option<PathBuf> {
    let relative = lexical_relative(project_dir, path)?;
    let mut cursor = project_dir.to_path_buf();
    for component in relative.components() {
        cursor.push(component);
        let meta = std::fs::symlink_metadata(&cursor).ok()?;
        if meta.file_type().is_symlink() {
            return None;
        }
    }
    Some(cursor)
}

fn lexical_relative(root: &Path, path: &Path) -> Option<PathBuf> {
    let mut normalised = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalised.pop() {
                    return None;
                }
            }
            other => normalised.push(other),
        }
    }
    let relative = normalised.strip_prefix(root).ok()?;
    (!relative.as_os_str().is_empty()).then(|| relative.to_path_buf())
}

fn remote_urls_of(config: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut in_remote = false;
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_remote = line.starts_with("[remote ");
            continue;
        }
        if !in_remote {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        if key == "url" || key == "pushurl" {
            let value = value.trim();
            let value = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .unwrap_or(value);
            urls.push(value.to_string());
        }
    }
    urls
}

fn remote_entry(url: &str, host: &str) -> Option<String> {
    split_host(url.trim(), host)?;
    normalise_entry(url, host)
        .ok()
        .filter(|entry| !entry.ends_with("/*"))
}

fn source_dir_of(project_dir: &Path, dir: &Path) -> String {
    let parts: Vec<String> = dir
        .strip_prefix(project_dir)
        .map(|relative| {
            relative
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test fixture setup, failure aborts the test"
)]
mod tests {
    use super::*;

    const GITHUB: &str = "github.com";
    const GITLAB_CORP: &str = "gitlab.example.com:8443";

    fn write_repo(dir: &Path, urls: &[&str]) {
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let remotes: String = urls
            .iter()
            .enumerate()
            .map(|(i, u)| format!("[remote \"r{i}\"]\n\turl = {u}\n"))
            .collect();
        std::fs::write(dir.join(".git/config"), remotes).unwrap();
    }

    fn write_pointer(dir: &Path, gitdir: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(".git"), format!("gitdir: {gitdir}\n")).unwrap();
    }

    fn entries_on_github(project: &Path) -> Vec<String> {
        suggestions_in(project, GITHUB, &[])
            .into_iter()
            .map(|s| s.entry)
            .collect()
    }

    #[test]
    fn services_round_trip_through_their_config_key() {
        for service in GitForgeService::ALL {
            assert_eq!(
                GitForgeService::from_config_key(service.config_key()),
                Some(service)
            );
        }
        assert_eq!(GitForgeService::from_config_key("slack"), None);
        assert_eq!(GitForgeService::from_config_key("GitHub"), None);
        assert_eq!(GitForgeService::from_config_key(""), None);
    }

    fn gitlab_host_with(host_url: Option<&str>) -> (tempfile::TempDir, Option<String>) {
        let dir = tempfile::tempdir().unwrap();
        if let Some(host_url) = host_url {
            let gitlab = crate::compose::resolve_tokens_dir_in(dir.path(), "proj").join("gitlab");
            std::fs::create_dir_all(&gitlab).unwrap();
            std::fs::write(gitlab.join("host_url"), host_url).unwrap();
        }
        let host = forge_host_in(dir.path(), "proj", GitForgeService::Gitlab);
        (dir, host)
    }

    #[test]
    fn forge_host_of_github_is_fixed() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            forge_host_in(dir.path(), "proj", GitForgeService::Github),
            Some("github.com".to_string())
        );
    }

    #[test]
    fn forge_host_of_gitlab_defaults_when_host_url_is_missing_or_blank() {
        assert_eq!(gitlab_host_with(None).1.as_deref(), Some("gitlab.com"));
        assert_eq!(
            gitlab_host_with(Some("  \n")).1.as_deref(),
            Some("gitlab.com")
        );
    }

    #[test]
    fn forge_host_of_gitlab_keeps_the_port_and_drops_scheme_path_and_case() {
        assert_eq!(
            gitlab_host_with(Some("https://GitLab.Example.com:8443/sub/path?x=1#f\n"))
                .1
                .as_deref(),
            Some("gitlab.example.com:8443")
        );
    }

    #[test]
    fn forge_host_of_gitlab_is_none_unless_https_with_a_plain_host() {
        for bad in [
            "http://gitlab.example.com",
            "gitlab.example.com",
            "ssh://git@gitlab.example.com",
            "https://user:pw@gitlab.example.com",
            "https://",
        ] {
            assert_eq!(gitlab_host_with(Some(bad)).1, None, "'{bad}'");
        }
    }

    #[test]
    fn forge_host_of_gitlab_is_none_when_host_url_is_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let gitlab = crate::compose::resolve_tokens_dir_in(dir.path(), "proj").join("gitlab");
        std::fs::create_dir_all(gitlab.join("host_url")).unwrap();
        assert_eq!(
            forge_host_in(dir.path(), "proj", GitForgeService::Gitlab),
            None
        );
    }

    #[test]
    fn normalise_entry_accepts_every_supported_form() {
        for (raw, host, expected) in [
            ("owner/repo", GITHUB, "owner/repo"),
            ("Owner/Repo", GITHUB, "owner/repo"),
            ("  owner/repo\n", GITHUB, "owner/repo"),
            ("/owner/repo/", GITHUB, "owner/repo"),
            ("owner/repo.git", GITHUB, "owner/repo"),
            ("owner/*", GITHUB, "owner/*"),
            ("group/sub/repo", GITLAB_CORP, "group/sub/repo"),
            ("group/sub/*", GITLAB_CORP, "group/sub/*"),
            ("github.com/owner/repo", GITHUB, "owner/repo"),
            ("GitHub.com/Owner/*", GITHUB, "owner/*"),
            (
                "gitlab.example.com/group/sub/repo",
                GITLAB_CORP,
                "group/sub/repo",
            ),
            (
                "gitlab.example.com:8443/group/repo",
                GITLAB_CORP,
                "group/repo",
            ),
            (
                "https://github.com/Speednet-Software/Speedwave",
                GITHUB,
                "speednet-software/speedwave",
            ),
            ("https://github.com/owner/repo.git/", GITHUB, "owner/repo"),
            ("HTTPS://GitHub.com/owner/repo", GITHUB, "owner/repo"),
            (
                "https://user:secret@github.com/owner/repo.git",
                GITHUB,
                "owner/repo",
            ),
            (
                "https://gitlab.example.com:8443/group/sub/repo.git",
                GITLAB_CORP,
                "group/sub/repo",
            ),
            (
                "https://gitlab.example.com/group/repo",
                GITLAB_CORP,
                "group/repo",
            ),
            ("ssh://git@github.com/owner/repo.git", GITHUB, "owner/repo"),
            (
                "ssh://git@gitlab.example.com:2222/group/sub/repo.git",
                GITLAB_CORP,
                "group/sub/repo",
            ),
            ("git@github.com:owner/repo.git", GITHUB, "owner/repo"),
            ("git@github.com:owner/repo", GITHUB, "owner/repo"),
            (
                "git@gitlab.example.com:group/sub/repo.git",
                GITLAB_CORP,
                "group/sub/repo",
            ),
            ("https://github.com/owner/*", GITHUB, "owner/*"),
            ("github.com:owner/repo.git", GITHUB, "owner/repo"),
            ("my.group/sub/repo", GITLAB_CORP, "my.group/sub/repo"),
            (
                "gitlab.example.com/my.group/repo",
                GITLAB_CORP,
                "my.group/repo",
            ),
        ] {
            assert_eq!(
                normalise_entry(raw, host).as_deref(),
                Ok(expected),
                "{raw} on {host}"
            );
        }
    }

    #[test]
    fn normalise_entry_rejects_what_the_allowlist_cannot_hold() {
        for (raw, expected) in [
            ("", GitEntryError::Empty),
            ("   ", GitEntryError::Empty),
            ("*", GitEntryError::WholeHost),
            ("github.com/*", GitEntryError::WholeHost),
            ("https://github.com/*", GitEntryError::WholeHost),
            ("a/*/b", GitEntryError::MisplacedWildcard),
            ("*/repo", GitEntryError::MisplacedWildcard),
            ("owner/re*", GitEntryError::MisplacedWildcard),
            ("owner/*/*", GitEntryError::MisplacedWildcard),
            ("owner", GitEntryError::TooFewSegments),
            ("owner/", GitEntryError::TooFewSegments),
            ("https://github.com", GitEntryError::TooFewSegments),
            ("https://github.com/owner", GitEntryError::TooFewSegments),
            ("github.com/owner", GitEntryError::TooFewSegments),
            ("owner//repo", GitEntryError::BadSegment),
            ("owner/./repo", GitEntryError::BadSegment),
            ("owner/../repo", GitEntryError::BadSegment),
            (
                "https://github.com/owner/../repo",
                GitEntryError::BadSegment,
            ),
            ("owner/.git", GitEntryError::BadSegment),
            ("owner/%2e%2e", GitEntryError::ForbiddenCharacter),
            ("owner\\repo", GitEntryError::ForbiddenCharacter),
            ("C:\\Users\\me\\repo", GitEntryError::ForbiddenCharacter),
            ("owner/re po", GitEntryError::ForbiddenCharacter),
            ("owner/re\u{0}po", GitEntryError::ForbiddenCharacter),
            ("owner/re\tpo", GitEntryError::ForbiddenCharacter),
            ("https://gitlab.com/owner/repo", GitEntryError::OtherHost),
            ("gitlab.com/owner/repo", GitEntryError::OtherHost),
            ("git@gitlab.com:owner/repo.git", GitEntryError::OtherHost),
            (
                "ssh://git@gitlab.com/owner/repo.git",
                GitEntryError::OtherHost,
            ),
            ("codeberg.org/owner/repo", GitEntryError::OtherHost),
            ("https:///owner/repo", GitEntryError::OtherHost),
            (
                "http://github.com/owner/repo",
                GitEntryError::UnsupportedScheme,
            ),
            ("file:///home/me/repo.git", GitEntryError::UnsupportedScheme),
            (
                "git://github.com/owner/repo.git",
                GitEntryError::UnsupportedScheme,
            ),
        ] {
            assert_eq!(normalise_entry(raw, GITHUB), Err(expected), "{raw:?}");
        }
    }

    #[test]
    fn normalise_entry_reads_a_public_forge_host_as_a_host_on_every_panel() {
        for raw in [
            "github.com/*",
            "gitlab.com/group/repo",
            "GitHub.com/owner/repo",
        ] {
            assert_eq!(
                normalise_entry(raw, GITLAB_CORP),
                Err(GitEntryError::OtherHost),
                "{raw}"
            );
        }
        assert_eq!(
            normalise_entry("gitlab.com/group/*", "gitlab.com").as_deref(),
            Ok("group/*")
        );
        assert_eq!(
            normalise_entry("gitlab.com/*", "gitlab.com"),
            Err(GitEntryError::WholeHost)
        );
    }

    #[test]
    fn enforced_entries_normalise_sort_deduplicate_and_name_the_rejected() {
        let stored = [
            "team/*".to_string(),
            "Owner/Repo.git".to_string(),
            "*".to_string(),
            "owner/repo".to_string(),
            "https://gitlab.com/a/b".to_string(),
        ];
        assert_eq!(
            enforced_entries(&stored, GITHUB),
            (
                vec!["owner/repo".to_string(), "team/*".to_string()],
                vec![2, 4]
            )
        );
        assert_eq!(enforced_entries(&[], GITHUB), (vec![], vec![]));
    }

    #[test]
    fn normalise_entry_compares_hosts_without_port_or_case() {
        assert_eq!(
            normalise_entry("https://GitLab.Example.com/g/r", GITLAB_CORP).as_deref(),
            Ok("g/r")
        );
        assert_eq!(
            normalise_entry("https://gitlab.example.com:9999/g/r", "gitlab.example.com").as_deref(),
            Ok("g/r")
        );
        assert_eq!(
            normalise_entry("https://gitlab.example.org/g/r", GITLAB_CORP),
            Err(GitEntryError::OtherHost)
        );
    }

    #[test]
    fn normalise_entry_never_matches_an_ipv6_host_against_another() {
        assert_eq!(
            normalise_entry("https://[::2]:8443/g/r", "[::1]:8443"),
            Err(GitEntryError::OtherHost)
        );
        assert_eq!(
            normalise_entry("https://[::1]:8443/g/r", "[::1]:8443").as_deref(),
            Ok("g/r")
        );
    }

    #[test]
    fn entry_errors_read_as_distinct_sentences() {
        let all = [
            GitEntryError::Empty,
            GitEntryError::WholeHost,
            GitEntryError::MisplacedWildcard,
            GitEntryError::TooFewSegments,
            GitEntryError::BadSegment,
            GitEntryError::ForbiddenCharacter,
            GitEntryError::OtherHost,
            GitEntryError::UnsupportedScheme,
        ];
        let texts: std::collections::BTreeSet<String> = all.iter().map(|e| e.to_string()).collect();
        assert_eq!(texts.len(), all.len());
        for text in &texts {
            assert!(text.ends_with('.') && text.len() > 10, "{text}");
        }
    }

    #[test]
    fn remote_urls_of_reads_url_and_pushurl_of_every_remote_only() {
        let config = r#"
[core]
	repositoryformatversion = 0
	url = https://not-a-remote.example/a/b
[remote "origin"]
	url = git@github.com:owner/repo.git
	pushurl = "https://github.com/owner/repo.git"
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
	remote = origin
[remote "upstream"]
	URL = https://github.com/upstream/repo
"#;
        assert_eq!(
            remote_urls_of(config),
            [
                "git@github.com:owner/repo.git",
                "https://github.com/owner/repo.git",
                "https://github.com/upstream/repo",
            ]
        );
    }

    #[test]
    fn lexical_relative_resolves_dots_and_refuses_an_escape() {
        let root = Path::new("/p/root");
        assert_eq!(
            lexical_relative(root, Path::new("/p/root/a/./b/../c")),
            Some(PathBuf::from("a/c"))
        );
        assert_eq!(
            lexical_relative(root, Path::new("/p/root/a/../../root/x")),
            Some(PathBuf::from("x"))
        );
        assert_eq!(lexical_relative(root, Path::new("/p/other/x")), None);
        assert_eq!(lexical_relative(root, Path::new("/p/root")), None);
        assert_eq!(lexical_relative(root, Path::new("/p/root/../../..")), None);
    }

    #[test]
    fn suggestions_collect_the_project_and_nested_remotes_once_with_their_directory() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path();
        write_repo(
            root,
            &[
                "git@github.com:speednet-software/speedwave.git",
                "https://github.com/speednet-software/speedwave",
            ],
        );
        write_repo(
            &root.join(".code/plugin"),
            &["https://github.com/team/plugin.git"],
        );
        write_repo(
            &root.join("docs/site"),
            &[
                "https://github.com/org/site.git",
                "git@gitlab.com:g/other.git",
            ],
        );
        write_repo(&root.join("a/b/c"), &["https://github.com/too/deep"]);
        write_repo(
            &root.join("node_modules/dep"),
            &["https://github.com/dep/dep"],
        );
        write_repo(&root.join("target/dep"), &["https://github.com/build/out"]);
        std::fs::create_dir_all(root.join("empty")).unwrap();
        std::fs::create_dir_all(root.join("no-config/.git")).unwrap();
        std::fs::write(root.join("file.txt"), "x").unwrap();

        let found = suggestions_in(root, GITHUB, &[]);
        let as_pairs: Vec<(&str, &str)> = found
            .iter()
            .map(|s| (s.entry.as_str(), s.source_dir.as_str()))
            .collect();
        assert_eq!(
            as_pairs,
            [
                ("org/site", "docs/site"),
                ("speednet-software/speedwave", "."),
                ("team/plugin", ".code/plugin"),
            ]
        );
    }

    #[test]
    fn suggestions_keep_the_first_directory_found_root_first() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path();
        write_repo(&root.join("b"), &["https://github.com/dup/repo"]);
        write_repo(&root.join("a"), &["https://github.com/dup/repo"]);
        assert_eq!(suggestions_in(root, GITHUB, &[])[0].source_dir, "a");
        write_repo(root, &["https://github.com/dup/repo"]);
        assert_eq!(suggestions_in(root, GITHUB, &[])[0].source_dir, ".");
    }

    #[test]
    fn suggestions_leave_out_listed_entries_other_hosts_and_wildcards() {
        let project = tempfile::tempdir().unwrap();
        write_repo(
            project.path(),
            &[
                "https://github.com/owner/one",
                "https://github.com/owner/two",
                "https://github.com/owner/*",
                "https://gitlab.com/group/three",
                "/srv/git/local.git",
                "not a url",
            ],
        );
        let listed = ["owner/one".to_string(), "unrelated/entry".to_string()];
        let entries: Vec<String> = suggestions_in(project.path(), GITHUB, &listed)
            .into_iter()
            .map(|s| s.entry)
            .collect();
        assert_eq!(entries, ["owner/two"]);
    }

    #[test]
    fn suggestions_match_the_forge_host_ignoring_port() {
        let project = tempfile::tempdir().unwrap();
        write_repo(
            project.path(),
            &[
                "git@gitlab.example.com:team/app.git",
                "https://gitlab.example.com:8443/team/web",
                "https://gitlab.com/group/repo",
            ],
        );
        let entries: Vec<String> = suggestions_in(project.path(), GITLAB_CORP, &[])
            .into_iter()
            .map(|s| s.entry)
            .collect();
        assert_eq!(entries, ["team/app", "team/web"]);
    }

    fn write_main_with_worktree_meta(root: &Path, url: &str) -> PathBuf {
        let main = root.join(".code/repos/main");
        write_repo(&main, &[url]);
        let worktree_meta = main.join(".git/worktrees/wt");
        std::fs::create_dir_all(&worktree_meta).unwrap();
        worktree_meta
    }

    #[test]
    fn suggestions_follow_a_worktree_to_its_common_config() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path();
        let worktree_meta = write_main_with_worktree_meta(root, "git@github.com:owner/repo.git");
        std::fs::write(worktree_meta.join("commondir"), "../..\n").unwrap();
        assert_eq!(entries_on_github(root), Vec::<String>::new());

        write_pointer(&root.join(".code/wt"), "../repos/main/.git/worktrees/wt");
        let found = suggestions_in(root, GITHUB, &[]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].entry, "owner/repo");
        assert_eq!(found[0].source_dir, ".code/wt");

        std::fs::remove_dir_all(root.join(".code/wt")).unwrap();
        write_pointer(
            &root.join(".code/wt-absolute"),
            &worktree_meta.display().to_string(),
        );
        assert_eq!(entries_on_github(root), ["owner/repo"]);

        let broken = root.join(".code/broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join(".git"), "not a pointer").unwrap();
        assert_eq!(entries_on_github(root).len(), 1);
    }

    #[test]
    fn suggestions_confine_the_commondir_of_a_worktree() {
        let outside = tempfile::tempdir().unwrap();
        write_repo(outside.path(), &["https://github.com/outside/repo"]);
        let project = tempfile::tempdir().unwrap();
        let root = project.path();
        let worktree_meta = write_main_with_worktree_meta(root, "https://github.com/owner/repo");
        write_pointer(&root.join(".code/wt"), "../repos/main/.git/worktrees/wt");

        std::fs::write(
            worktree_meta.join("commondir"),
            outside.path().join(".git").display().to_string(),
        )
        .unwrap();
        assert!(entries_on_github(root).is_empty());

        std::fs::write(worktree_meta.join("commondir"), "../../../../../../..\n").unwrap();
        assert!(entries_on_github(root).is_empty());

        #[cfg(unix)]
        {
            std::fs::remove_file(worktree_meta.join("commondir")).unwrap();
            std::fs::write(root.join("commondir-target"), "../..\n").unwrap();
            std::os::unix::fs::symlink(
                root.join("commondir-target"),
                worktree_meta.join("commondir"),
            )
            .unwrap();
            assert!(entries_on_github(root).is_empty());
        }
    }

    #[test]
    fn suggestions_never_read_outside_the_project_directory() {
        let outside = tempfile::tempdir().unwrap();
        write_repo(outside.path(), &["https://github.com/outside/repo"]);
        let outside_name = outside.path().file_name().unwrap().to_str().unwrap();
        let project = tempfile::tempdir().unwrap();
        let root = project.path();
        write_pointer(
            &root.join(".code/absolute"),
            &outside.path().join(".git").display().to_string(),
        );
        write_pointer(
            &root.join(".code/relative"),
            &format!("../../../{outside_name}/.git"),
        );
        write_pointer(&root.join(".code/root"), "../../../..");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), root.join(".code/linked")).unwrap();
            std::fs::create_dir_all(root.join(".code/linked-git")).unwrap();
            std::os::unix::fs::symlink(
                outside.path().join(".git"),
                root.join(".code/linked-git/.git"),
            )
            .unwrap();
            std::os::unix::fs::symlink(outside.path(), root.join(".code/mid")).unwrap();
            write_pointer(&root.join(".code/through-link"), "../mid/.git");
            std::fs::create_dir_all(root.join(".code/linked-config/.git")).unwrap();
            std::os::unix::fs::symlink(
                outside.path().join(".git/config"),
                root.join(".code/linked-config/.git/config"),
            )
            .unwrap();
        }
        assert!(entries_on_github(root).is_empty());
    }

    #[test]
    fn suggestions_of_a_missing_directory_are_empty() {
        assert!(entries_on_github(Path::new("/nonexistent/speedwave-project")).is_empty());
    }
}
