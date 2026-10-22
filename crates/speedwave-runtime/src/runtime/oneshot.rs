//! One-shot containers (`nerdctl run --rm`): the spec, its hardened argv and the run-then-reap
//! wrapper both platform runtimes share.

use crate::consts;
use crate::resources::ContainerResources;
use std::path::PathBuf;
use std::time::Duration;

/// Network a one-shot container joins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OneshotNetwork {
    /// The engine's default bridge (outbound internet).
    Bridge,
    /// No network at all.
    None,
}

/// A host directory bind-mounted into a one-shot container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OneshotMount {
    /// Host path; translated with `engine_path::to_engine_path`.
    pub host: PathBuf,
    /// Absolute path inside the container.
    pub target: String,
    /// Mount read-only.
    pub read_only: bool,
}

/// A container that runs one command and is removed when it exits. Hardening is not optional:
/// every run is `--read-only`, `--cap-drop ALL`, `no-new-privileges`, unprivileged user, a
/// `noexec` `/tmp` tmpfs and the memory/CPU limits of `resources`.
#[derive(Debug, Clone, PartialEq)]
pub struct OneshotSpec {
    /// Container name, used to reap the container if the run is cut short.
    pub name: String,
    /// Image reference.
    pub image: String,
    /// Command and arguments.
    pub argv: Vec<String>,
    /// Working directory inside the container.
    pub workdir: Option<String>,
    /// Bind mounts.
    pub mounts: Vec<OneshotMount>,
    /// Environment variables.
    pub env: Vec<(String, String)>,
    /// Network.
    pub network: OneshotNetwork,
    /// Memory, CPU and `/tmp` limits.
    pub resources: ContainerResources,
    /// Deadline of the whole run.
    pub timeout: Duration,
}

impl OneshotSpec {
    /// A spec with a fresh `spw-oneshot-<uuid>` name, no mounts, env or workdir, on the bridge.
    pub fn new(
        image: &str,
        argv: &[&str],
        resources: ContainerResources,
        timeout: Duration,
    ) -> Self {
        Self {
            name: format!("spw-oneshot-{}", uuid::Uuid::new_v4().simple()),
            image: image.to_string(),
            argv: argv.iter().map(|a| a.to_string()).collect(),
            workdir: None,
            mounts: Vec::new(),
            env: Vec::new(),
            network: OneshotNetwork::Bridge,
            resources,
            timeout,
        }
    }

    /// The `nerdctl` arguments (after the binary) of this run, validated: no control characters
    /// and no `$` anywhere (the WSL transport re-parses the line), absolute container paths, and
    /// mount sources without `:`.
    pub(crate) fn nerdctl_run_args(&self) -> anyhow::Result<Vec<String>> {
        self.validate()?;
        let mut args: Vec<String> = [
            "run",
            "--rm",
            "--name",
            &self.name,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            consts::CONTAINER_USER_UNPRIVILEGED,
            "--network",
            match self.network {
                OneshotNetwork::Bridge => "bridge",
                OneshotNetwork::None => "none",
            },
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        args.extend([
            "--memory".to_string(),
            format!("{}m", self.resources.mem_mib),
            "--cpus".to_string(),
            self.resources.cpus.to_string(),
            "--tmpfs".to_string(),
            format!("/tmp:rw,noexec,nosuid,size={}m", self.resources.tmpfs_mib),
        ]);
        for mount in &self.mounts {
            let source = crate::engine_path::to_engine_path(&mount.host)?;
            check_text("mount source", &source)?;
            if source.contains(':') || source.contains(',') {
                anyhow::bail!("one-shot mount source {source:?} must not contain ':' or ','");
            }
            let mode = if mount.read_only { "ro" } else { "rw" };
            args.push("-v".to_string());
            args.push(format!("{source}:{}:{mode}", mount.target));
        }
        if let Some(workdir) = &self.workdir {
            args.push("-w".to_string());
            args.push(workdir.clone());
        }
        for (key, value) in &self.env {
            args.push("-e".to_string());
            args.push(format!("{key}={value}"));
        }
        args.push(self.image.clone());
        args.extend(self.argv.iter().cloned());
        Ok(args)
    }

    fn validate(&self) -> anyhow::Result<()> {
        let name_ok = !self.name.is_empty()
            && self.name.len() <= 63
            && self
                .name
                .starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && self
                .name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b));
        if !name_ok {
            anyhow::bail!("one-shot container name {:?} is invalid", self.name);
        }
        if self.image.is_empty()
            || self.image.starts_with('-')
            || self.image.contains(char::is_whitespace)
        {
            anyhow::bail!("one-shot image {:?} is invalid", self.image);
        }
        check_text("image", &self.image)?;
        if self.argv.is_empty() {
            anyhow::bail!("one-shot container needs a command");
        }
        for arg in &self.argv {
            check_text("argument", arg)?;
        }
        if self.timeout.is_zero() {
            anyhow::bail!("one-shot container needs a deadline");
        }
        for target in self
            .mounts
            .iter()
            .map(|m| m.target.as_str())
            .chain(self.workdir.as_deref())
        {
            check_text("container path", target)?;
            if !target.starts_with('/') || target.contains(':') || target.contains(',') {
                anyhow::bail!(
                    "one-shot container path {target:?} must be absolute without ':' or ','"
                );
            }
        }
        for (key, value) in &self.env {
            let key_ok = key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
            if !key_ok {
                anyhow::bail!("one-shot env name {key:?} is invalid");
            }
            check_text("env value", value)?;
        }
        Ok(())
    }
}

