//! Removes files and directories under the data directory that older releases wrote and the
//! current code neither reads nor writes: the host-exec state tree, the SharePoint v1 secrets, the
//! mcp-os port and pid files, the in-tree plugin image marker, the state of the removed OAuth
//! worker, and the worker bearers, proxy caller token and OAuth refresh locks that moved into the
//! secret store layout, and the git transport gitconfig that carried the caller token. Jira: SPEED-1013,
//! SPEED-1016, SPEED-1046. Added in: v0.23.0

use std::path::Path;

use crate::Migration;

pub(super) const MIGRATION: Migration = Migration {
    name: "legacy_files",
    run: remove_legacy_paths,
};

const ADDED_IN: &str = "v0.23.0";

const PLACEHOLDERS: &[&str] = &["{project}", "{service}", "{plugin}"];

struct LegacyPath {
    pattern: &'static str,
    reason: &'static str,
    added_in: &'static str,
}

const LEGACY_PATHS: &[LegacyPath] = &[
    LegacyPath {
        pattern: "host-exec",
        reason: "state tree of the retired host-exec worker",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "tokens/{project}/sharepoint/refresh_token",
        reason: "SharePoint secret of the v1 token layout",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "tokens/{project}/sharepoint/client_id",
        reason: "SharePoint secret of the v1 token layout",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "tokens/{project}/sharepoint/tenant_id",
        reason: "SharePoint secret of the v1 token layout",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "mcp-os-port",
        reason: "mcp-os port file from before the lock file",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "mcp-os-pid",
        reason: "mcp-os pid file from before the lock file",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "plugins/{plugin}/.image_pending",
        reason: "image build marker inside the signed plugin tree, now kept in plugin-state",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "oauth/{project}/.bearer-map.json",
        reason: "bearer map of the removed OAuth worker",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "oauth/{project}/lock.json",
        reason: "process lock of the removed OAuth worker",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "oauth/{project}/auth-token",
        reason: "process token of the removed OAuth worker",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "oauth/{project}/port",
        reason: "port file of the removed OAuth worker",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "oauth/{project}/pid",
        reason: "pid file of the removed OAuth worker",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "secrets/{project}/{service}-auth-token",
        reason: "worker bearer file, now derived from the install key",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "proxy/{project}/caller-token",
        reason: "proxy caller token file, now drawn at project start and kept in the VM tmpfs only",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "claude-home/{project}/.config/speedwave/git-transport.gitconfig",
        reason: "git transport gitconfig that held the caller token, now a credential helper",
        added_in: ADDED_IN,
    },
    LegacyPath {
        pattern: "oauth/{project}/{service}.lock",
        reason: "OAuth refresh lock, now kept next to the encrypted refresh token",
        added_in: ADDED_IN,
    },
];

enum Segment<'a> {
    Literal(&'a str),
    Pattern { prefix: &'a str, suffix: &'a str },
}

#[derive(Default)]
struct Outcome {
    removed: usize,
    failed: usize,
}

fn remove_legacy_paths(data_dir: &Path) -> Result<(), String> {
    remove_paths(data_dir, LEGACY_PATHS)
}

fn remove_paths(data_dir: &Path, paths: &[LegacyPath]) -> Result<(), String> {
    let mut failed = 0;
    for legacy in paths {
        let Some(segments) = parse_pattern(legacy.pattern) else {
            log::warn!("legacy path pattern {} is not valid", legacy.pattern);
            failed += 1;
            continue;
        };
        let mut outcome = Outcome::default();
        remove_matching(data_dir, &segments, &mut outcome);
        if outcome.removed > 0 {
            log::info!(
                "removed {} legacy path(s) matching {} ({}, listed since {})",
                outcome.removed,
                legacy.pattern,
                legacy.reason,
                legacy.added_in
            );
        }
        if outcome.failed > 0 {
            log::warn!(
                "{} legacy path(s) matching {} could not be removed",
                outcome.failed,
                legacy.pattern
            );
        }
        failed += outcome.failed;
    }
    if failed == 0 {
        Ok(())
    } else {
        Err(format!("{failed} legacy path(s) could not be removed"))
    }
}

fn parse_pattern(pattern: &str) -> Option<Vec<Segment<'_>>> {
    let segments = pattern
        .split('/')
        .map(parse_segment)
        .collect::<Option<Vec<_>>>()?;
    let ends_in_bare_wildcard = matches!(
        segments.last()?,
        Segment::Pattern { prefix, suffix } if prefix.is_empty() && suffix.is_empty()
    );
    (!ends_in_bare_wildcard).then_some(segments)
}

