#[derive(Debug, PartialEq)]
pub(crate) enum CliAction {
    PluginInstall(String),
    PluginList,
    PluginRemove(String),
    PluginEnable { service_id: String, project: String },
    PluginDisable { service_id: String, project: String },
    Check,
    Init(Option<String>),
    Login(Option<String>),
    Logout(Option<String>),
    SelfUpdate,
    Update(Option<String>),
    Run(Option<String>),
    Help,
    Version,
}

pub(crate) fn parse_action(args: &[String]) -> Result<CliAction, String> {
    match args.get(1).map(|s| s.as_str()) {
        Some("--help" | "-h" | "help") => Ok(CliAction::Help),
        Some("--version" | "-V") => Ok(CliAction::Version),
        Some("plugin") => match args.get(2).map(|s| s.as_str()) {
            Some("install") => {
                let path = args
                    .get(3)
                    .ok_or("usage: speedwave plugin install <zip-path>".to_string())?;
                reject_extra_args(args, 4, "speedwave plugin install <zip-path>")?;
                Ok(CliAction::PluginInstall(path.clone()))
            }
            Some("list") => {
                reject_extra_args(args, 3, "speedwave plugin list")?;
                Ok(CliAction::PluginList)
            }
            Some("remove") => {
                let slug = args
                    .get(3)
                    .ok_or("usage: speedwave plugin remove <slug>".to_string())?;
                reject_extra_args(args, 4, "speedwave plugin remove <slug>")?;
                Ok(CliAction::PluginRemove(slug.clone()))
            }
            Some("enable") => parse_plugin_toggle(args, "enable", |service_id, project| {
                CliAction::PluginEnable {
                    service_id,
                    project,
                }
            }),
            Some("disable") => parse_plugin_toggle(args, "disable", |service_id, project| {
                CliAction::PluginDisable {
                    service_id,
                    project,
                }
            }),
            _ => Err("usage: speedwave plugin [install|list|remove|enable|disable]".to_string()),
        },
        Some("check") => {
            reject_extra_args(args, 2, "speedwave check")?;
            Ok(CliAction::Check)
        }
        Some("init") => {
            let name = args.get(2).cloned();
            reject_extra_args(args, 3, "speedwave init [name]")?;
            Ok(CliAction::Init(name))
        }
        Some("self-update") => {
            reject_extra_args(args, 2, "speedwave self-update")?;
            Ok(CliAction::SelfUpdate)
        }
        Some("update") => Ok(CliAction::Update(parse_optional_project(
            &args[2..],
            "update",
        )?)),
        Some("login") => Ok(CliAction::Login(parse_optional_project(
            &args[2..],
            "login",
        )?)),
        Some("logout") => Ok(CliAction::Logout(parse_optional_project(
            &args[2..],
            "logout",
        )?)),
        Some(flag) if flag.starts_with('-') => {
            Ok(CliAction::Run(parse_optional_project(&args[1..], "run")?))
        }
        Some(unknown) => Err(format!(
            "unknown command: '{unknown}'. Run 'speedwave --help' for usage."
        )),
        None => Ok(CliAction::Run(None)),
    }
}

fn reject_extra_args(args: &[String], expected_len: usize, usage: &str) -> Result<(), String> {
    match args.get(expected_len) {
        Some(extra) => Err(format!("unexpected argument: '{extra}'. usage: {usage}")),
        None => Ok(()),
    }
}

fn parse_plugin_toggle(
    args: &[String],
    subcommand: &str,
    build: fn(String, String) -> CliAction,
) -> Result<CliAction, String> {
    let usage = format!("speedwave plugin {subcommand} <service_id> --project <project>");
    let service_id = args
        .get(3)
        .ok_or_else(|| format!("usage: {usage}"))?
        .clone();
    let project =
        parse_project_tail(&args[4..], &usage)?.ok_or_else(|| format!("usage: {usage}"))?;
    Ok(build(service_id, project))
}

