//! Mock-runtime builder for `LockedRuntime`. Single entry point for tests —
//! `ContainerRuntime` is `pub(crate)`, so this is the only legal way for
//! downstream crates to build a mock. Gated behind feature `test-support`.
#![expect(
    clippy::unwrap_used,
    reason = "test-support builder/mock: unwrap on locked test fixtures is sound"
)]

use super::{ContainerRuntime, LockedRuntime, VmExecOutput};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// Recorded `remove_images` call args: `(tags, force)`.
type RemoveImagesCall = (Vec<String>, bool);

/// Shared introspection handles cloned into the mock before wrapping.
#[derive(Clone, Default)]
pub struct MockHandles {
    /// Recorded `compose_up` project args.
    pub up_calls: Arc<Mutex<Vec<String>>>,
    /// Recorded `compose_down` project args.
    pub down_calls: Arc<Mutex<Vec<String>>>,
    /// Recorded `compose_up_recreate` project args.
    pub recreate_calls: Arc<Mutex<Vec<String>>>,
    /// Recorded `compose_up_service` (project, service) args.
    pub up_service_calls: Arc<Mutex<Vec<(String, String)>>>,
    /// Recorded `compose_ps` project args.
    pub ps_calls: Arc<Mutex<Vec<String>>>,
    /// Recorded `compose_logs` project args.
    pub logs_calls: Arc<Mutex<Vec<String>>>,
    /// Recorded `compose_validate` project args.
    pub validate_calls: Arc<Mutex<Vec<String>>>,
    /// Recorded `build_image` calls.
    pub build_calls: Arc<Mutex<Vec<BuildCall>>>,
    /// Recorded container exec calls.
    pub exec_calls: Arc<Mutex<Vec<ExecCall>>>,
    /// Count of `ensure_ready` calls.
    pub ensure_ready_calls: Arc<AtomicUsize>,
    /// Recorded `vm_exec` calls.
    pub vm_exec_calls: Arc<Mutex<Vec<VmExecCall>>>,
    /// Recorded `remove_images` calls (tags, force).
    pub remove_images_calls: Arc<Mutex<Vec<RemoveImagesCall>>>,
    /// Recorded prune calls by kind.
    pub prune_calls: Arc<Mutex<Vec<&'static str>>>,
    /// Count of `restart_container_engine` calls.
    pub restart_engine_calls: Arc<AtomicUsize>,
    /// Count of `stop_vm` calls.
    pub stop_vm_calls: Arc<AtomicUsize>,
    /// Count of `reset_vm` calls.
    pub reset_vm_calls: Arc<AtomicUsize>,
    /// Whether `prepare_build_context` was called.
    pub prepare_build_context_calls: Arc<AtomicBool>,
}

/// Recorded arguments of a `build_image` call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildCall {
    /// Image tag.
    pub tag: String,
    /// Build context directory.
    pub context_dir: String,
    /// Containerfile path.
    pub containerfile: String,
    /// Build args passed.
    pub build_args: Vec<(String, String)>,
}

/// Recorded arguments of a container exec call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecCall {
    /// Target container.
    pub container: String,
    /// Command argv.
    pub argv: Vec<String>,
}

/// Recorded arguments of a `vm_exec` call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmExecCall {
    /// Command executed.
    pub cmd: String,
    /// Command args.
    pub args: Vec<String>,
}

impl MockHandles {
    /// Projects passed to `compose_up`.
    pub fn up_projects(&self) -> Vec<String> {
        self.up_calls.lock().unwrap().clone()
    }
    /// Projects passed to `compose_down`.
    pub fn down_projects(&self) -> Vec<String> {
        self.down_calls.lock().unwrap().clone()
    }
    /// Projects passed to `compose_ps`, in call order.
    pub fn ps_projects(&self) -> Vec<String> {
        self.ps_calls.lock().unwrap().clone()
    }
    /// Tags passed to `build_image`.
    pub fn build_tags(&self) -> Vec<String> {
        self.build_calls
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.tag.clone())
            .collect()
    }
    /// Number of `build_image` calls.
    pub fn build_call_count(&self) -> usize {
        self.build_calls.lock().unwrap().len()
    }
    /// `true` if `tag` was built.
    pub fn was_built(&self, tag: &str) -> bool {
        self.build_calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c.tag == tag)
    }
    /// Number of `ensure_ready` calls.
    pub fn ensure_ready_count(&self) -> usize {
        self.ensure_ready_calls.load(Ordering::SeqCst)
    }
    /// `true` if any project was recreated.
    pub fn was_recreated(&self) -> bool {
        !self.recreate_calls.lock().unwrap().is_empty()
    }
    /// Number of `reset_vm` calls.
    pub fn reset_vm_count(&self) -> usize {
        self.reset_vm_calls.load(Ordering::SeqCst)
    }
}

