use crate::types::check_project;
use serde::Serialize;
use speedwave_runtime::config::{self, SpeedwaveUserConfig};
use speedwave_runtime::git_allowlist::{
    enforced_entries, forge_host_in, normalise_entry, suggestions_in, GitForgeService,
};
use std::path::Path;

#[derive(Serialize, Debug, PartialEq)]
pub struct GitRepositoriesView {
    host: Option<String>,
    repositories: Vec<String>,
    suggestions: Vec<GitRepositorySuggestionView>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct GitRepositorySuggestionView {
    entry: String,
    source_dir: String,
}

#[tauri::command]
pub fn get_git_repositories(
    project: String,
    service: String,
) -> Result<GitRepositoriesView, String> {
    check_project(&project)?;
    let service = parse_service(&service)?;
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    view_in(
        speedwave_runtime::consts::data_dir(),
        &user_config,
        &project,
        service,
    )
}

#[tauri::command]
pub fn add_git_repository(
    project: String,
    service: String,
    entry: String,
) -> Result<GitRepositoriesView, String> {
    check_project(&project)?;
    let service = parse_service(&service)?;
    log::info!("adding a git repository entry project={project} service={service:?}");
    update_allowlist(&project, service, |data_dir, user_config| {
        add_in(data_dir, user_config, &project, service, &entry)
    })
}

#[tauri::command]
pub fn remove_git_repository(
    project: String,
    service: String,
    entry: String,
) -> Result<GitRepositoriesView, String> {
    check_project(&project)?;
    let service = parse_service(&service)?;
    log::info!("removing a git repository entry project={project} service={service:?}");
    update_allowlist(&project, service, |data_dir, user_config| {
        remove_in(data_dir, user_config, &project, service, &entry)
    })
}

fn parse_service(service: &str) -> Result<GitForgeService, String> {
    GitForgeService::from_config_key(service)
        .ok_or_else(|| format!("unsupported git service: {service}"))
}

fn update_allowlist<F>(
    project: &str,
    service: GitForgeService,
    change: F,
) -> Result<GitRepositoriesView, String>
where
    F: FnOnce(&Path, &mut SpeedwaveUserConfig) -> Result<(), String>,
{
    let data_dir: &Path = speedwave_runtime::consts::data_dir();
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        change(data_dir, &mut user_config).map_err(anyhow::Error::msg)?;
        config::save_user_config(&user_config)?;
        view_in(data_dir, &user_config, project, service).map_err(anyhow::Error::msg)
    })
    .map_err(|e| e.to_string())
}

fn view_in(
    data_dir: &Path,
    user_config: &SpeedwaveUserConfig,
    project: &str,
    service: GitForgeService,
) -> Result<GitRepositoriesView, String> {
    let entry = user_config
        .require_project(project)
        .map_err(|e| e.to_string())?;
    let host = forge_host_in(data_dir, project, service);
    let stored = entry
        .integrations
        .as_ref()
        .map(|integrations| integrations.repositories_of(service))
        .unwrap_or_default();
    let repositories = host
        .as_deref()
        .map(|host| enforced_entries(stored, host).0)
        .unwrap_or_default();
    let suggestions = host
        .as_deref()
        .map(|host| suggestions_in(Path::new(&entry.dir), host, &repositories))
        .unwrap_or_default()
        .into_iter()
        .map(|s| GitRepositorySuggestionView {
            entry: s.entry,
            source_dir: s.source_dir,
        })
        .collect();
    Ok(GitRepositoriesView {
        host,
        repositories,
        suggestions,
    })
}

fn add_in(
    data_dir: &Path,
    user_config: &mut SpeedwaveUserConfig,
    project: &str,
    service: GitForgeService,
    entry: &str,
) -> Result<(), String> {
    let host = forge_host_in(data_dir, project, service).ok_or_else(|| {
        "The host of this integration is not usable, so no repository can be added.".to_string()
    })?;
    let normalised = normalise_entry(entry, &host).map_err(|e| e.to_string())?;
    let project_entry = user_config
        .find_project_mut(project)
        .ok_or_else(|| format!("project '{project}' not found in config"))?;
    let forge = project_entry
        .integrations
        .get_or_insert_with(Default::default)
        .git_forge_mut(service);
    if !forge.repositories.contains(&normalised) {
        forge.repositories.push(normalised);
    }
    forge.repositories.sort();
    Ok(())
}

