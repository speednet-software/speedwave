use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use super::status::Status;
use super::store::{self, Paths};
use super::RefreshOutcome;
use crate::compose::secret_payload::service_token_slots_in;
use crate::consts;
use crate::runtime::LockedRuntime;

#[derive(Clone, Copy)]
pub(super) struct Target<'a> {
    pub(super) runtime: &'a LockedRuntime,
    pub(super) data_dir: &'a Path,
    pub(super) project: &'a str,
}

pub(super) struct Change {
    pub(super) outcome: RefreshOutcome,
    pub(super) name: Option<String>,
}

#[derive(Default)]
struct Pending {
    token: bool,
    status: Option<String>,
    name: Option<String>,
}

impl Pending {
    fn is_empty(&self) -> bool {
        !self.token && self.status.is_none() && self.name.is_none()
    }
}

#[derive(Default)]
struct Entry {
    status: Option<Status>,
    pending: Pending,
    warned: bool,
}

type Entries = HashMap<(String, String), Arc<Mutex<Entry>>>;

/// What the process still has to put into the secrets tmpfs of every `(project, service)`.
#[derive(Clone, Default)]
pub(super) struct Publications(Arc<Mutex<Entries>>);

impl Publications {
    pub(super) fn shared() -> Self {
        static SHARED: OnceLock<Publications> = OnceLock::new();
        SHARED.get_or_init(Self::default).clone()
    }

    pub(super) fn publish(&self, target: Target<'_>, service: &str, change: Change) {
        let entry = self.entry(target.project, service);
        let mut entry = entry.lock().unwrap_or_else(PoisonError::into_inner);
        if !entry.pending.is_empty() && !containers_running(target) {
            entry.pending = Pending::default();
            entry.warned = false;
        }
        entry.record(change);
        if !entry.pending.is_empty() {
            entry.flush(target, service);
        }
    }

    fn entry(&self, project: &str, service: &str) -> Arc<Mutex<Entry>> {
        Arc::clone(
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry((project.to_string(), service.to_string()))
                .or_default(),
        )
    }
}

impl Entry {
    fn record(&mut self, change: Change) {
        if change.outcome == RefreshOutcome::Refreshed {
            self.pending.token = true;
        }
        let status = Status::of(change.outcome);
        if self.status != Some(status) {
            self.status = Some(status);
            self.pending.status = Some(status.file_content());
        }
        if change.name.is_some() {
            self.pending.name = change.name;
        }
    }

    fn flush(&mut self, target: Target<'_>, service: &str) {
        let failed = self.write_pending(target, service).is_err();
        if failed && !self.warned {
            log::warn!("could not update the container secrets of service {service}");
        }
        self.warned = failed;
    }

    fn write_pending(&mut self, target: Target<'_>, service: &str) -> anyhow::Result<()> {
        let slots = service_token_slots_in(target.data_dir, target.project, service)?;
        let Some(worker) = slots.worker else {
            self.pending = Pending::default();
            return Ok(());
        };
        if self.pending.token {
            let host_file = Paths::new(target.data_dir, target.project, service)
                .token_dir
                .join(store::ACCESS_TOKEN_FILE);
            let token = std::fs::read(host_file)?;
            for slot in std::iter::once(&worker).chain(&slots.git) {
                target.runtime.put_secret_file(
                    target.project,
                    slot,
                    store::ACCESS_TOKEN_FILE,
                    &token,
                )?;
            }
            self.pending.token = false;
        }
        if let Some(content) = &self.pending.status {
            target.runtime.put_secret_file(
                target.project,
                &worker,
                consts::OAUTH_REFRESH_STATUS_FILE,
                content.as_bytes(),
            )?;
            self.pending.status = None;
        }
        if let Some(name) = &self.pending.name {
            target.runtime.put_secret_file(
                target.project,
                &worker,
                consts::OAUTH_SERVICE_NAME_FILE,
                name.as_bytes(),
            )?;
            self.pending.name = None;
        }
        Ok(())
    }
}