fn parse_optional_project(tail: &[String], subcommand: &str) -> Result<Option<String>, String> {
    parse_project_tail(
        tail,
        &format!("speedwave {subcommand} [--project <project>]"),
    )
}

fn parse_project_tail(tail: &[String], usage: &str) -> Result<Option<String>, String> {
    let mut iter = tail.iter();
    let Some(first) = iter.next() else {
        return Ok(None);
    };
    let project = if let Some(value) = first.strip_prefix("--project=") {
        if value.is_empty() {
            return Err(format!("usage: {usage}"));
        }
        value.to_string()
    } else if first == "--project" {
        iter.next()
            .cloned()
            .ok_or_else(|| format!("usage: {usage}"))?
    } else {
        return Err(format!("unexpected argument: '{first}'. usage: {usage}"));
    };
    if let Some(extra) = iter.next() {
        return Err(format!("unexpected argument: '{extra}'. usage: {usage}"));
    }
    Ok(Some(project))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test fixtures assert on setup that must not silently fail"
)]
mod tests {
    use super::*;

    #[test]
    fn parse_action_no_args_returns_run() {
        let args = vec!["speedwave".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Run(None));
    }

    #[test]
    fn parse_action_help_long_flag() {
        let args = vec!["speedwave".to_string(), "--help".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Help);
    }

    #[test]
    fn parse_action_help_short_flag() {
        let args = vec!["speedwave".to_string(), "-h".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Help);
    }

    #[test]
    fn parse_action_help_subcommand() {
        let args = vec!["speedwave".to_string(), "help".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Help);
    }

    #[test]
    fn parse_action_version_long_flag() {
        let args = vec!["speedwave".to_string(), "--version".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Version);
    }

    #[test]
    fn parse_action_version_short_flag() {
        let args = vec!["speedwave".to_string(), "-V".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Version);
    }

    #[test]
    fn parse_action_check() {
        let args = vec!["speedwave".to_string(), "check".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Check);
    }