/// Builder for a fully-configurable mock runtime.
pub struct MockRuntimeBuilder {
    handles: MockHandles,
    is_available: bool,
    ensure_ready_result: ResultCell,
    fail_on_up: HashSet<String>,
    fail_on_down: HashSet<String>,
    fail_on_recreate: HashSet<String>,
    ps_responses: HashMap<String, Vec<Value>>,
    ps_error: Option<String>,
    logs_response: String,
    logs_error: Option<String>,
    container_logs_response: String,
    image_exists: Arc<Mutex<HashMap<String, bool>>>,
    image_exists_default: bool,
    image_missing_substrings: Vec<String>,
    image_exists_error: Option<String>,
    build_image_result: BuildResult,
    build_attempt_errors: HashMap<(String, u32), String>,
    build_attempts: AttemptCounter,
    build_panic_substrings: Vec<String>,
    container_exec_program: String,
    exec_piped_script: Option<String>,
    exec_piped_error: Option<String>,
    exec_piped_failure_queue: Arc<Mutex<Vec<String>>>,
    validate_script: Arc<Mutex<Vec<Result<(), String>>>>,
    validate_default: Result<(), String>,
    vm_exec_responses: HashMap<String, anyhow::Result<VmExecOutput>>,
    reset_vm_result: Result<(), String>,
    stop_vm_result: Result<(), String>,
    restart_engine_result: Result<(), String>,
    buildkit_prune_result: Result<(), String>,
    remove_images_result: Result<(), String>,
    prepare_build_context_root: Option<std::path::PathBuf>,
}

#[derive(Clone)]
enum ResultCell {
    Ok,
    Err(String),
}

#[derive(Clone)]
enum BuildResult {
    Ok,
    ErrPerTag(HashMap<String, String>),
    AllErr(String),
}

/// Per-tag build attempt counter. Keyed by image tag, value is the running
/// 1-based attempt count.
type AttemptCounter = Arc<Mutex<HashMap<String, u32>>>;

impl Default for MockRuntimeBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl MockRuntimeBuilder {
    /// Creates a builder with default (success) behaviour.
    pub fn new() -> Self {
        Self {
            handles: MockHandles::default(),
            is_available: true,
            ensure_ready_result: ResultCell::Ok,
            fail_on_up: HashSet::new(),
            fail_on_down: HashSet::new(),
            fail_on_recreate: HashSet::new(),
            ps_responses: HashMap::new(),
            ps_error: None,
            logs_response: String::new(),
            logs_error: None,
            container_logs_response: String::new(),
            image_exists: Arc::new(Mutex::new(HashMap::new())),
            image_exists_default: false,
            image_missing_substrings: Vec::new(),
            image_exists_error: None,
            build_image_result: BuildResult::Ok,
            build_attempt_errors: HashMap::new(),
            build_attempts: Arc::new(Mutex::new(HashMap::new())),
            build_panic_substrings: Vec::new(),
            container_exec_program: "true".to_string(),
            exec_piped_script: None,
            exec_piped_error: None,
            exec_piped_failure_queue: Arc::new(Mutex::new(Vec::new())),
            validate_script: Arc::new(Mutex::new(Vec::new())),
            validate_default: Ok(()),
            vm_exec_responses: HashMap::new(),
            reset_vm_result: Ok(()),
            stop_vm_result: Ok(()),
            restart_engine_result: Ok(()),
            buildkit_prune_result: Ok(()),
            remove_images_result: Ok(()),
            prepare_build_context_root: None,
        }
    }