fn parse_segment(segment: &str) -> Option<Segment<'_>> {
    let Some((start, placeholder)) = PLACEHOLDERS
        .iter()
        .copied()
        .find_map(|placeholder| segment.find(placeholder).map(|at| (at, placeholder)))
    else {
        return is_plain_name(segment).then_some(Segment::Literal(segment));
    };
    let prefix = &segment[..start];
    let suffix = &segment[start + placeholder.len()..];
    let affixes_are_plain = [prefix, suffix]
        .iter()
        .all(|affix| affix.is_empty() || is_plain_name(affix));
    affixes_are_plain.then_some(Segment::Pattern { prefix, suffix })
}

fn is_plain_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '{', '}', ':', '\0'])
}

fn remove_matching(base: &Path, segments: &[Segment<'_>], outcome: &mut Outcome) {
    let Some((first, rest)) = segments.split_first() else {
        return;
    };
    match first {
        Segment::Literal(name) => {
            let path = base.join(name);
            if rest.is_empty() {
                remove_entry(&path, outcome);
            } else if is_real_dir(&path) {
                remove_matching(&path, rest, outcome);
            }
        }
        Segment::Pattern { prefix, suffix } => {
            let entries = match std::fs::read_dir(base) {
                Ok(entries) => entries,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
                Err(_) => {
                    outcome.failed += 1;
                    return;
                }
            };
            for entry in entries.flatten() {
                let file_name = entry.file_name();
                let Some(name) = file_name.to_str() else {
                    continue;
                };
                if !matches_affixes(name, prefix, suffix) {
                    continue;
                }
                if rest.is_empty() {
                    remove_entry(&entry.path(), outcome);
                } else if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    remove_matching(&entry.path(), rest, outcome);
                }
            }
        }
    }
}

fn remove_entry(path: &Path, outcome: &mut Outcome) {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            outcome.failed += 1;
            return;
        }
    };
    let result = if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    match result {
        Ok(()) => outcome.removed += 1,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            log::warn!("a legacy path could not be removed: {:?}", e.kind());
            outcome.failed += 1;
        }
    }
}

fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