    #[test]
    fn parse_action_plugin_install() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "install".to_string(),
            "/tmp/foo.zip".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::PluginInstall("/tmp/foo.zip".to_string())
        );
    }

    #[test]
    fn parse_action_plugin_list() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "list".to_string(),
        ];
        assert_eq!(parse_action(&args).unwrap(), CliAction::PluginList);
    }

    #[test]
    fn parse_action_plugin_remove() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "remove".to_string(),
            "my-plugin".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::PluginRemove("my-plugin".to_string())
        );
    }

    #[test]
    fn parse_action_plugin_no_subcommand() {
        let args = vec!["speedwave".to_string(), "plugin".to_string()];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_plugin_install_no_path() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "install".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_plugin_remove_no_slug() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "remove".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_unknown_command_errors() {
        let args = vec!["speedwave".to_string(), "updatte".to_string()];
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("unknown command") && err.contains("updatte"),
            "expected unknown-command error, got: {err}"
        );
    }

    #[test]
    fn parse_action_unknown_flag_yields_unexpected_argument() {
        let args = vec!["speedwave".to_string(), "-x".to_string()];
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("unexpected argument") && err.contains("-x"),
            "expected unexpected argument error for unknown flag, got: {err}"
        );
    }

    #[test]
    fn parse_action_login_no_project() {
        let args = vec!["speedwave".to_string(), "login".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Login(None));
    }

    #[test]
    fn parse_action_login_with_project() {
        let args = vec![
            "speedwave".to_string(),
            "login".to_string(),
            "--project".to_string(),
            "foo".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Login(Some("foo".to_string()))
        );
    }

    #[test]
    fn parse_action_login_project_flag_without_value() {
        let args = vec![
            "speedwave".to_string(),
            "login".to_string(),
            "--project".to_string(),
        ];
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("speedwave login"),
            "expected usage hint, got: {err}"
        );
    }

    #[test]
    fn parse_action_logout_no_project() {
        let args = vec!["speedwave".to_string(), "logout".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Logout(None));
    }

    #[test]
    fn parse_action_logout_with_project() {
        let args = vec![
            "speedwave".to_string(),
            "logout".to_string(),
            "--project".to_string(),
            "bar".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Logout(Some("bar".to_string()))
        );
    }

    #[test]
    fn parse_action_logout_project_flag_without_value() {
        let args = vec![
            "speedwave".to_string(),
            "logout".to_string(),
            "--project".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_leading_flag_before_subcommand_errors() {
        let args = argv(&["speedwave", "--project", "acme", "login"]);
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("unexpected argument") && err.contains("login"),
            "expected trailing-garbage error, got: {err}"
        );
    }

    #[test]
    fn parse_action_update_with_project_space_form() {
        let args = argv(&["speedwave", "update", "--project", "acme"]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Update(Some("acme".to_string()))
        );
    }

    #[test]
    fn parse_action_login_equals_form() {
        let args = argv(&["speedwave", "login", "--project=acme"]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Login(Some("acme".to_string()))
        );
    }

    #[test]
    fn parse_action_bare_run_equals_form() {
        let args = argv(&["speedwave", "--project=acme"]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Run(Some("acme".to_string()))
        );
    }

    #[test]
    fn parse_action_equals_form_empty_value_errors() {
        let args = argv(&["speedwave", "login", "--project="]);
        let err = parse_action(&args).unwrap_err();
        assert!(err.contains("speedwave login"), "got: {err}");
    }

    #[test]
    fn parse_action_login_extra_positional_errors() {
        let args = argv(&["speedwave", "login", "extra", "junk"]);
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("unexpected argument") && err.contains("extra"),
            "got: {err}"
        );
    }

    #[test]
    fn parse_action_login_extra_after_project_value_errors() {
        let args = argv(&["speedwave", "login", "--project", "acme", "junk"]);
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("unexpected argument") && err.contains("junk"),
            "got: {err}"
        );
    }

    #[test]
    fn parse_action_check_rejects_extra_args() {
        let args = argv(&["speedwave", "check", "junk"]);
        let err = parse_action(&args).unwrap_err();
        assert!(err.contains("speedwave check"), "got: {err}");
    }

    #[test]
    fn parse_action_self_update_rejects_extra_args() {
        let args = argv(&["speedwave", "self-update", "junk"]);
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_init_rejects_extra_args() {
        let args = argv(&["speedwave", "init", "name", "junk"]);
        let err = parse_action(&args).unwrap_err();
        assert!(err.contains("speedwave init"), "got: {err}");
    }

    #[test]
    fn parse_action_plugin_install_rejects_extra_args() {
        let args = argv(&["speedwave", "plugin", "install", "x.zip", "junk"]);
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_compat_desktop_login_project_space_form() {
        let args = argv(&["speedwave", "login", "--project", "My Project"]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Login(Some("My Project".to_string()))
        );
    }

    #[test]
    fn parse_action_compat_bare_run_with_project() {
        let args = argv(&["speedwave", "--project", "acme"]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Run(Some("acme".to_string()))
        );
    }

    #[test]
    fn parse_action_compat_bare_run_no_args() {
        let args = argv(&["speedwave"]);
        assert_eq!(parse_action(&args).unwrap(), CliAction::Run(None));
    }

    #[test]
    fn parse_action_compat_plugin_enable_shape() {
        let args = argv(&[
            "speedwave",
            "plugin",
            "enable",
            "slack",
            "--project",
            "acme",
        ]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::PluginEnable {
                service_id: "slack".to_string(),
                project: "acme".to_string(),
            }
        );
    }

    #[test]
    fn parse_action_project_flag_overrides_run() {
        let args = vec![
            "speedwave".to_string(),
            "--project".to_string(),
            "beta".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Run(Some("beta".to_string()))
        );
    }

    #[test]
    fn parse_action_project_flag_without_value_errors() {
        let args = vec!["speedwave".to_string(), "--project".to_string()];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_self_update() {
        let args = vec!["speedwave".to_string(), "self-update".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::SelfUpdate);
    }

    #[test]
    fn parse_action_update() {
        let args = vec!["speedwave".to_string(), "update".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Update(None));
    }

    #[test]
    fn parse_action_init_no_name() {
        let args = vec!["speedwave".to_string(), "init".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Init(None));
    }

    #[test]
    fn parse_action_init_with_name() {
        let args = vec![
            "speedwave".to_string(),
            "init".to_string(),
            "my-custom-name".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Init(Some("my-custom-name".to_string()))
        );
    }

    #[test]
    fn parse_action_plugin_enable() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "enable".to_string(),
            "my-svc".to_string(),
            "--project".to_string(),
            "demo".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::PluginEnable {
                service_id: "my-svc".to_string(),
                project: "demo".to_string(),
            }
        );
    }

    #[test]
    fn parse_action_plugin_disable() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "disable".to_string(),
            "my-svc".to_string(),
            "--project".to_string(),
            "demo".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::PluginDisable {
                service_id: "my-svc".to_string(),
                project: "demo".to_string(),
            }
        );
    }

    #[test]
    fn parse_action_plugin_enable_missing_service_id() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "enable".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_plugin_disable_missing_service_id() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "disable".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_plugin_enable_missing_project_flag() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "enable".to_string(),
            "my-svc".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_plugin_disable_missing_project_flag() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "disable".to_string(),
            "my-svc".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_plugin_enable_missing_project_value() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "enable".to_string(),
            "my-svc".to_string(),
            "--project".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_plugin_disable_missing_project_value() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "disable".to_string(),
            "my-svc".to_string(),
            "--project".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_action_plugin_enable_equals_form() {
        let args = argv(&["speedwave", "plugin", "enable", "slack", "--project=acme"]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::PluginEnable {
                service_id: "slack".to_string(),
                project: "acme".to_string(),
            }
        );
    }

    #[test]
    fn parse_action_plugin_disable_equals_form() {
        let args = argv(&["speedwave", "plugin", "disable", "slack", "--project=acme"]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::PluginDisable {
                service_id: "slack".to_string(),
                project: "acme".to_string(),
            }
        );
    }

    #[test]
    fn parse_action_plugin_enable_equals_form_empty_value_errors() {
        let args = argv(&["speedwave", "plugin", "enable", "slack", "--project="]);
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("speedwave plugin enable <service_id> --project <project>"),
            "got: {err}"
        );
    }

    #[test]
    fn parse_action_plugin_enable_extra_argument_after_project_errors() {
        let args = argv(&[
            "speedwave",
            "plugin",
            "enable",
            "slack",
            "--project",
            "acme",
            "extra",
        ]);
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("unexpected argument") && err.contains("extra"),
            "got: {err}"
        );
    }

    #[test]
    fn parse_action_plugin_disable_extra_argument_after_equals_form_errors() {
        let args = argv(&[
            "speedwave",
            "plugin",
            "disable",
            "slack",
            "--project=acme",
            "extra",
        ]);
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("unexpected argument") && err.contains("extra"),
            "got: {err}"
        );
    }

    #[test]
    fn parse_action_plugin_enable_stray_argument_instead_of_flag_errors() {
        let args = argv(&["speedwave", "plugin", "enable", "slack", "acme"]);
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("unexpected argument") && err.contains("acme"),
            "got: {err}"
        );
    }

    #[test]
    fn parse_action_plugin_enable_without_project_names_the_usage() {
        let args = argv(&["speedwave", "plugin", "enable", "slack"]);
        let err = parse_action(&args).unwrap_err();
        assert_eq!(
            err,
            "usage: speedwave plugin enable <service_id> --project <project>"
        );
    }

    #[test]
    fn parse_action_update_equals_form() {
        let args = argv(&["speedwave", "update", "--project=acme"]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Update(Some("acme".to_string()))
        );
    }

    #[test]
    fn parse_action_logout_equals_form() {
        let args = argv(&["speedwave", "logout", "--project=acme"]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Logout(Some("acme".to_string()))
        );
    }
}