    /// Clones the introspection handles for later assertions.
    pub fn handles(&self) -> MockHandles {
        self.handles.clone()
    }

    /// Makes `ensure_ready` fail with `msg`.
    pub fn with_ensure_ready_error(mut self, msg: &str) -> Self {
        self.ensure_ready_result = ResultCell::Err(msg.to_string());
        self
    }
    /// Sets the value returned by `is_available`.
    pub fn with_is_available(mut self, available: bool) -> Self {
        self.is_available = available;
        self
    }
    /// Makes `compose_up` fail for these projects.
    pub fn with_fail_on_up(mut self, projects: &[&str]) -> Self {
        self.fail_on_up = projects.iter().map(|s| s.to_string()).collect();
        self
    }
    /// Makes `compose_down` fail for these projects.
    pub fn with_fail_on_down(mut self, projects: &[&str]) -> Self {
        self.fail_on_down = projects.iter().map(|s| s.to_string()).collect();
        self
    }
    /// Makes `compose_up_recreate` fail for these projects.
    pub fn with_fail_on_recreate(mut self, projects: &[&str]) -> Self {
        self.fail_on_recreate = projects.iter().map(|s| s.to_string()).collect();
        self
    }
    /// Sets the `compose_ps` response for `project` (default: empty).
    pub fn with_ps_response(mut self, project: &str, containers: Vec<Value>) -> Self {
        self.ps_responses.insert(project.to_string(), containers);
        self
    }
    /// Makes every `compose_ps` call fail with `msg`.
    pub fn with_ps_error(mut self, msg: &str) -> Self {
        self.ps_error = Some(msg.to_string());
        self
    }
    /// Sets the exact `image_exists` result for `tag`.
    pub fn with_image_exists(self, tag: &str, exists: bool) -> Self {
        self.image_exists
            .lock()
            .unwrap()
            .insert(tag.to_string(), exists);
        self
    }
    /// Makes `image_exists` fail with `msg`.
    pub fn with_image_exists_error(mut self, msg: &str) -> Self {
        self.image_exists_error = Some(msg.to_string());
        self
    }
    /// Default value returned by `image_exists(tag)` when no exact-match
    /// override is set in the `image_exists` map and no
    /// `image_missing_substring` matches the tag. Default: `false`.
    pub fn with_image_exists_default(mut self, default: bool) -> Self {
        self.image_exists_default = default;
        self
    }
    /// Make `image_exists(tag)` return `false` whenever `tag` contains
    /// `substring`. Wins over `image_exists_default` but loses to an exact
    /// override set via `with_image_exists`.
    pub fn with_image_missing_substring(mut self, substring: &str) -> Self {
        self.image_missing_substrings.push(substring.to_string());
        self
    }
    /// Makes `build_image(tag)` fail with `msg`.
    pub fn with_build_error_for(mut self, tag: &str, msg: &str) -> Self {
        let map = match self.build_image_result {
            BuildResult::ErrPerTag(m) => m,
            _ => HashMap::new(),
        };
        let mut new_map = map;
        new_map.insert(tag.to_string(), msg.to_string());
        self.build_image_result = BuildResult::ErrPerTag(new_map);
        self
    }
    /// Makes every `build_image` fail with `msg`.
    pub fn with_all_builds_failing(mut self, msg: &str) -> Self {
        self.build_image_result = BuildResult::AllErr(msg.to_string());
        self
    }
    /// Fail `build_image(tag)` only on the given 1-based attempt count.
    /// Attempts are tracked per-tag — calling `build_image("a:1")` three times
    /// surfaces attempt numbers 1, 2, 3 for that tag.
    pub fn with_build_error_for_attempt(mut self, tag: &str, attempt: u32, msg: &str) -> Self {
        self.build_attempt_errors
            .insert((tag.to_string(), attempt), msg.to_string());
        self
    }
    /// Make `build_image` panic whenever the tag contains any of the given
    /// substrings. Used by tests that verify worker-thread panic propagation.
    pub fn with_build_panic_for(mut self, tag_substring: &str) -> Self {
        self.build_panic_substrings.push(tag_substring.to_string());
        self
    }
    /// Make `prune_buildkit_cache` return an error with the given message.
    pub fn with_prune_buildkit_error(mut self, msg: &str) -> Self {
        self.buildkit_prune_result = Err(msg.to_string());
        self
    }
    /// Make `remove_images` return an error with the given message.
    /// The call is still recorded in `handles.remove_images_calls` before failing.
    pub fn with_remove_images_error(mut self, msg: &str) -> Self {
        self.remove_images_result = Err(msg.to_string());
        self
    }
    /// Make `container_exec_piped` return a `Command` whose stdout is `script`.
    /// Used by tests that drive a real reader over the returned `Command`'s output.
    pub fn with_exec_piped_script(mut self, script: &str) -> Self {
        self.exec_piped_script = Some(script.to_string());
        self
    }
    /// Makes `container_exec_piped` fail with `msg`.
    pub fn with_exec_piped_error(mut self, msg: &str) -> Self {
        self.exec_piped_error = Some(msg.to_string());
        self
    }
    /// Push a scripted failing result for `container_exec_piped` (FIFO). The
    /// returned `Command` writes `stderr_msg` to stderr and exits non-zero;
    /// when the queue is empty it falls back to default success.
    pub fn push_exec_piped_failure(self, stderr_msg: &str) -> Self {
        self.exec_piped_failure_queue
            .lock()
            .unwrap()
            .push(stderr_msg.to_string());
        self
    }
    /// Push a `Result` to the compose_validate scripted queue. First call pops first item.
    pub fn push_validate_result(self, result: Result<(), String>) -> Self {
        self.validate_script.lock().unwrap().push(result);
        self
    }
    /// Makes `reset_vm` fail with `msg`.
    pub fn with_reset_vm_error(mut self, msg: &str) -> Self {
        self.reset_vm_result = Err(msg.to_string());
        self
    }
    /// Makes `stop_vm` fail with `msg`.
    pub fn with_stop_vm_error(mut self, msg: &str) -> Self {
        self.stop_vm_result = Err(msg.to_string());
        self
    }
    /// Sets the path `prepare_build_context` returns.
    pub fn with_prepare_build_context_root(mut self, root: std::path::PathBuf) -> Self {
        self.prepare_build_context_root = Some(root);
        self
    }

