use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const POLICY_CHANGED_EVENT: &str = "managed_policy_changed";

pub(crate) struct PolicyWatch {
    _watcher: RecommendedWatcher,
}

pub(crate) fn start(app: AppHandle) -> anyhow::Result<Option<PolicyWatch>> {
    let Some(file) = speedwave_runtime::managed_config::managed_config_path()? else {
        return Ok(None);
    };
    let Some(dir) = file.parent().filter(|d| d.is_dir()).map(Path::to_path_buf) else {
        return Ok(None);
    };
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(tx)?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;
    std::thread::Builder::new()
        .name("managed-policy-watch".into())
        .spawn(move || run(&app, &rx, &file))?;
    Ok(Some(PolicyWatch { _watcher: watcher }))
}

fn run(app: &AppHandle, rx: &mpsc::Receiver<notify::Result<Event>>, file: &Path) {
    let mut seen = std::fs::read(file).ok();
    while let Ok(event) = rx.recv() {
        if !touches(&event, file) {
            continue;
        }
        while rx.recv_timeout(Duration::from_millis(800)).is_ok() {}
        let now = std::fs::read(file).ok();
        if now == seen {
            continue;
        }
        seen = now;
        apply(app);
    }
}

fn touches(event: &notify::Result<Event>, file: &Path) -> bool {
    event
        .as_ref()
        .is_ok_and(|e| e.paths.iter().any(|p| p.file_name() == file.file_name()))
}

fn apply(app: &AppHandle) {
    if let Err(e) = speedwave_runtime::config::check_llm_egress_policy_at_boot() {
        log::error!("the organisation's policy changed and cannot be applied: {e}");
        let _ = app.emit(POLICY_CHANGED_EVENT, Some(e.to_string()));
        return;
    }
    log::info!("the organisation's policy changed: applying it");
    speedwave_runtime::management::refresh_inventory();
    let _ = app.emit(POLICY_CHANGED_EVENT, None::<String>);
    let Some(project) = running_project() else {
        return;
    };
    let oauth = app.state::<crate::reconcile::SharedOauth>().inner().clone();
    if let Err(e) =
        crate::integrations_cmd::restart_project_containers(project.clone(), None, oauth)
    {
        log::error!("project '{project}' not restarted under the changed policy: {e}");
    }
}

fn running_project() -> Option<String> {
    let project = speedwave_runtime::config::load_user_config()
        .ok()?
        .active_project?;
    let rt = speedwave_runtime::runtime::detect_runtime();
    let running = rt.is_available() && !rt.compose_ps(&project).ok()?.is_empty();
    running.then_some(project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn event(paths: &[&str]) -> notify::Result<Event> {
        Ok(Event {
            kind: notify::EventKind::Any,
            paths: paths.iter().map(PathBuf::from).collect(),
            attrs: Default::default(),
        })
    }

    #[test]
    fn reacts_only_to_the_policy_file() {
        let file = Path::new("/Library/Application Support/Speedwave/managed-config.json");
        assert!(touches(
            &event(&["/Library/Application Support/Speedwave/managed-config.json"]),
            file
        ));
        assert!(touches(
            &event(&[
                "/Library/Application Support/Speedwave/.managed-config.json.tmp",
                "/Library/Application Support/Speedwave/managed-config.json"
            ]),
            file
        ));
        assert!(!touches(
            &event(&["/Library/Application Support/Speedwave/other.json"]),
            file
        ));
        assert!(!touches(&Err(notify::Error::generic("x")), file));
    }
}
