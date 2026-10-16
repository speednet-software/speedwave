//! Engine-side lifecycle of the egress-less networks: `nerdctl network create --internal`,
//! a live isolation check of the created CNI config, and removal. Lima and WSL share it through
//! a `nerdctl <args>` closure.

use serde::Deserialize;

const NETWORK_NOT_FOUND_FRAGMENTS: [&str; 2] = [
    "no network found matching",
    "unable to find any network matching",
];

const DEFAULT_ROUTES: [&str; 2] = ["0.0.0.0/0", "::/0"];

const COMPOSE_PROJECT_LABEL: &str = "com.docker.compose.project";

const COMPOSE_NETWORK_LABEL: &str = "com.docker.compose.network";

#[derive(Debug, Deserialize)]
struct NativeNetwork {
    #[serde(rename = "CNI")]
    cni: CniConfList,
}

#[derive(Debug, Deserialize)]
struct CniConfList {
    #[serde(default)]
    plugins: Vec<CniPlugin>,
}

#[derive(Debug, Deserialize)]
struct CniPlugin {
    #[serde(rename = "type")]
    plugin_type: String,
    #[serde(default, rename = "isGateway")]
    is_gateway: bool,
    #[serde(default, rename = "isDefaultGateway")]
    is_default_gateway: bool,
    #[serde(default, rename = "ipMasq")]
    ip_masq: bool,
    #[serde(default)]
    ipam: Option<CniIpam>,
}

#[derive(Debug, Deserialize)]
struct CniIpam {
    #[serde(default)]
    routes: Vec<CniRoute>,
}

#[derive(Debug, Deserialize)]
struct CniRoute {
    #[serde(default)]
    dst: String,
}

fn is_network_not_found(e: &anyhow::Error) -> bool {
    let msg = format!("{e:#}");
    NETWORK_NOT_FOUND_FRAGMENTS
        .iter()
        .any(|fragment| msg.contains(fragment))
}

fn isolation_problem(network: &NativeNetwork) -> Option<String> {
    let plugins = &network.cni.plugins;
    if plugins.first().map(|p| p.plugin_type.as_str()) != Some("bridge") {
        return Some(format!(
            "its first CNI plugin is not a bridge: {:?}",
            plugins.iter().map(|p| &p.plugin_type).collect::<Vec<_>>()
        ));
    }
    for plugin in plugins {
        if plugin.is_gateway || plugin.is_default_gateway {
            return Some(format!("the {} plugin is a gateway", plugin.plugin_type));
        }
        if plugin.ip_masq {
            return Some(format!("the {} plugin masquerades", plugin.plugin_type));
        }
        if plugin.plugin_type == "portmap" {
            return Some("it maps ports".to_string());
        }
        let routes = plugin.ipam.as_ref().map(|i| i.routes.as_slice());
        if let Some(route) = routes
            .unwrap_or_default()
            .iter()
            .find(|r| DEFAULT_ROUTES.contains(&r.dst.as_str()))
        {
            return Some(format!("it routes {} out", route.dst));
        }
    }
    None
}

fn inspect_network(
    name: &str,
    nerdctl: &dyn Fn(&[&str]) -> anyhow::Result<String>,
) -> anyhow::Result<Option<NativeNetwork>> {
    let output = match nerdctl(&["network", "inspect", "--mode=native", name]) {
        Ok(output) => output,
        Err(e) if is_network_not_found(&e) => return Ok(None),
        Err(e) => return Err(e.context(format!("failed to inspect network {name}"))),
    };
    let mut entries: Vec<NativeNetwork> = serde_json::from_str(output.trim())
        .map_err(|e| anyhow::anyhow!("unreadable inspect output for network {name}: {e}"))?;
    match entries.len() {
        1 => Ok(entries.pop()),
        n => anyhow::bail!("network inspect for {name} returned {n} entries, expected 1"),
    }
}