    /// Builds the mock and wraps it in `LockedRuntime`. Returns both — keep
    /// `handles` to inspect state after the runtime is consumed.
    pub fn build(self) -> (LockedRuntime, MockHandles) {
        let handles = self.handles.clone();
        let mock = MockRuntime {
            handles: self.handles,
            is_available: self.is_available,
            ensure_ready_result: self.ensure_ready_result,
            fail_on_up: self.fail_on_up,
            fail_on_down: self.fail_on_down,
            fail_on_recreate: self.fail_on_recreate,
            ps_responses: self.ps_responses,
            ps_error: self.ps_error,
            logs_response: self.logs_response,
            logs_error: self.logs_error,
            container_logs_response: self.container_logs_response,
            image_exists: self.image_exists,
            image_exists_default: self.image_exists_default,
            image_missing_substrings: self.image_missing_substrings,
            image_exists_error: self.image_exists_error,
            build_image_result: self.build_image_result,
            build_attempt_errors: self.build_attempt_errors,
            build_attempts: self.build_attempts,
            build_panic_substrings: self.build_panic_substrings,
            container_exec_program: self.container_exec_program,
            exec_piped_script: self.exec_piped_script,
            exec_piped_error: self.exec_piped_error,
            exec_piped_failure_queue: self.exec_piped_failure_queue,
            validate_script: self.validate_script,
            validate_default: self.validate_default,
            vm_exec_responses: self.vm_exec_responses,
            reset_vm_result: self.reset_vm_result,
            stop_vm_result: self.stop_vm_result,
            restart_engine_result: self.restart_engine_result,
            buildkit_prune_result: self.buildkit_prune_result,
            remove_images_result: self.remove_images_result,
            prepare_build_context_root: self.prepare_build_context_root,
        };
        (LockedRuntime::new(Box::new(mock)), handles)
    }
}