fn containers_running(target: Target<'_>) -> bool {
    target
        .runtime
        .compose_ps(target.project)
        .is_ok_and(|containers| !containers.is_empty())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use base64::Engine;

    use super::*;
    use crate::config::{
        IntegrationConfig, IntegrationsConfig, ProjectUserEntry, SpeedwaveUserConfig,
    };
    use crate::runtime::mock_runtime::{MockHandles, MockRuntimeBuilder};

    fn enabled() -> Option<IntegrationConfig> {
        Some(IntegrationConfig {
            enabled: Some(true),
            ..Default::default()
        })
    }

    fn data_dir_with(integrations: IntegrationsConfig) -> tempfile::TempDir {
        let data_dir = tempfile::tempdir().unwrap();
        let config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "proj".to_string(),
                dir: data_dir
                    .path()
                    .join("project")
                    .to_string_lossy()
                    .into_owned(),
                claude: None,
                integrations: Some(integrations),
                plugin_settings: None,
                policy: None,
                effort_pin: None,
                read_only: false,
            }],
            ..Default::default()
        };
        crate::config::save_user_config_to(&config, &data_dir.path().join("config.json")).unwrap();
        data_dir
    }

    fn data_dir_with_project() -> tempfile::TempDir {
        data_dir_with(IntegrationsConfig {
            slack: enabled(),
            ..Default::default()
        })
    }

    fn write_access_token(data_dir: &Path, service: &str, token: &str) {
        let dir = Paths::new(data_dir, "proj", service).token_dir;
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(store::ACCESS_TOKEN_FILE), token).unwrap();
    }

    fn running_runtime(exit: i32) -> (LockedRuntime, MockHandles) {
        MockRuntimeBuilder::new()
            .with_ps_response("proj", vec![serde_json::json!({"State": "running"})])
            .with_vm_exec_as_root_exit(exit, "")
            .build()
    }

    fn change(outcome: RefreshOutcome) -> Change {
        Change {
            outcome,
            name: None,
        }
    }

    fn publish(
        publications: &Publications,
        runtime: &LockedRuntime,
        data_dir: &Path,
        outcome: RefreshOutcome,
    ) {
        publications.publish(
            Target {
                runtime,
                data_dir,
                project: "proj",
            },
            "slack",
            change(outcome),
        );
    }

    fn puts(handles: &MockHandles) -> Vec<(String, String, String)> {
        let calls = handles.vm_exec_calls.lock().unwrap();
        let mut decoded = Vec::new();
        for call in calls.iter() {
            let text = String::from_utf8(call.stdin.clone()).unwrap();
            assert!(text.starts_with("put proj\n"), "{text}");
            for line in text.lines().skip(1) {
                let mut fields = line.splitn(4, ' ');
                assert_eq!(fields.next(), Some("F"));
                let slot = fields.next().unwrap().to_string();
                let name = fields.next().unwrap().to_string();
                let content = base64::engine::general_purpose::STANDARD
                    .decode(fields.next().unwrap_or(""))
                    .unwrap();
                decoded.push((slot, name, String::from_utf8(content).unwrap()));
            }
        }
        decoded
    }

    fn statuses(handles: &MockHandles) -> Vec<String> {
        puts(handles)
            .into_iter()
            .filter(|(_, name, _)| name == "refresh_status")
            .map(|(_, _, content)| content)
            .map(|content| {
                serde_json::from_str::<serde_json::Value>(&content)
                    .map_or(content, |json| json["state"].as_str().unwrap().to_string())
            })
            .collect()
    }

    #[test]
    fn a_refreshed_token_is_put_into_the_tokens_slot_of_its_worker() {
        let data_dir = data_dir_with_project();
        write_access_token(data_dir.path(), "slack", "new-at");
        let (runtime, handles) = running_runtime(0);

        publish(
            &Publications::default(),
            &runtime,
            data_dir.path(),
            RefreshOutcome::Refreshed,
        );

        assert_eq!(
            puts(&handles),
            vec![
                (
                    "mcp-slack/tokens".to_string(),
                    "access_token".to_string(),
                    "new-at".to_string()
                ),
                (
                    "mcp-slack/tokens".to_string(),
                    "refresh_status".to_string(),
                    String::new()
                ),
            ]
        );
    }

    #[test]
    fn a_service_without_a_mounted_worker_publishes_nothing() {
        let data_dir = data_dir_with_project();
        write_access_token(data_dir.path(), "mystery", "at");
        let (runtime, handles) = running_runtime(0);
        let publications = Publications::default();
        let target = Target {
            runtime: &runtime,
            data_dir: data_dir.path(),
            project: "proj",
        };

        publications.publish(target, "mystery", change(RefreshOutcome::Refreshed));
        publications.publish(target, "mystery", change(RefreshOutcome::Refreshed));

        assert!(puts(&handles).is_empty());
    }

    #[test]
    fn the_status_is_put_only_when_it_changes_and_never_written_to_the_host() {
        let data_dir = data_dir_with_project();
        write_access_token(data_dir.path(), "slack", "at");
        let (runtime, handles) = running_runtime(0);
        let publications = Publications::default();

        for outcome in [
            RefreshOutcome::NotDue,
            RefreshOutcome::NotDue,
            RefreshOutcome::NetworkError,
            RefreshOutcome::NetworkError,
            RefreshOutcome::ReconnectRequired,
            RefreshOutcome::NotDue,
            RefreshOutcome::NotDue,
        ] {
            publish(&publications, &runtime, data_dir.path(), outcome);
        }

        assert_eq!(
            statuses(&handles),
            ["", "network_error", "reconnect_required", ""]
        );
        let host_dir = Paths::new(data_dir.path(), "proj", "slack").token_dir;
        assert!(!host_dir.join(consts::OAUTH_REFRESH_STATUS_FILE).exists());
    }

    #[test]
    fn a_failed_put_is_retried_at_the_next_check_and_stops_once_it_succeeds() {
        let data_dir = data_dir_with_project();
        write_access_token(data_dir.path(), "slack", "new-at");
        let publications = Publications::default();
        let (failing, failing_handles) = running_runtime(1);
        let (working, working_handles) = running_runtime(0);

        publish(
            &publications,
            &failing,
            data_dir.path(),
            RefreshOutcome::Refreshed,
        );
        publish(
            &publications,
            &failing,
            data_dir.path(),
            RefreshOutcome::NotDue,
        );
        assert_eq!(failing_handles.vm_exec_calls.lock().unwrap().len(), 2);

        publish(
            &publications,
            &working,
            data_dir.path(),
            RefreshOutcome::NotDue,
        );
        let names: Vec<String> = puts(&working_handles)
            .into_iter()
            .map(|(_, name, _)| name)
            .collect();
        assert_eq!(names, ["access_token", "refresh_status"]);

        publish(
            &publications,
            &working,
            data_dir.path(),
            RefreshOutcome::NotDue,
        );
        assert_eq!(working_handles.vm_exec_calls.lock().unwrap().len(), 2);
    }

    #[test]
    fn retrying_stops_when_the_containers_are_not_running() {
        let data_dir = data_dir_with_project();
        write_access_token(data_dir.path(), "slack", "new-at");
        let publications = Publications::default();
        let (stopped, handles) = MockRuntimeBuilder::new()
            .with_vm_exec_as_root_exit(1, "")
            .build();
        let (working, working_handles) = running_runtime(0);

        publish(
            &publications,
            &stopped,
            data_dir.path(),
            RefreshOutcome::Refreshed,
        );
        publish(
            &publications,
            &stopped,
            data_dir.path(),
            RefreshOutcome::NotDue,
        );
        publish(
            &publications,
            &stopped,
            data_dir.path(),
            RefreshOutcome::NotDue,
        );
        assert_eq!(handles.vm_exec_calls.lock().unwrap().len(), 1);

        publish(
            &publications,
            &working,
            data_dir.path(),
            RefreshOutcome::NotDue,
        );
        assert!(puts(&working_handles).is_empty());
    }

    #[test]
    fn a_forge_token_also_reaches_the_git_slot_of_the_proxy() {
        let data_dir = data_dir_with(IntegrationsConfig {
            github: Some(crate::config::GitForgeIntegrationConfig {
                enabled: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        });
        write_access_token(data_dir.path(), "github", "gh-at");
        let (runtime, handles) = running_runtime(0);

        Publications::default().publish(
            Target {
                runtime: &runtime,
                data_dir: data_dir.path(),
                project: "proj",
            },
            "github",
            Change {
                outcome: RefreshOutcome::Refreshed,
                name: Some("GitHub".to_string()),
            },
        );

        let tokens: Vec<(String, String)> = puts(&handles)
            .into_iter()
            .filter(|(_, name, _)| name == "access_token")
            .map(|(slot, _, content)| (slot, content))
            .collect();
        assert_eq!(
            tokens,
            [
                ("mcp-github/tokens".to_string(), "gh-at".to_string()),
                ("proxy/git-github".to_string(), "gh-at".to_string()),
            ]
        );
        assert!(puts(&handles).contains(&(
            "mcp-github/tokens".to_string(),
            "service_name".to_string(),
            "GitHub".to_string()
        )));
    }
}