/// `Ok(true)` if the network `name` exists; `Ok(false)` only when the engine answers that it does
/// not, while an engine that cannot answer is `Err`.
pub(crate) fn network_exists_with(
    name: &str,
    nerdctl: &dyn Fn(&[&str]) -> anyhow::Result<String>,
) -> anyhow::Result<bool> {
    Ok(inspect_network(name, nerdctl)?.is_some())
}

/// Makes `name` an isolated (`--internal`) network of `project`, checked by a live inspect: a missing
/// one is created (a failed create stands only if a re-inspect finds it isolated), egress recreated.
pub(crate) fn ensure_internal_network_with(
    name: &str,
    project: &str,
    nerdctl: &dyn Fn(&[&str]) -> anyhow::Result<String>,
) -> anyhow::Result<()> {
    if let Some(existing) = inspect_network(name, nerdctl)? {
        let Some(problem) = isolation_problem(&existing) else {
            return Ok(());
        };
        log::warn!("network {name} has egress ({problem}), recreating it with --internal");
        remove_network_with(name, nerdctl).map_err(|e| {
            anyhow::anyhow!(
                "network {name} exists with internet access ({problem}) and could not be \
                 removed; stop the containers attached to it (or remove the network) and start \
                 the project again: {e:#}"
            )
        })?;
    }
    log::info!("creating egress-less network {name} for project {project}");
    let project_label = format!("{COMPOSE_PROJECT_LABEL}={project}");
    let network_label = format!("{COMPOSE_NETWORK_LABEL}={name}");
    if let Err(create_err) = nerdctl(&[
        "network",
        "create",
        "--internal",
        "--label",
        &project_label,
        "--label",
        &network_label,
        name,
    ]) {
        return match inspect_network(name, nerdctl) {
            Ok(Some(existing)) if isolation_problem(&existing).is_none() => {
                log::warn!(
                    "creating network {name} reported an error, but it exists isolated: \
                     {create_err:#}"
                );
                Ok(())
            }
            _ => Err(create_err.context(format!("failed to create egress-less network {name}"))),
        };
    }
    match inspect_network(name, nerdctl)? {
        None => anyhow::bail!("network {name} is missing right after it was created"),
        Some(created) => match isolation_problem(&created) {
            None => Ok(()),
            Some(problem) => {
                anyhow::bail!(
                    "network {name} was created with --internal but has egress ({problem})"
                )
            }
        },
    }
}