struct MockRuntime {
    handles: MockHandles,
    is_available: bool,
    ensure_ready_result: ResultCell,
    fail_on_up: HashSet<String>,
    fail_on_down: HashSet<String>,
    fail_on_recreate: HashSet<String>,
    ps_responses: HashMap<String, Vec<Value>>,
    ps_error: Option<String>,
    logs_response: String,
    logs_error: Option<String>,
    container_logs_response: String,
    image_exists: Arc<Mutex<HashMap<String, bool>>>,
    image_exists_default: bool,
    image_missing_substrings: Vec<String>,
    image_exists_error: Option<String>,
    build_image_result: BuildResult,
    build_attempt_errors: HashMap<(String, u32), String>,
    build_attempts: AttemptCounter,
    build_panic_substrings: Vec<String>,
    container_exec_program: String,
    exec_piped_script: Option<String>,
    exec_piped_error: Option<String>,
    exec_piped_failure_queue: Arc<Mutex<Vec<String>>>,
    validate_script: Arc<Mutex<Vec<Result<(), String>>>>,
    validate_default: Result<(), String>,
    vm_exec_responses: HashMap<String, anyhow::Result<VmExecOutput>>,
    reset_vm_result: Result<(), String>,
    stop_vm_result: Result<(), String>,
    restart_engine_result: Result<(), String>,
    buildkit_prune_result: Result<(), String>,
    remove_images_result: Result<(), String>,
    prepare_build_context_root: Option<std::path::PathBuf>,
}

impl ContainerRuntime for MockRuntime {
    fn compose_up(&self, project: &str) -> anyhow::Result<()> {
        self.handles
            .up_calls
            .lock()
            .unwrap()
            .push(project.to_string());
        if self.fail_on_up.contains(project) {
            anyhow::bail!("mock compose_up failure for '{project}'");
        }
        Ok(())
    }

    fn compose_down(&self, project: &str) -> anyhow::Result<()> {
        self.handles
            .down_calls
            .lock()
            .unwrap()
            .push(project.to_string());
        if self.fail_on_down.contains(project) {
            anyhow::bail!("mock compose_down failure for '{project}'");
        }
        Ok(())
    }

    fn compose_ps(&self, project: &str) -> anyhow::Result<Vec<Value>> {
        self.handles
            .ps_calls
            .lock()
            .unwrap()
            .push(project.to_string());
        if let Some(err) = &self.ps_error {
            anyhow::bail!("{err}");
        }
        Ok(self.ps_responses.get(project).cloned().unwrap_or_default())
    }

    fn container_exec(&self, container: &str, cmd: &[&str]) -> Command {
        self.handles.exec_calls.lock().unwrap().push(ExecCall {
            container: container.to_string(),
            argv: cmd.iter().map(|s| s.to_string()).collect(),
        });
        // SSOT-allow: test fixture spawn
        Command::new(&self.container_exec_program)
    }

    fn container_exec_piped(&self, container: &str, cmd: &[&str]) -> anyhow::Result<Command> {
        self.handles.exec_calls.lock().unwrap().push(ExecCall {
            container: container.to_string(),
            argv: cmd.iter().map(|s| s.to_string()).collect(),
        });
        if let Some(err) = &self.exec_piped_error {
            anyhow::bail!("{err}");
        }
        // FIFO failure queue: returns a Command that writes stderr and exits non-zero.
        let next_failure = {
            let mut q = self.exec_piped_failure_queue.lock().unwrap();
            if q.is_empty() {
                None
            } else {
                Some(q.remove(0))
            }
        };
        if let Some(msg) = next_failure {
            // SSOT-allow: test fixture spawn
            let mut c = Command::new("sh");
            c.env("SW_MOCK_EXEC_STDERR", msg)
                .args(["-c", "echo \"$SW_MOCK_EXEC_STDERR\" >&2; exit 1"]);
            return Ok(c);
        }
        if let Some(script) = &self.exec_piped_script {
            // SSOT-allow: test fixture spawn
            let mut c = Command::new("sh");
            c.env("SW_MOCK_EXEC_SCRIPT", script)
                .args(["-c", "printf '%s' \"$SW_MOCK_EXEC_SCRIPT\""]);
            return Ok(c);
        }
        // SSOT-allow: test fixture spawn
        Ok(Command::new(&self.container_exec_program))
    }

    fn is_available(&self) -> bool {
        self.is_available
    }