fn matches_affixes(name: &str, prefix: &str, suffix: &str) -> bool {
    name.len() > prefix.len() + suffix.len() && name.starts_with(prefix) && name.ends_with(suffix)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn custom(pattern: &'static str) -> [LegacyPath; 1] {
        [LegacyPath {
            pattern,
            reason: "test",
            added_in: "v0",
        }]
    }

    fn legacy_samples(data_dir: &Path) -> Vec<PathBuf> {
        let mut files = vec![
            data_dir.join("mcp-os-port"),
            data_dir.join("mcp-os-pid"),
            data_dir.join("host-exec").join("alpha").join("auth-token"),
            data_dir.join("host-exec").join("config.json"),
        ];
        for project in ["alpha", "beta"] {
            for name in ["refresh_token", "client_id", "tenant_id"] {
                let sharepoint = data_dir.join("tokens").join(project).join("sharepoint");
                files.push(sharepoint.join(name));
            }
            for name in [
                ".bearer-map.json",
                "lock.json",
                "auth-token",
                "port",
                "pid",
                "sharepoint.lock",
                "slack.lock",
            ] {
                files.push(data_dir.join("oauth").join(project).join(name));
            }
            let secrets = data_dir.join("secrets").join(project);
            files.push(secrets.join("sharepoint-auth-token"));
            files.push(secrets.join("worker-auth-token"));
            files.push(data_dir.join("proxy").join(project).join("caller-token"));
            files.push(
                data_dir
                    .join("claude-home")
                    .join(project)
                    .join(".config")
                    .join("speedwave")
                    .join("git-transport.gitconfig"),
            );
        }
        files.push(data_dir.join("plugins").join("glpi").join(".image_pending"));
        files.push(
            data_dir
                .join("plugins")
                .join("other")
                .join(".image_pending"),
        );
        files
    }

    fn live_samples(data_dir: &Path) -> Vec<PathBuf> {
        let mut files = vec![
            data_dir.join("config.json"),
            data_dir.join("mcp-os.lock.json"),
            data_dir.join("mcp-os-auth-token"),
            data_dir.join("plugins").join("glpi").join("plugin.json"),
            data_dir
                .join("plugin-state")
                .join("glpi")
                .join("image_pending"),
        ];
        for project in ["alpha", "beta"] {
            let tokens = data_dir.join("tokens").join(project);
            files.push(tokens.join("sharepoint").join("access_token"));
            files.push(tokens.join("sharepoint").join("site_id"));
            files.push(tokens.join("llm").join("local"));
            files.push(tokens.join("local-llm").join("api_key"));
            files.push(tokens.join("local-llm").join("custom_headers"));
            let oauth = data_dir.join("oauth").join(project);
            files.push(oauth.join("sharepoint.json"));
            files.push(oauth.join("audit.log"));
            files.push(oauth.join("bearer-sharepoint"));
            files.push(oauth.join("bearer-glpi"));
            let secrets = data_dir.join("secrets").join(project);
            files.push(secrets.join("slack.access_token.enc"));
            files.push(secrets.join("slack.refresh_token.enc"));
            files.push(secrets.join("slack.refresh_token.enc.lock"));
            files.push(secrets.join("anthropic.api_key.enc"));
            files.push(secrets.join("pii.key.enc"));
            files.push(secrets.join("llm.openrouter_api_key.enc"));
        }
        files.push(data_dir.join("secret-store.key"));
        files.push(
            data_dir
                .join("claude-home")
                .join("alpha")
                .join(".config")
                .join("speedwave")
                .join("git-proxy.gitconfig"),
        );
        files
    }

    #[test]
    fn removes_every_listed_path_and_keeps_every_other_file() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        let legacy = legacy_samples(data_dir);
        let live = live_samples(data_dir);
        for path in legacy.iter().chain(live.iter()) {
            write(path, "x");
        }

        remove_legacy_paths(data_dir).unwrap();

        for path in &legacy {
            assert!(!path.exists(), "{} must be removed", path.display());
        }
        assert!(!data_dir.join("host-exec").exists());
        for path in &live {
            assert!(path.exists(), "{} must stay", path.display());
        }
    }

    #[test]
    fn running_twice_is_a_no_op_the_second_time() {
        let tmp = tempfile::tempdir().unwrap();
        for path in legacy_samples(tmp.path()) {
            write(&path, "x");
        }

        remove_legacy_paths(tmp.path()).unwrap();
        remove_legacy_paths(tmp.path()).unwrap();

        assert!(!tmp.path().join("mcp-os-port").exists());
    }

    #[test]
    fn an_empty_data_dir_is_fine() {
        let tmp = tempfile::tempdir().unwrap();

        assert!(remove_legacy_paths(tmp.path()).is_ok());
    }

    #[test]
    fn project_directories_that_hold_no_legacy_files_are_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let alpha = tmp.path().join("tokens").join("alpha");
        let kept = alpha.join("llm").join("local");
        write(&kept, "key");
        std::fs::create_dir_all(tmp.path().join("oauth").join("alpha")).unwrap();

        remove_legacy_paths(tmp.path()).unwrap();

        assert!(kept.exists());
        assert!(tmp.path().join("oauth").join("alpha").is_dir());
    }

    #[test]
    fn project_names_with_unicode_and_spaces_are_enumerated() {
        let tmp = tempfile::tempdir().unwrap();
        let token = tmp
            .path()
            .join("tokens")
            .join("проект ß")
            .join("sharepoint")
            .join("refresh_token");
        write(&token, "old");

        remove_legacy_paths(tmp.path()).unwrap();

        assert!(!token.exists());
    }

    #[test]
    fn a_name_that_only_looks_like_the_prefix_pattern_stays() {
        let tmp = tempfile::tempdir().unwrap();
        let oauth = tmp.path().join("oauth").join("alpha");
        write(&oauth.join("bearer-"), "x");
        write(&oauth.join("bearer"), "x");
        write(&oauth.join("my-bearer-x"), "x");
        write(&oauth.join("bearer-slack"), "x");

        remove_paths(tmp.path(), &custom("oauth/{project}/bearer-{service}")).unwrap();

        assert!(oauth.join("bearer-").exists());
        assert!(oauth.join("bearer").exists());
        assert!(oauth.join("my-bearer-x").exists());
        assert!(!oauth.join("bearer-slack").exists());
    }

    #[test]
    fn a_file_where_a_project_directory_is_expected_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("tokens").join("not-a-project"), "x");
        write(&tmp.path().join("oauth"), "x");

        assert!(remove_legacy_paths(tmp.path()).is_ok());
        assert!(tmp.path().join("tokens").join("not-a-project").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_removed_or_skipped_and_never_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let outside = tmp.path().join("outside");
        write(&outside.join("refresh_token"), "outside-token");
        write(&outside.join("auth-token"), "outside-auth");
        write(&outside.join("host-exec-file"), "outside-exec");
        let project_tokens = data_dir.join("tokens").join("alpha");
        let project_oauth = data_dir.join("oauth").join("alpha");
        std::fs::create_dir_all(&project_tokens).unwrap();
        std::fs::create_dir_all(&project_oauth).unwrap();
        let linked_sharepoint = project_tokens.join("sharepoint");
        let linked_auth_token = project_oauth.join("auth-token");
        let linked_host_exec = data_dir.join("host-exec");
        std::os::unix::fs::symlink(&outside, &linked_sharepoint).unwrap();
        std::os::unix::fs::symlink(outside.join("auth-token"), &linked_auth_token).unwrap();
        std::os::unix::fs::symlink(&outside, &linked_host_exec).unwrap();

        remove_legacy_paths(&data_dir).unwrap();

        let read = |name: &str| std::fs::read_to_string(outside.join(name)).unwrap();
        assert_eq!(read("refresh_token"), "outside-token");
        assert_eq!(read("auth-token"), "outside-auth");
        assert_eq!(read("host-exec-file"), "outside-exec");
        assert!(std::fs::symlink_metadata(&linked_host_exec).is_err());
        assert!(std::fs::symlink_metadata(&linked_auth_token).is_err());
        assert!(std::fs::symlink_metadata(&linked_sharepoint).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_path_that_cannot_be_removed_is_an_error_and_the_rest_still_goes() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let locked_dir = tmp.path().join("tokens").join("alpha").join("sharepoint");
        write(&locked_dir.join("refresh_token"), "old");
        let beta = tmp.path().join("tokens").join("beta");
        let removable = beta.join("sharepoint").join("refresh_token");
        write(&removable, "old");
        std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let enforced = std::fs::write(locked_dir.join("probe"), "x").is_err();

        let result = remove_legacy_paths(tmp.path());

        std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        if enforced {
            assert_eq!(result.unwrap_err(), "1 legacy path(s) could not be removed");
            assert!(locked_dir.join("refresh_token").exists());
        }
        assert!(!removable.exists());
    }

    #[test]
    fn patterns_that_could_leave_the_data_dir_or_match_everything_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let outside = tmp.path().join("outside.txt");
        write(&outside, "keep");
        write(&data_dir.join("tokens").join("alpha").join("keep"), "keep");
        let invalid = [
            "../outside.txt",
            "tokens/../../outside.txt",
            "",
            "tokens//alpha",
            "tokens/{project}",
            "{project}",
            "tokens/{project}/{service}",
            "tokens/{unknown}/keep",
            "tokens/{project}{service}/keep",
            "tokens\\alpha\\keep",
            "tokens/a{project",
            "/etc/passwd",
            "tokens/./alpha",
        ];

        for pattern in invalid {
            let result = remove_paths(&data_dir, &custom(pattern));

            assert_eq!(
                result.unwrap_err(),
                "1 legacy path(s) could not be removed",
                "{pattern:?} must be rejected"
            );
        }
        assert!(outside.exists());
        assert!(data_dir.join("tokens").join("alpha").join("keep").exists());
    }

    #[test]
    fn a_pattern_with_a_prefix_or_suffix_on_the_last_segment_is_accepted() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("oauth").join("alpha").join("bearer-x");
        write(&file, "x");

        assert!(remove_paths(tmp.path(), &custom("oauth/{project}/bearer-{service}")).is_ok());
        assert!(!file.exists());

        let suffixed = tmp.path().join("oauth").join("alpha").join("x.old");
        write(&suffixed, "x");

        assert!(remove_paths(tmp.path(), &custom("oauth/{project}/{service}.old")).is_ok());
        assert!(!suffixed.exists());
    }

    #[test]
    fn every_listed_pattern_is_valid() {
        for legacy in LEGACY_PATHS {
            assert!(
                parse_pattern(legacy.pattern).is_some(),
                "{} is not a valid pattern",
                legacy.pattern
            );
        }
    }
}
