use speedwave_runtime::compose::{SecurityCheck, SecurityRule};
use speedwave_runtime::runtime::LockedRuntime;
use strum::IntoEnumIterator;

use super::compose_inputs;
use crate::project_command::ProjectContext;

pub(super) fn run(project: ProjectContext, runtime: LockedRuntime) -> anyhow::Result<()> {
    let inputs = compose_inputs::gather(&project, &runtime)?;
    let security_violations = SecurityCheck::run(
        &inputs.compose_yml,
        &project.name,
        &inputs.manifests,
        &inputs.expected_paths,
    );
    let prereq_violations = &inputs.prereq_violations;

    let os_warnings = speedwave_runtime::os_prereqs::check_os_warnings();
    for w in &os_warnings {
        err!("  WARNING: {w}\n");
    }

    let use_color = std::io::IsTerminal::is_terminal(&std::io::stderr());
    let green = if use_color { "\x1b[32m" } else { "" };
    let red = if use_color { "\x1b[31m" } else { "" };
    let reset = if use_color { "\x1b[0m" } else { "" };

    if prereq_violations.is_empty() && security_violations.is_empty() {
        out!("speedwave check OK -- all system checks passed");
        err!();
        for rule in SecurityRule::iter() {
            err!("  {green}OK{reset}    {}  {}", rule, rule.description());
        }
        return Ok(());
    }

    err!("speedwave check FAILED -- containers NOT started\n");
    let failed_rules: std::collections::HashSet<SecurityRule> =
        security_violations.iter().map(|v| v.rule).collect();
    for rule in SecurityRule::iter() {
        if failed_rules.contains(&rule) {
            err!("  {red}FAIL{reset}  {}  {}", rule, rule.description());
        } else {
            err!("  {green}OK{reset}    {}  {}", rule, rule.description());
        }
    }
    if !prereq_violations.is_empty() {
        err!();
        for v in prereq_violations {
            err!("  {} -- {}", v.rule, v.message);
            err!("  Fix: {}\n", v.remediation);
        }
    }
    if !security_violations.is_empty() {
        err!();
        for v in &security_violations {
            err!("  [{}] {} -- {}", v.container, v.rule, v.message);
            err!("  Fix: {}\n", v.remediation);
        }
    }
    std::process::exit(1);
}