    fn ensure_ready(&self) -> anyhow::Result<()> {
        self.handles
            .ensure_ready_calls
            .fetch_add(1, Ordering::SeqCst);
        match &self.ensure_ready_result {
            ResultCell::Ok => Ok(()),
            ResultCell::Err(e) => anyhow::bail!("{e}"),
        }
    }

    fn build_image(
        &self,
        tag: &str,
        context_dir: &str,
        containerfile: &str,
        build_args: &[(&str, &str)],
    ) -> anyhow::Result<()> {
        // Panic before recording so panicking calls do not show up in `build_calls`.
        for needle in &self.build_panic_substrings {
            if tag.contains(needle.as_str()) {
                panic!("mock build_image panic for tag containing {needle:?}");
            }
        }
        self.handles.build_calls.lock().unwrap().push(BuildCall {
            tag: tag.to_string(),
            context_dir: context_dir.to_string(),
            containerfile: containerfile.to_string(),
            build_args: build_args
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        });
        let attempt = {
            let mut counters = self.build_attempts.lock().unwrap();
            let entry = counters.entry(tag.to_string()).or_insert(0);
            *entry += 1;
            *entry
        };
        // Per-attempt override beats the global tag/all-err result.
        let outcome = if let Some(msg) = self.build_attempt_errors.get(&(tag.to_string(), attempt))
        {
            Err(msg.clone())
        } else {
            match &self.build_image_result {
                BuildResult::Ok => Ok(()),
                BuildResult::AllErr(msg) => Err(msg.clone()),
                BuildResult::ErrPerTag(map) => match map.get(tag) {
                    Some(msg) => Err(msg.clone()),
                    None => Ok(()),
                },
            }
        };
        match outcome {
            Ok(()) => {
                // Mirror real-runtime semantics: a successful build makes the tag exist.
                self.image_exists
                    .lock()
                    .unwrap()
                    .insert(tag.to_string(), true);
                Ok(())
            }
            Err(msg) => anyhow::bail!("{msg}"),
        }
    }

    fn prepare_build_context(
        &self,
        build_root: &std::path::Path,
    ) -> anyhow::Result<std::path::PathBuf> {
        self.handles
            .prepare_build_context_calls
            .store(true, Ordering::SeqCst);
        Ok(self
            .prepare_build_context_root
            .clone()
            .unwrap_or_else(|| build_root.to_path_buf()))
    }

    fn container_logs(&self, container: &str, _tail: u32) -> anyhow::Result<String> {
        self.handles
            .logs_calls
            .lock()
            .unwrap()
            .push(container.to_string());
        Ok(self.container_logs_response.clone())
    }

    fn compose_logs(&self, project: &str, _tail: u32) -> anyhow::Result<String> {
        self.handles
            .logs_calls
            .lock()
            .unwrap()
            .push(project.to_string());
        if let Some(err) = &self.logs_error {
            anyhow::bail!("{err}");
        }
        Ok(self.logs_response.clone())
    }

    fn image_exists(&self, tag: &str) -> anyhow::Result<bool> {
        if let Some(err) = &self.image_exists_error {
            anyhow::bail!("{err}");
        }
        // Exact-match override wins; then substring "missing" rule; then default.
        if let Some(v) = self.image_exists.lock().unwrap().get(tag).copied() {
            return Ok(v);
        }
        if self
            .image_missing_substrings
            .iter()
            .any(|s| tag.contains(s.as_str()))
        {
            return Ok(false);
        }
        Ok(self.image_exists_default)
    }

    fn compose_up_recreate(&self, project: &str) -> anyhow::Result<()> {
        self.handles
            .recreate_calls
            .lock()
            .unwrap()
            .push(project.to_string());
        if self.fail_on_recreate.contains(project) {
            anyhow::bail!("mock compose_up_recreate failure for '{project}'");
        }
        Ok(())
    }

    fn compose_up_service(&self, project: &str, service: &str) -> anyhow::Result<()> {
        super::validate_builtin_service_name(service)?;
        self.handles
            .up_service_calls
            .lock()
            .unwrap()
            .push((project.to_string(), service.to_string()));
        Ok(())
    }