fn check_text(what: &str, value: &str) -> anyhow::Result<()> {
    if value.contains('$') || value.chars().any(char::is_control) {
        anyhow::bail!("one-shot {what} {value:?} must not contain '$' or control characters");
    }
    Ok(())
}

/// Runs `nerdctl <args>` through `run` (the platform transport, bounded by the spec's
/// deadline); when the run fails or times out, force-removes the container by name so a client
/// killed at the deadline leaves nothing behind. Returns the command's stdout.
pub(crate) fn run_and_reap(
    spec: &OneshotSpec,
    run: &dyn Fn(&[String], Duration) -> anyhow::Result<String>,
) -> anyhow::Result<String> {
    let args = spec.nerdctl_run_args()?;
    match run(&args, spec.timeout) {
        Ok(stdout) => Ok(stdout),
        Err(e) => {
            let reap = ["rm".to_string(), "-f".to_string(), spec.name.clone()];
            if let Err(reap_err) = run(&reap, consts::CONTAINER_EXEC_PROBE_TIMEOUT) {
                log::debug!(
                    "one-shot container {} left nothing to remove: {reap_err}",
                    spec.name
                );
            }
            Err(e.context(format!("one-shot container from {} failed", spec.image)))
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    pub(crate) fn sample_spec() -> OneshotSpec {
        let mut spec = OneshotSpec::new(
            "node:24@sha256:abc",
            &["npm", "install", "--before=2026-10-01T00:00:00.000Z"],
            crate::resources::CUSTOM_MCP_RESOLVER_RESOURCES,
            Duration::from_secs(600),
        );
        spec.name = "spw-oneshot-test".into();
        spec.workdir = Some("/out".into());
        spec.mounts.push(OneshotMount {
            host: std::env::temp_dir().join("spw-oneshot-build"),
            target: "/out".into(),
            read_only: false,
        });
        spec.env.push(("HOME".into(), "/tmp".into()));
        spec
    }

    #[test]
    fn argv_carries_the_full_hardening_block() {
        let args = sample_spec().nerdctl_run_args().unwrap();
        let expected_mount = format!(
            "{}:/out:rw",
            crate::engine_path::to_engine_path(&std::env::temp_dir().join("spw-oneshot-build"))
                .unwrap()
        );
        let expected: Vec<String> = [
            "run",
            "--rm",
            "--name",
            "spw-oneshot-test",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            consts::CONTAINER_USER_UNPRIVILEGED,
            "--network",
            "bridge",
            "--memory",
            "1024m",
            "--cpus",
            "1",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,size=512m",
            "-v",
            &expected_mount,
            "-w",
            "/out",
            "-e",
            "HOME=/tmp",
            "node:24@sha256:abc",
            "npm",
            "install",
            "--before=2026-10-01T00:00:00.000Z",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(args, expected);
    }

    #[test]
    fn read_only_mounts_and_no_network_are_rendered() {
        let mut spec = sample_spec();
        spec.mounts[0].read_only = true;
        spec.network = OneshotNetwork::None;
        let args = spec.nerdctl_run_args().unwrap();
        assert!(args.iter().any(|a| a.ends_with(":/out:ro")));
        let net = args.iter().position(|a| a == "--network").unwrap();
        assert_eq!(args[net + 1], "none");
    }

    #[test]
    fn fresh_specs_get_unique_valid_names() {
        let a = OneshotSpec::new(
            "img",
            &["true"],
            crate::resources::PROXY_RESOURCES,
            Duration::from_secs(1),
        );
        let b = OneshotSpec::new(
            "img",
            &["true"],
            crate::resources::PROXY_RESOURCES,
            Duration::from_secs(1),
        );
        assert_ne!(a.name, b.name);
        assert!(a.name.starts_with("spw-oneshot-"));
        assert!(a.nerdctl_run_args().is_ok());
    }

    type Mutation = Box<dyn Fn(&mut OneshotSpec)>;

    #[test]
    fn unsafe_specs_are_rejected_before_anything_runs() {
        let cases: Vec<(&str, Mutation)> = vec![
            ("dollar arg", Box::new(|s| s.argv.push("$(id)".into()))),
            ("newline arg", Box::new(|s| s.argv.push("a\nb".into()))),
            ("empty argv", Box::new(|s| s.argv.clear())),
            (
                "dollar env",
                Box::new(|s| s.env.push(("X".into(), "${HOME}".into()))),
            ),
            (
                "bad env key",
                Box::new(|s| s.env.push(("1X".into(), "v".into()))),
            ),
            (
                "env key with =",
                Box::new(|s| s.env.push(("A=B".into(), "v".into()))),
            ),
            (
                "relative target",
                Box::new(|s| s.mounts[0].target = "out".into()),
            ),
            (
                "colon target",
                Box::new(|s| s.mounts[0].target = "/out:ro".into()),
            ),
            (
                "comma target",
                Box::new(|s| s.mounts[0].target = "/o,ut".into()),
            ),
            (
                "colon source",
                Box::new(|s| s.mounts[0].host = PathBuf::from("/data/a:b")),
            ),
            (
                "relative workdir",
                Box::new(|s| s.workdir = Some("out".into())),
            ),
            ("bad name", Box::new(|s| s.name = "Spw".into())),
            ("long name", Box::new(|s| s.name = "a".repeat(64))),
            ("flag image", Box::new(|s| s.image = "--privileged".into())),
            ("spaced image", Box::new(|s| s.image = "a b".into())),
            ("empty image", Box::new(|s| s.image = String::new())),
            ("zero timeout", Box::new(|s| s.timeout = Duration::ZERO)),
        ];
        for (what, mutate) in cases {
            let mut spec = sample_spec();
            mutate(&mut spec);
            let calls = Mutex::new(0);
            let result = run_and_reap(&spec, &|_, _| {
                *calls.lock().unwrap() += 1;
                Ok(String::new())
            });
            assert!(result.is_err(), "{what} must be rejected");
            assert_eq!(*calls.lock().unwrap(), 0, "{what} must not run anything");
        }
    }

    #[test]
    fn a_successful_run_is_not_reaped() {
        let spec = sample_spec();
        let calls: Mutex<Vec<(Vec<String>, Duration)>> = Mutex::new(Vec::new());
        let out = run_and_reap(&spec, &|args, t| {
            calls.lock().unwrap().push((args.to_vec(), t));
            Ok("done".into())
        })
        .unwrap();
        assert_eq!(out, "done");
        let calls = calls.into_inner().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1, Duration::from_secs(600));
    }

    #[test]
    fn a_failed_or_timed_out_run_is_reaped_by_name_and_reports_the_cause() {
        let spec = sample_spec();
        let calls: Mutex<Vec<(Vec<String>, Duration)>> = Mutex::new(Vec::new());
        let err = run_and_reap(&spec, &|args, t| {
            calls.lock().unwrap().push((args.to_vec(), t));
            if args[0] == "run" {
                anyhow::bail!("command 'limactl' timed out after 600s")
            }
            anyhow::bail!("no such container")
        })
        .unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("timed out after 600s"), "{text}");
        assert!(text.contains("node:24@sha256:abc"), "{text}");
        let calls = calls.into_inner().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].0, vec!["rm", "-f", "spw-oneshot-test"]);
        assert_eq!(calls[1].1, consts::CONTAINER_EXEC_PROBE_TIMEOUT);
    }
}
