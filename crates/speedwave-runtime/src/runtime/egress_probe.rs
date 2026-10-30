//! Post-start egress probe: after a full start, curls the host the project's LLM provider
//! uses from its claude container and logs a warning on a transport failure. Never blocks.

use super::LockedRuntime;
use crate::config::{self, AnthropicEvidence, LlmConfig, LlmProviderKind};
use crate::{binary, consts};
use std::path::Path;
use std::process::{Command, Stdio};

const ANTHROPIC_TARGET: &str = "https://api.anthropic.com";
const OPENROUTER_TARGET: &str = "https://openrouter.ai";

enum Outcome {
    Reachable,
    TransportFailure(String),
    Inconclusive(String),
}

pub(super) fn spawn_after_start(runtime: &LockedRuntime, data_dir: &Path, project: &str) {
    let Some(target) = probe_target(&project_llm(data_dir, project)) else {
        return;
    };
    let container = consts::claude_container_name(project);
    let argv = [
        "curl",
        "-sS",
        "-m",
        "10",
        "-o",
        "/dev/null",
        target.as_str(),
    ];
    let command = match runtime.container_exec_piped(&container, &argv) {
        Ok(command) => command,
        Err(e) => {
            log::debug!("could not start the egress check of {container}: {e}");
            return;
        }
    };
    let thread_container = container.clone();
    let spawned = std::thread::Builder::new()
        .name("egress-probe".to_string())
        .spawn(move || report(&thread_container, &target, run_probe(command)));
    if let Err(e) = spawned {
        log::debug!("could not start the egress check of {container}: {e}");
    }
}

fn project_llm(data_dir: &Path, project: &str) -> LlmConfig {
    let user = config::load_user_config_from(&data_dir.join("config.json")).unwrap_or_else(|e| {
        log::debug!("egress check found no readable user config: {e}");
        Default::default()
    });
    let mut llm = user
        .find_project(project)
        .and_then(|entry| entry.claude.as_ref())
        .and_then(|claude| claude.llm.clone())
        .unwrap_or_default();
    config::migrate_llm(&mut llm, AnthropicEvidence::detect_in(data_dir, project));
    llm
}

fn probe_target(llm: &LlmConfig) -> Option<String> {
    let provider = llm.active_provider()?;
    match provider.kind {
        kind if kind.is_anthropic() => Some(ANTHROPIC_TARGET.to_string()),
        LlmProviderKind::OpenRouter => Some(OPENROUTER_TARGET.to_string()),
        _ => provider.base_url.as_deref().and_then(external_base_url),
    }
}

fn external_base_url(base_url: &str) -> Option<String> {
    let parsed = url::Url::parse(base_url).ok()?;
    let reachable_over_forward = matches!(parsed.scheme(), "http" | "https")
        && parsed
            .host_str()
            .is_some_and(|host| host != consts::HOST_GATEWAY_ALIAS);
    reachable_over_forward.then(|| parsed.to_string())
}

fn run_probe(mut command: Command) -> Outcome {
    command.stdin(Stdio::null());
    match binary::run_with_timeout_capture(&mut command, consts::CONTAINER_EXEC_PROBE_TIMEOUT) {
        Ok(output) if output.status.success() => Outcome::Reachable,
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            match stderr.lines().find(|line| line.starts_with("curl: (")) {
                Some(curl_error) => Outcome::TransportFailure(curl_error.to_string()),
                None => Outcome::Inconclusive(stderr.trim().to_string()),
            }
        }
        Err(e) => Outcome::Inconclusive(e.to_string()),
    }
}

fn report(container: &str, target: &str, outcome: Outcome) {
    let host = url::Url::parse(target)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_else(|| target.to_string());
    match outcome {
        Outcome::Reachable => log::debug!("container {container} reaches {host}"),
        Outcome::TransportFailure(error) => log::warn!(
            "container {container} cannot reach {host}: {error}. On Windows, Docker running \
             in another WSL distribution can block container traffic"
        ),
        Outcome::Inconclusive(detail) => {
            log::debug!("egress check from {container} to {host} was inconclusive: {detail}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{LlmActive, LlmProviderEntry};

    fn llm_with(kind: LlmProviderKind, base_url: Option<&str>) -> LlmConfig {
        LlmConfig {
            schema_version: Some(config::LLM_SCHEMA_VERSION),
            providers: vec![LlmProviderEntry {
                id: "p".to_string(),
                kind,
                base_url: base_url.map(str::to_string),
                model: None,
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: Some(LlmActive {
                provider_id: "p".to_string(),
                model: None,
            }),
            ..Default::default()
        }
    }

    #[test]
    fn target_per_active_provider() {
        let cases = [
            (
                llm_with(LlmProviderKind::AnthropicOauth, None),
                Some("https://api.anthropic.com"),
            ),
            (
                llm_with(LlmProviderKind::AnthropicApiKey, None),
                Some("https://api.anthropic.com"),
            ),
            (
                llm_with(LlmProviderKind::OpenRouter, None),
                Some("https://openrouter.ai"),
            ),
            (
                llm_with(
                    LlmProviderKind::Local,
                    Some("https://llm.example.com:8443/v1"),
                ),
                Some("https://llm.example.com:8443/v1"),
            ),
            (
                llm_with(
                    LlmProviderKind::Local,
                    Some("http://host.docker.internal:1234"),
                ),
                None,
            ),
            (llm_with(LlmProviderKind::Local, None), None),
            (llm_with(LlmProviderKind::Local, Some("not a url")), None),
            (
                llm_with(LlmProviderKind::Local, Some("ftp://llm.example.com")),
                None,
            ),
            (LlmConfig::default(), None),
        ];
        for (llm, expected) in cases {
            assert_eq!(probe_target(&llm).as_deref(), expected);
        }
    }

    #[test]
    fn a_logged_out_project_has_no_target() {
        let mut llm = llm_with(LlmProviderKind::AnthropicOauth, None);
        llm.active = None;
        assert_eq!(probe_target(&llm), None);
    }

    #[cfg(unix)]
    fn shell(script: &str) -> Command {
        // SSOT-allow: test fixture spawn
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        command
    }

    #[test]
    #[cfg(unix)]
    fn a_zero_exit_is_reachable() {
        assert!(matches!(run_probe(shell("exit 0")), Outcome::Reachable));
    }

    #[test]
    #[cfg(unix)]
    fn a_curl_error_is_a_transport_failure() {
        let outcome = run_probe(shell(
            "echo 'time=x level=warning msg=noise' >&2; \
             echo 'curl: (6) Could not resolve host: api.anthropic.com' >&2; exit 6",
        ));
        assert!(matches!(
            outcome,
            Outcome::TransportFailure(e) if e.contains("Could not resolve host")
        ));
    }

    #[test]
    #[cfg(unix)]
    fn a_failure_that_is_not_curl_is_inconclusive() {
        let outcome = run_probe(shell("echo 'container is not running' >&2; exit 1"));
        assert!(matches!(outcome, Outcome::Inconclusive(_)));
    }
}