fn remove_in(
    data_dir: &Path,
    user_config: &mut SpeedwaveUserConfig,
    project: &str,
    service: GitForgeService,
    entry: &str,
) -> Result<(), String> {
    let host = forge_host_in(data_dir, project, service);
    let project_entry = user_config
        .find_project_mut(project)
        .ok_or_else(|| format!("project '{project}' not found in config"))?;
    if let Some(integrations) = project_entry.integrations.as_mut() {
        if integrations.git_forge(service).is_some() {
            integrations
                .git_forge_mut(service)
                .repositories
                .retain(|stored| {
                    stored != entry
                        && host.as_deref().is_none_or(|host| {
                            normalise_entry(stored, host).as_deref() != Ok(entry)
                        })
                });
        }
    }
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test fixture setup and assertions unwrap"
)]
mod tests {
    use super::*;
    use speedwave_runtime::config::ProjectUserEntry;
    use speedwave_runtime::git_allowlist::GitEntryError;

    struct Fixture {
        data_dir: tempfile::TempDir,
        project_dir: tempfile::TempDir,
        config: SpeedwaveUserConfig,
    }

    fn fixture() -> Fixture {
        let data_dir = tempfile::tempdir().unwrap();
        let project_dir = tempfile::tempdir().unwrap();
        let config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "proj".to_string(),
                dir: project_dir.path().to_string_lossy().to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
                effort_pin: None,
            }],
            ..Default::default()
        };
        Fixture {
            data_dir,
            project_dir,
            config,
        }
    }

    fn write_remotes(dir: &Path, urls: &[&str]) {
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let remotes: String = urls
            .iter()
            .enumerate()
            .map(|(i, u)| format!("[remote \"r{i}\"]\n\turl = {u}\n"))
            .collect();
        std::fs::write(dir.join(".git/config"), remotes).unwrap();
    }

    fn write_gitlab_host_url(data_dir: &Path, host_url: &str) {
        let gitlab = data_dir.join("tokens/proj/gitlab");
        std::fs::create_dir_all(&gitlab).unwrap();
        std::fs::write(gitlab.join("host_url"), host_url).unwrap();
    }

    fn add(f: &mut Fixture, service: GitForgeService, entry: &str) -> Result<(), String> {
        add_in(f.data_dir.path(), &mut f.config, "proj", service, entry)
    }

    fn view(f: &Fixture, service: GitForgeService) -> GitRepositoriesView {
        view_in(f.data_dir.path(), &f.config, "proj", service).unwrap()
    }

    #[test]
    fn view_of_a_project_without_settings_is_empty_with_the_forge_host() {
        let f = fixture();
        assert_eq!(
            view(&f, GitForgeService::Github),
            GitRepositoriesView {
                host: Some("github.com".to_string()),
                repositories: Vec::new(),
                suggestions: Vec::new(),
            }
        );
    }

    #[test]
    fn view_suggests_project_remotes_that_are_not_listed() {
        let mut f = fixture();
        write_remotes(
            f.project_dir.path(),
            &[
                "git@github.com:Owner/Listed.git",
                "https://github.com/owner/new",
                "https://gitlab.com/group/else",
            ],
        );
        add(&mut f, GitForgeService::Github, "owner/listed").unwrap();
        let v = view(&f, GitForgeService::Github);
        assert_eq!(v.repositories, ["owner/listed"]);
        assert_eq!(
            v.suggestions,
            [GitRepositorySuggestionView {
                entry: "owner/new".to_string(),
                source_dir: ".".to_string()
            }]
        );
    }

    #[test]
    fn view_of_gitlab_uses_the_configured_host_and_has_none_for_an_unusable_one() {
        let mut f = fixture();
        write_remotes(
            f.project_dir.path(),
            &["https://gitlab.example.com:8443/team/app.git"],
        );
        write_gitlab_host_url(f.data_dir.path(), "https://gitlab.example.com:8443");
        let v = view(&f, GitForgeService::Gitlab);
        assert_eq!(v.host.as_deref(), Some("gitlab.example.com:8443"));
        assert_eq!(v.suggestions[0].entry, "team/app");

        write_gitlab_host_url(f.data_dir.path(), "http://gitlab.example.com");
        let v = view(&f, GitForgeService::Gitlab);
        assert_eq!(v.host, None);
        assert!(v.suggestions.is_empty());
        let err = add(&mut f, GitForgeService::Gitlab, "team/app").unwrap_err();
        assert!(err.contains("host"), "{err}");
        assert!(f.config.projects[0].integrations.is_none());
    }

    #[test]
    fn view_of_an_unknown_project_is_an_error() {
        let f = fixture();
        let err = view_in(
            f.data_dir.path(),
            &f.config,
            "missing",
            GitForgeService::Github,
        )
        .unwrap_err();
        assert!(err.contains("missing"), "{err}");
    }

    #[test]
    fn add_normalises_deduplicates_and_keeps_the_list_sorted() {
        let mut f = fixture();
        for entry in [
            "Owner/Repo",
            "https://github.com/owner/repo.git",
            "a/b",
            "github.com/team/*",
        ] {
            add(&mut f, GitForgeService::Github, entry).unwrap();
        }
        assert_eq!(
            view(&f, GitForgeService::Github).repositories,
            ["a/b", "owner/repo", "team/*"]
        );
    }

    #[test]
    fn add_keeps_the_lists_of_the_two_forges_apart() {
        let mut f = fixture();
        add(&mut f, GitForgeService::Github, "owner/repo").unwrap();
        add(&mut f, GitForgeService::Gitlab, "group/sub/repo").unwrap();
        assert_eq!(
            view(&f, GitForgeService::Github).repositories,
            ["owner/repo"]
        );
        assert_eq!(
            view(&f, GitForgeService::Gitlab).repositories,
            ["group/sub/repo"]
        );
    }

    #[test]
    fn add_surfaces_the_rejection_text_and_leaves_the_config_alone() {
        let mut f = fixture();
        for (entry, reason) in [
            ("", GitEntryError::Empty),
            ("*", GitEntryError::WholeHost),
            ("github.com/*", GitEntryError::WholeHost),
            ("a/*/b", GitEntryError::MisplacedWildcard),
            ("owner", GitEntryError::TooFewSegments),
            ("https://gitlab.com/owner/repo", GitEntryError::OtherHost),
        ] {
            assert_eq!(
                add(&mut f, GitForgeService::Github, entry),
                Err(reason.to_string()),
                "{entry:?}"
            );
        }
        assert!(f.config.projects[0].integrations.is_none());
    }

    #[test]
    fn add_to_an_unknown_project_is_an_error() {
        let mut f = fixture();
        let err = add_in(
            f.data_dir.path(),
            &mut f.config,
            "missing",
            GitForgeService::Github,
            "a/b",
        )
        .unwrap_err();
        assert!(err.contains("missing"), "{err}");
    }

    #[test]
    fn remove_drops_the_exact_stored_entry_only() {
        let mut f = fixture();
        add(&mut f, GitForgeService::Github, "owner/repo").unwrap();
        add(&mut f, GitForgeService::Github, "owner/*").unwrap();
        remove_in(
            f.data_dir.path(),
            &mut f.config,
            "proj",
            GitForgeService::Github,
            "owner/repo",
        )
        .unwrap();
        assert_eq!(view(&f, GitForgeService::Github).repositories, ["owner/*"]);
        remove_in(
            f.data_dir.path(),
            &mut f.config,
            "proj",
            GitForgeService::Github,
            "owner/repo",
        )
        .unwrap();
        remove_in(
            f.data_dir.path(),
            &mut f.config,
            "proj",
            GitForgeService::Github,
            "OWNER/*",
        )
        .unwrap();
        assert_eq!(view(&f, GitForgeService::Github).repositories, ["owner/*"]);
    }

    #[test]
    fn remove_drops_a_hand_stored_entry_by_the_form_the_view_shows() {
        let mut f = fixture();
        add(&mut f, GitForgeService::Github, "team/app").unwrap();
        f.config.projects[0]
            .integrations
            .as_mut()
            .unwrap()
            .git_forge_mut(GitForgeService::Github)
            .repositories
            .push("Owner/Repo.git".to_string());
        assert_eq!(
            view(&f, GitForgeService::Github).repositories,
            ["owner/repo", "team/app"]
        );
        remove_in(
            f.data_dir.path(),
            &mut f.config,
            "proj",
            GitForgeService::Github,
            "owner/repo",
        )
        .unwrap();
        assert_eq!(view(&f, GitForgeService::Github).repositories, ["team/app"]);
    }

    #[test]
    fn view_of_an_unusable_host_lists_nothing_the_proxy_would_not_get() {
        let mut f = fixture();
        add(&mut f, GitForgeService::Gitlab, "group/app").unwrap();
        write_gitlab_host_url(f.data_dir.path(), "http://insecure.example.com");
        let view = view(&f, GitForgeService::Gitlab);
        assert_eq!(view.host, None);
        assert!(view.repositories.is_empty());
    }

    #[test]
    fn remove_without_stored_settings_creates_none() {
        let mut f = fixture();
        remove_in(
            f.data_dir.path(),
            &mut f.config,
            "proj",
            GitForgeService::Gitlab,
            "a/b",
        )
        .unwrap();
        assert!(f.config.projects[0].integrations.is_none());
        f.config.projects[0].integrations = Some(Default::default());
        remove_in(
            f.data_dir.path(),
            &mut f.config,
            "proj",
            GitForgeService::Gitlab,
            "a/b",
        )
        .unwrap();
        let integrations = f.config.projects[0].integrations.as_ref().unwrap();
        assert!(integrations.gitlab.is_none());
    }

    #[test]
    fn removing_a_suggested_entry_again_makes_it_a_suggestion() {
        let mut f = fixture();
        write_remotes(f.project_dir.path(), &["https://github.com/owner/repo"]);
        add(&mut f, GitForgeService::Github, "owner/repo").unwrap();
        assert!(view(&f, GitForgeService::Github).suggestions.is_empty());
        remove_in(
            f.data_dir.path(),
            &mut f.config,
            "proj",
            GitForgeService::Github,
            "owner/repo",
        )
        .unwrap();
        assert_eq!(view(&f, GitForgeService::Github).suggestions.len(), 1);
    }

    #[test]
    fn view_leaves_out_stored_entries_the_renderer_would_drop() {
        let mut f = fixture();
        add(&mut f, GitForgeService::Github, "owner/repo").unwrap();
        f.config.projects[0]
            .integrations
            .as_mut()
            .unwrap()
            .git_forge_mut(GitForgeService::Github)
            .repositories
            .extend(["*".to_string(), "https://gitlab.com/a/b".to_string()]);
        assert_eq!(
            view(&f, GitForgeService::Github).repositories,
            ["owner/repo"]
        );
    }

    #[test]
    fn git_forge_service_matches_ts_union() {
        for service in [GitForgeService::Github, GitForgeService::Gitlab] {
            match service {
                GitForgeService::Github | GitForgeService::Gitlab => {}
            }
        }
        let src = include_str!("../../src/src/app/models/integration.ts");
        let services: Vec<Option<GitForgeService>> =
            crate::ts_mirror::ts_union_members(src, "GitForgeService")
                .into_iter()
                .map(GitForgeService::from_config_key)
                .collect();
        assert_eq!(
            services,
            [Some(GitForgeService::Github), Some(GitForgeService::Gitlab)],
            "TS GitForgeService union must match the Rust config keys"
        );
    }

    #[test]
    fn service_other_than_github_or_gitlab_is_an_error() {
        for service in ["slack", "", "GitHub", "redmine"] {
            let err = parse_service(service).unwrap_err();
            assert!(err.contains("unsupported"), "{err}");
        }
        assert_eq!(parse_service("github"), Ok(GitForgeService::Github));
        assert_eq!(parse_service("gitlab"), Ok(GitForgeService::Gitlab));
        let err = get_git_repositories("proj".to_string(), "slack".to_string()).unwrap_err();
        assert!(err.contains("slack"), "{err}");
    }

    #[test]
    fn commands_refuse_an_invalid_project_name() {
        assert!(get_git_repositories("../x".to_string(), "github".to_string()).is_err());
        assert!(
            add_git_repository("".to_string(), "github".to_string(), "a/b".to_string()).is_err()
        );
        assert!(
            remove_git_repository("../x".to_string(), "github".to_string(), "a/b".to_string())
                .is_err()
        );
    }

    #[test]
    fn view_serialises_with_the_field_names_the_frontend_reads() {
        let mut f = fixture();
        write_remotes(f.project_dir.path(), &["https://github.com/owner/new"]);
        add(&mut f, GitForgeService::Github, "owner/repo").unwrap();
        assert_eq!(
            serde_json::to_value(view(&f, GitForgeService::Github)).unwrap(),
            serde_json::json!({
                "host": "github.com",
                "repositories": ["owner/repo"],
                "suggestions": [{"entry": "owner/new", "source_dir": "."}],
            })
        );
        write_gitlab_host_url(f.data_dir.path(), "http://nope");
        assert_eq!(
            serde_json::to_value(view(&f, GitForgeService::Gitlab)).unwrap(),
            serde_json::json!({"host": null, "repositories": [], "suggestions": []})
        );
    }
}