    fn compose_validate(&self, project: &str) -> anyhow::Result<()> {
        self.handles
            .validate_calls
            .lock()
            .unwrap()
            .push(project.to_string());
        let next = {
            let mut q = self.validate_script.lock().unwrap();
            if q.is_empty() {
                None
            } else {
                Some(q.remove(0))
            }
        };
        match next.unwrap_or_else(|| self.validate_default.clone()) {
            Ok(()) => Ok(()),
            Err(e) => anyhow::bail!("{e}"),
        }
    }

    fn remove_images(&self, tags: &[String], force: bool) -> anyhow::Result<()> {
        self.handles
            .remove_images_calls
            .lock()
            .unwrap()
            .push((tags.to_vec(), force));
        match &self.remove_images_result {
            Ok(()) => Ok(()),
            Err(e) => anyhow::bail!("{e}"),
        }
    }

    fn system_prune(&self) -> anyhow::Result<()> {
        self.handles.prune_calls.lock().unwrap().push("system");
        Ok(())
    }

    fn prune_buildkit_cache(&self) -> anyhow::Result<()> {
        self.handles.prune_calls.lock().unwrap().push("buildkit");
        match &self.buildkit_prune_result {
            Ok(()) => Ok(()),
            Err(e) => anyhow::bail!("{e}"),
        }
    }

    fn prune_unused_images(&self) -> anyhow::Result<()> {
        self.handles.prune_calls.lock().unwrap().push("unused");
        Ok(())
    }

    fn restart_container_engine(&self) -> anyhow::Result<()> {
        self.handles
            .restart_engine_calls
            .fetch_add(1, Ordering::SeqCst);
        match &self.restart_engine_result {
            Ok(()) => Ok(()),
            Err(e) => anyhow::bail!("{e}"),
        }
    }

    fn stop_vm(&self) -> anyhow::Result<()> {
        self.handles.stop_vm_calls.fetch_add(1, Ordering::SeqCst);
        match &self.stop_vm_result {
            Ok(()) => Ok(()),
            Err(e) => anyhow::bail!("{e}"),
        }
    }

    fn reset_vm(&self) -> anyhow::Result<()> {
        self.handles.reset_vm_calls.fetch_add(1, Ordering::SeqCst);
        match &self.reset_vm_result {
            Ok(()) => Ok(()),
            Err(e) => anyhow::bail!("{e}"),
        }
    }

    fn vm_exec(
        &self,
        cmd: &str,
        args: &[&str],
        _stdin: &[u8],
        _timeout: std::time::Duration,
    ) -> anyhow::Result<VmExecOutput> {
        self.handles.vm_exec_calls.lock().unwrap().push(VmExecCall {
            cmd: cmd.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
        });
        let key = format!("{} {}", cmd, args.join(" "));
        match self.vm_exec_responses.get(&key) {
            Some(Ok(v)) => Ok(VmExecOutput {
                status: v.status,
                stdout: v.stdout.clone(),
                stderr: v.stderr.clone(),
            }),
            Some(Err(e)) => anyhow::bail!("{e}"),
            None => anyhow::bail!("mock vm_exec: no response configured for '{key}'"),
        }
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code asserts via unwrap")]
mod tests {
    use super::*;

    #[test]
    fn default_builder_returns_passthrough_runtime() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        assert!(rt.is_available());
        assert!(rt.ensure_ready().is_ok());
        assert!(rt.compose_up("p").is_ok());
        assert_eq!(handles.up_projects(), vec!["p"]);
    }

    #[test]
    fn fail_on_down_propagates() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_fail_on_down(&["broken"])
            .build();
        assert!(rt.compose_down("broken").is_err());
        assert!(rt.compose_down("ok").is_ok());
        assert_eq!(handles.down_projects(), vec!["broken", "ok"]);
    }