/// Removes the network `name`; a network that does not exist is not an error.
pub(crate) fn remove_network_with(
    name: &str,
    nerdctl: &dyn Fn(&[&str]) -> anyhow::Result<String>,
) -> anyhow::Result<()> {
    match nerdctl(&["network", "rm", name]) {
        Ok(_) => Ok(()),
        Err(e) if is_network_not_found(&e) => Ok(()),
        Err(e) => Err(e.context(format!("failed to remove network {name}"))),
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
pub(crate) mod tests {
    use super::*;
    use crate::runtime::CommandRunner;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    pub(crate) const INTERNAL_INSPECT: &str = r#"[
    {
        "CNI": {
            "cniVersion": "1.0.0",
            "name": "speedwave_acme_network_office",
            "nerdctlID": "0123456789ab",
            "nerdctlLabels": {"com.docker.compose.project": "acme"},
            "plugins": [
                {
                    "type": "bridge",
                    "bridge": "br-0123456789ab",
                    "hairpinMode": true,
                    "ipam": {
                        "ranges": [[{"gateway": "10.4.2.1", "subnet": "10.4.2.0/24"}]],
                        "type": "host-local"
                    }
                },
                {"type": "firewall", "ingressPolicy": "same-bridge"},
                {"type": "tuning"}
            ]
        },
        "NerdctlID": "0123456789ab",
        "NerdctlLabels": {"com.docker.compose.project": "acme"},
        "File": "/etc/cni/net.d/nerdctl-speedwave_acme_network_office.conflist",
        "Containers": []
    }
]"#;

    pub(crate) const BRIDGED_INSPECT: &str = r#"[
    {
        "CNI": {
            "cniVersion": "1.0.0",
            "name": "speedwave_acme_network_office",
            "plugins": [
                {
                    "type": "bridge",
                    "bridge": "br-0123456789ab",
                    "isGateway": true,
                    "ipMasq": true,
                    "hairpinMode": true,
                    "ipam": {
                        "ranges": [[{"gateway": "10.4.2.1", "subnet": "10.4.2.0/24"}]],
                        "routes": [{"dst": "0.0.0.0/0"}],
                        "type": "host-local"
                    }
                },
                {"type": "portmap", "capabilities": {"portMappings": true}},
                {"type": "firewall"},
                {"type": "tuning"}
            ]
        },
        "NerdctlID": "0123456789ab",
        "Containers": []
    }
]"#;

    pub(crate) const NOT_FOUND: &str = "limactl failed: time=\"2026-10-08T10:00:00Z\" \
        level=error msg=\"no network found matching: speedwave_acme_network_office\"\n\
        time=\"2026-10-08T10:00:00Z\" level=fatal msg=\"unable to find any network matching \
        the provided request\"";

    pub(crate) type ScriptedCalls = Arc<Mutex<Vec<(String, Duration)>>>;

    pub(crate) struct ScriptedRunner {
        answers: Mutex<VecDeque<Result<String, String>>>,
        calls: ScriptedCalls,
        auto: fn(&str) -> Option<String>,
    }

    impl ScriptedRunner {
        pub(crate) fn new(
            answers: &[Result<&str, &str>],
            auto: fn(&str) -> Option<String>,
        ) -> (Self, ScriptedCalls) {
            let calls = ScriptedCalls::default();
            let runner = Self {
                answers: Mutex::new(
                    answers
                        .iter()
                        .map(|a| a.map(str::to_string).map_err(str::to_string))
                        .collect(),
                ),
                calls: Arc::clone(&calls),
                auto,
            };
            (runner, calls)
        }
    }

    impl CommandRunner for ScriptedRunner {
        fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
            anyhow::bail!(
                "network commands must be bounded, got run: {cmd} {}",
                args.join(" ")
            )
        }

        fn run_bounded(
            &self,
            cmd: &str,
            args: &[&str],
            timeout: Duration,
        ) -> anyhow::Result<String> {
            let key = format!("{cmd} {}", args.join(" "));
            if let Some(answer) = (self.auto)(&key) {
                return Ok(answer);
            }
            self.calls.lock().unwrap().push((key.clone(), timeout));
            match self.answers.lock().unwrap().pop_front() {
                Some(Ok(out)) => Ok(out),
                Some(Err(e)) => Err(anyhow::anyhow!(e)),
                None => anyhow::bail!("unexpected network command: {key}"),
            }
        }
    }

    struct Script {
        calls: RefCell<Vec<String>>,
        answers: RefCell<VecDeque<Result<String, String>>>,
    }

    impl Script {
        fn new(answers: &[Result<&str, &str>]) -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                answers: RefCell::new(
                    answers
                        .iter()
                        .map(|a| a.map(str::to_string).map_err(str::to_string))
                        .collect(),
                ),
            }
        }

        fn run(&self, args: &[&str]) -> anyhow::Result<String> {
            self.calls.borrow_mut().push(args.join(" "));
            match self.answers.borrow_mut().pop_front() {
                Some(Ok(out)) => Ok(out),
                Some(Err(e)) => Err(anyhow::anyhow!(e)),
                None => panic!("unexpected nerdctl call: {}", args.join(" ")),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    const NAME: &str = "speedwave_acme_network_office";

    const CREATE: &str = "network create --internal \
        --label com.docker.compose.project=acme \
        --label com.docker.compose.network=speedwave_acme_network_office \
        speedwave_acme_network_office";

    const INSPECT: &str = "network inspect --mode=native speedwave_acme_network_office";

    #[test]
    fn an_isolated_network_is_left_alone() {
        let script = Script::new(&[Ok(INTERNAL_INSPECT)]);
        ensure_internal_network_with(NAME, "acme", &|a| script.run(a)).unwrap();
        assert_eq!(script.calls(), vec![INSPECT]);
    }

    #[test]
    fn a_missing_network_is_created_internal_and_verified() {
        let script = Script::new(&[Err(NOT_FOUND), Ok(NAME), Ok(INTERNAL_INSPECT)]);
        ensure_internal_network_with(NAME, "acme", &|a| script.run(a)).unwrap();
        assert_eq!(script.calls(), vec![INSPECT, CREATE, INSPECT]);
    }

    #[test]
    fn a_network_with_egress_is_removed_and_created_internal() {
        let script = Script::new(&[
            Ok(BRIDGED_INSPECT),
            Ok(NAME),
            Ok(NAME),
            Ok(INTERNAL_INSPECT),
        ]);
        ensure_internal_network_with(NAME, "acme", &|a| script.run(a)).unwrap();
        assert_eq!(
            script.calls(),
            vec![
                INSPECT.to_string(),
                format!("network rm {NAME}"),
                CREATE.to_string(),
                INSPECT.to_string()
            ]
        );
    }

    #[test]
    fn a_network_with_egress_still_in_use_fails_the_start() {
        let script = Script::new(&[
            Ok(BRIDGED_INSPECT),
            Err("level=error msg=\"network \\\"speedwave_acme_network_office\\\" is in use by container \\\"abc\\\"\""),
        ]);
        let err = ensure_internal_network_with(NAME, "acme", &|a| script.run(a)).unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("is in use by container"), "{msg}");
        assert!(
            msg.contains(&format!("network {NAME} exists with internet access")),
            "{msg}"
        );
        assert!(
            msg.contains("stop the containers attached to it (or remove the network) and start the project again"),
            "{msg}"
        );
        assert!(!msg.contains("stop the project"), "{msg}");
        assert_eq!(
            script.calls().len(),
            2,
            "never creates over a network it could not remove"
        );
    }

    #[test]
    fn a_network_with_egress_gone_before_its_removal_is_still_created_internal() {
        let script = Script::new(&[
            Ok(BRIDGED_INSPECT),
            Err(NOT_FOUND),
            Ok(NAME),
            Ok(INTERNAL_INSPECT),
        ]);
        ensure_internal_network_with(NAME, "acme", &|a| script.run(a)).unwrap();
        assert_eq!(script.calls().len(), 4);
        assert_eq!(script.calls()[2], CREATE);
    }

    #[test]
    fn a_failed_create_of_a_network_that_exists_isolated_is_accepted() {
        let script = Script::new(&[
            Err(NOT_FOUND),
            Err("time=\"2026-10-12T10:00:00Z\" level=fatal msg=EOF"),
            Ok(INTERNAL_INSPECT),
        ]);
        ensure_internal_network_with(NAME, "acme", &|a| script.run(a)).unwrap();
        assert_eq!(script.calls(), vec![INSPECT, CREATE, INSPECT]);
    }

    #[test]
    fn a_failed_create_of_a_network_that_exists_with_egress_fails_the_start() {
        let script = Script::new(&[
            Err(NOT_FOUND),
            Err("network with name speedwave_acme_network_office already exists"),
            Ok(BRIDGED_INSPECT),
        ]);
        let err = ensure_internal_network_with(NAME, "acme", &|a| script.run(a)).unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("failed to create egress-less network"),
            "{msg}"
        );
        assert!(msg.contains("already exists"), "{msg}");
        assert_eq!(script.calls(), vec![INSPECT, CREATE, INSPECT]);
    }

    #[test]
    fn a_failed_create_with_an_unreadable_reinspect_fails_with_the_create_error() {
        let script = Script::new(&[
            Err(NOT_FOUND),
            Err("level=fatal msg=EOF"),
            Err("command 'limactl' timed out after 60s"),
        ]);
        let err = ensure_internal_network_with(NAME, "acme", &|a| script.run(a)).unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("failed to create egress-less network"),
            "{msg}"
        );
        assert!(msg.contains("EOF"), "{msg}");
    }

    #[test]
    fn a_created_network_that_still_has_a_gateway_fails_the_start() {
        let script = Script::new(&[Err(NOT_FOUND), Ok(NAME), Ok(BRIDGED_INSPECT)]);
        let err = ensure_internal_network_with(NAME, "acme", &|a| script.run(a)).unwrap_err();
        assert!(err.to_string().contains("has egress"), "{err}");
        assert!(err.to_string().contains("gateway"), "{err}");
    }

    #[test]
    fn a_network_missing_after_create_fails_the_start() {
        let script = Script::new(&[Err(NOT_FOUND), Ok(NAME), Err(NOT_FOUND)]);
        let err = ensure_internal_network_with(NAME, "acme", &|a| script.run(a)).unwrap_err();
        assert!(err.to_string().contains("missing right after"), "{err}");
    }

    #[test]
    fn an_unreadable_engine_is_an_error_never_a_missing_network() {
        let script = Script::new(&[Err("command 'limactl' timed out after 60s")]);
        let err = ensure_internal_network_with(NAME, "acme", &|a| script.run(a)).unwrap_err();
        assert!(format!("{err:#}").contains("timed out"), "{err:#}");
        assert_eq!(
            script.calls(),
            vec![INSPECT],
            "never creates on an unknown state"
        );
    }

    #[test]
    fn a_failed_create_fails_the_start() {
        let script = Script::new(&[
            Err(NOT_FOUND),
            Err("needs CNI plugin \"firewall\""),
            Err(NOT_FOUND),
        ]);
        let err = ensure_internal_network_with(NAME, "acme", &|a| script.run(a)).unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("failed to create egress-less network"),
            "{msg}"
        );
        assert!(msg.contains("needs CNI plugin"), "{msg}");
        assert_eq!(script.calls(), vec![INSPECT, CREATE, INSPECT]);
    }

    #[test]
    fn unparsable_inspect_output_is_an_error() {
        for output in ["not json", "[]", "{}"] {
            let script = Script::new(&[Ok(output)]);
            assert!(
                ensure_internal_network_with(NAME, "acme", &|a| script.run(a)).is_err(),
                "{output} must not pass as isolated"
            );
        }
    }

    fn inspected(plugins: &str) -> NativeNetwork {
        let json = format!(r#"[{{"CNI": {{"plugins": {plugins}}}, "Containers": null}}]"#);
        let mut parsed: Vec<NativeNetwork> = serde_json::from_str(&json).unwrap();
        parsed.pop().unwrap()
    }

    #[test]
    fn isolation_tolerates_omitted_fields_and_extra_keys() {
        let net = inspected(r#"[{"type": "bridge", "future": 1}, {"type": "tuning"}]"#);
        assert_eq!(isolation_problem(&net), None);
        let net = inspected(r#"[{"type": "bridge", "ipam": null}]"#);
        assert_eq!(isolation_problem(&net), None);
        let net = inspected(r#"[{"type": "bridge", "ipam": {"routes": []}}]"#);
        assert_eq!(isolation_problem(&net), None);
    }

    #[test]
    fn isolation_rejects_every_kind_of_egress() {
        for plugins in [
            r#"[{"type": "bridge", "isGateway": true}]"#,
            r#"[{"type": "bridge", "isDefaultGateway": true}]"#,
            r#"[{"type": "bridge", "ipMasq": true}]"#,
            r#"[{"type": "bridge", "ipam": {"routes": [{"dst": "0.0.0.0/0"}]}}]"#,
            r#"[{"type": "bridge", "ipam": {"routes": [{"dst": "::/0"}]}}]"#,
            r#"[{"type": "bridge"}, {"type": "portmap"}]"#,
            r#"[{"type": "macvlan"}]"#,
            r#"[]"#,
        ] {
            assert!(
                isolation_problem(&inspected(plugins)).is_some(),
                "{plugins} must not pass as isolated"
            );
        }
    }

    #[test]
    fn isolation_allows_a_route_that_is_not_a_default_route() {
        let net =
            inspected(r#"[{"type": "bridge", "ipam": {"routes": [{"dst": "10.4.0.0/16"}]}}]"#);
        assert_eq!(isolation_problem(&net), None);
    }

    #[test]
    fn an_existing_network_is_reported_present() {
        let script = Script::new(&[Ok(BRIDGED_INSPECT)]);
        assert!(network_exists_with(NAME, &|a| script.run(a)).unwrap());
        assert_eq!(script.calls(), vec![INSPECT]);
    }

    #[test]
    fn a_missing_network_is_reported_absent() {
        let script = Script::new(&[Err(NOT_FOUND)]);
        assert!(!network_exists_with(NAME, &|a| script.run(a)).unwrap());
    }

    #[test]
    fn an_unreadable_engine_never_reports_a_network_absent() {
        let script = Script::new(&[Err("command 'limactl' timed out after 60s")]);
        let err = network_exists_with(NAME, &|a| script.run(a)).unwrap_err();
        assert!(format!("{err:#}").contains("timed out"), "{err:#}");
    }

    #[test]
    fn removing_a_network_runs_network_rm() {
        let script = Script::new(&[Ok(NAME)]);
        remove_network_with(NAME, &|a| script.run(a)).unwrap();
        assert_eq!(script.calls(), vec![format!("network rm {NAME}")]);
    }

    #[test]
    fn removing_a_missing_network_is_not_an_error() {
        let script = Script::new(&[Err(
            "level=error msg=\"no network found matching: speedwave_acme_network_office\"",
        )]);
        remove_network_with(NAME, &|a| script.run(a)).unwrap();
    }

    #[test]
    fn engine_contract_bats_pins_the_network_not_found_phrases_and_isolation_fields() {
        let bats = include_str!("../../../../_tests/e2e/engine-contract.bats");
        for fragment in NETWORK_NOT_FOUND_FRAGMENTS {
            assert!(
                bats.contains(&format!("\"$output\" == *\"{fragment}\"*")),
                "engine-contract.bats must assert the not-found phrase {fragment:?}"
            );
        }
        for field in ["isGateway", "isDefaultGateway", "ipMasq"] {
            assert!(
                bats.contains(&format!("!= *'\"{field}\":true'*")),
                "engine-contract.bats must assert that an --internal network has no {field}"
            );
        }
        assert!(bats.contains("*'\"plugins\":[{\"type\":\"bridge\"'*"));
        assert!(bats.contains("!= *'\"type\":\"portmap\"'*"));
        for route in DEFAULT_ROUTES {
            assert!(
                bats.contains(&format!("!= *'\"{route}\"'*")),
                "engine-contract.bats must assert that an --internal network has no {route} route"
            );
        }
        assert!(bats.contains("network create --internal"));
        assert!(bats.contains("network inspect --mode=native"));
    }

    #[test]
    fn removing_a_network_in_use_is_an_error() {
        let script = Script::new(&[Err(
            "level=error msg=\"network \\\"x\\\" is in use by container \\\"abc\\\"\"",
        )]);
        let err = remove_network_with(NAME, &|a| script.run(a)).unwrap_err();
        assert!(format!("{err:#}").contains("is in use"), "{err:#}");
    }
}