    #[test]
    fn ensure_ready_error_propagates() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_ensure_ready_error("vm not ready")
            .build();
        let err = rt.ensure_ready().unwrap_err();
        assert!(err.to_string().contains("vm not ready"));
        assert_eq!(handles.ensure_ready_count(), 1);
    }

    #[test]
    fn validate_script_consumes_in_fifo_order() {
        // First push -> first pop. Matches push_exec_piped_failure semantics.
        let (rt, _) = MockRuntimeBuilder::new()
            .push_validate_result(Err("propagation lag".to_string()))
            .push_validate_result(Ok(()))
            .build();
        assert!(rt.compose_validate("p").is_err());
        assert!(rt.compose_validate("p").is_ok());
    }

    #[test]
    fn build_image_per_tag_error() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_build_error_for("broken:latest", "kaboom")
            .build();
        assert!(rt.build_image("broken:latest", ".", "C", &[]).is_err());
        assert!(rt.build_image("ok:latest", ".", "C", &[]).is_ok());
        assert!(handles.was_built("broken:latest"));
        assert!(handles.was_built("ok:latest"));
    }

    #[test]
    fn image_exists_default_false_and_overrides() {
        let (rt, _) = MockRuntimeBuilder::new()
            .with_image_exists("present:1", true)
            .build();
        assert!(rt.image_exists("present:1").unwrap());
        assert!(!rt.image_exists("absent:1").unwrap());
    }

    #[test]
    fn reset_vm_error_recorded_and_counted() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_reset_vm_error("wsl --unregister failed")
            .build();
        let err = rt.reset_vm().unwrap_err();
        assert!(err.to_string().contains("wsl --unregister failed"));
        assert_eq!(handles.reset_vm_count(), 1);
    }

    #[test]
    fn successful_build_makes_image_exist_next_call() {
        // Mirrors real-runtime semantics: image_exists returns true after a successful build.
        let (rt, handles) = MockRuntimeBuilder::new().build();
        assert!(!rt.image_exists("fresh:1").unwrap());
        rt.build_image("fresh:1", ".", "C", &[]).unwrap();
        assert!(rt.image_exists("fresh:1").unwrap());
        assert!(handles.was_built("fresh:1"));
    }

    #[test]
    fn failed_build_does_not_make_image_exist() {
        let (rt, _) = MockRuntimeBuilder::new()
            .with_all_builds_failing("boom")
            .build();
        assert!(rt.build_image("never:1", ".", "C", &[]).is_err());
        assert!(!rt.image_exists("never:1").unwrap());
    }

    #[test]
    fn remove_images_records_call_then_returns_configured_error() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_remove_images_error("simulated rmi failure")
            .build();
        let err = rt.remove_images(&["img:1".to_string()], true).unwrap_err();
        assert!(err.to_string().contains("simulated rmi failure"));
        let calls = handles.remove_images_calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, vec!["img:1".to_string()]);
        assert!(calls[0].1);
    }

    #[test]
    fn exec_piped_script_emits_payload_on_stdout() {
        use std::io::Read;
        use std::process::Stdio;
        let payload = "line one\nline two\n";
        let (rt, _) = MockRuntimeBuilder::new()
            .with_exec_piped_script(payload)
            .build();
        let mut cmd = rt.container_exec_piped("c", &["echo"]).unwrap();
        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut out = String::new();
        child
            .stdout
            .as_mut()
            .unwrap()
            .read_to_string(&mut out)
            .unwrap();
        let _ = child.wait();
        assert_eq!(out, payload);
    }

    #[test]
    fn exec_piped_failure_queue_consumes_in_fifo_then_falls_back() {
        let (rt, _) = MockRuntimeBuilder::new()
            .push_exec_piped_failure("first failure stderr")
            .push_exec_piped_failure("second failure stderr")
            .build();
        // First call: returns Command that fails with the first message.
        let out1 = rt
            .container_exec_piped("c", &["true"])
            .unwrap()
            .output()
            .unwrap();
        assert!(!out1.status.success());
        assert!(String::from_utf8_lossy(&out1.stderr).contains("first failure stderr"));
        // Second call: pops the second entry.
        let out2 = rt
            .container_exec_piped("c", &["true"])
            .unwrap()
            .output()
            .unwrap();
        assert!(!out2.status.success());
        assert!(String::from_utf8_lossy(&out2.stderr).contains("second failure stderr"));
        // Third call: queue drained, falls back to default success.
        let out3 = rt
            .container_exec_piped("c", &["true"])
            .unwrap()
            .output()
            .unwrap();
        assert!(out3.status.success());
    }
}
