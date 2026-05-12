//! Validation for the per-project `host_exec` whitelist (ADR-054).
//!
//! `host_exec` is a host-side MCP worker that runs **only** the commands a user
//! has explicitly added to a per-project whitelist, in the project directory,
//! with no shell. This module validates that whitelist before it is persisted
//! / snapshotted for the worker. It deliberately mirrors the patterns in
//! [`crate::plugin`]'s `validate_manifest` (an `OnceLock`-cached regex, the
//! `consts::RESERVED_ENV_KEYS` case-insensitive check, the `..`/NUL/`=`/newline
//! key sanitisation) — see CLAUDE.md ("if the same logic appears in two places
//! — extract it"; here the *shape* is shared but the rules differ enough that a
//! separate function is clearer than a parameterised one).
//!
//! What this module does **not** do: validate the *semantics* of a parameter
//! `pattern` (whether it compiles, whether a supplied value matches). That
//! happens in the `host_exec` worker, in JavaScript `RegExp`, because the
//! worker is what executes it — checking it in Rust's `regex` crate too would
//! invite engine drift. Rust only sanity-checks the `pattern` string here.
//!
//! It also does not — *cannot* — guarantee that a whitelisted recipe won't run
//! arbitrary code: `npm run X` runs `package.json` scripts, `make test` runs
//! the `Makefile`, `./gradlew test` runs `build.gradle` (all repo-controlled),
//! and the launcher ban is by basename so `./node_modules/.bin/node` slips
//! past the `node` ban. The whitelist guarantees the *recipe name and argv
//! shape* are the user's; it does not guarantee the *code that runs* is. The
//! mitigations for that are opt-in + per-recipe confirmation + the enable-time
//! danger modal + the host-side audit log (ADR-054 §Negative), not this
//! validator.

use crate::config::{HostExecConfig, HostExecParam, HostExecRecipe};
use crate::consts;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Returns the per-project `host_exec` state directory:
/// `<data_dir>/host-exec/<project>/` (holds `config.json`, `auth-token`,
/// `port`, `pid`, `log`). Mirrors [`crate::claude_home::claude_home_dir`] —
/// the caller is responsible for validating `project` as a safe single
/// directory component beforehand. This is the SSOT for the layout; do not
/// hard-code the `host-exec/<project>` join at call sites.
pub fn host_exec_project_dir(data_dir: &Path, project: &str) -> PathBuf {
    data_dir.join(consts::HOST_EXEC_SUBDIR).join(project)
}

/// Recipe name pattern: lowercase letters, digits, underscores; starts with a
/// letter; max 64 chars. **Not** [`crate::plugin`]'s slug pattern — that one
/// allows hyphens, and a hyphenated recipe name would not survive the hub's
/// `toCamelCase` bridge as a valid JS identifier (`host_exec.gradle-help()`
/// doesn't parse). See ADR-054.
const RECIPE_NAME_PATTERN: &str = r"^[a-z][a-z0-9_]{0,63}$";

fn recipe_name_re() -> Result<&'static regex::Regex, anyhow::Error> {
    static RE: std::sync::OnceLock<Result<regex::Regex, regex::Error>> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(RECIPE_NAME_PATTERN))
        .as_ref()
        .map_err(|e| anyhow::anyhow!("invalid RECIPE_NAME_PATTERN regex: {e}"))
}

/// Returns the basename of an `exec` path, lowercased, for comparison against
/// the ban / meta-tool lists. `./gradlew` -> `gradlew`; `/usr/bin/python3` ->
/// `python3`; `docker-compose` -> `docker-compose`. Strips a Windows `.exe`
/// suffix too so `bash.exe` is caught.
fn exec_basename_lower(exec: &str) -> String {
    let name = exec
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(exec)
        .to_ascii_lowercase();
    name.strip_suffix(".exe")
        .map(str::to_string)
        .unwrap_or(name)
}

/// True if `value` contains characters that must never appear in a config
/// string destined for argv / env / a JSON snapshot, or in a command name a
/// Tauri command resolves: NUL or a line break (`\n` / `\r`). Public so the
/// Desktop crate's `host_exec_resolve_executable` can reuse it.
pub fn has_control_chars(value: &str) -> bool {
    value.contains('\0') || value.contains('\n') || value.contains('\r')
}

/// Extracts the parameter names referenced by `{name}` tokens in an `args`
/// element, and reports whether the element is a *bare* parameter token (the
/// entire element is exactly `{name}` — the "run whatever Claude types"
/// shape when combined with a meta-tool `exec`).
///
/// `{name}` tokens are `{` + a `snake_case`-ish run + `}`; anything else
/// (`{}`, `{ }`, `{1abc}`, an unclosed `{`) is treated as a literal and is not
/// a parameter reference (it just won't match any declared parameter — if the
/// recipe author meant it as a parameter and got the name wrong, the
/// "`{name}` without a `params` entry" rule below will not fire because we
/// don't recognise it as a token; that is acceptable — the worst case is a
/// literal `{typo}` reaching the process, which is harmless).
fn arg_param_refs(arg: &str) -> (Vec<String>, bool) {
    let mut refs = Vec::new();
    let bytes = arg.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            // find the matching `}`
            if let Some(close_rel) = arg[i + 1..].find('}') {
                let name = &arg[i + 1..i + 1 + close_rel];
                if is_token_name(name) {
                    refs.push(name.to_string());
                }
                i = i + 1 + close_rel + 1;
                continue;
            }
        }
        i += 1;
    }
    let is_bare = refs.len() == 1 && {
        // the element is exactly `{<the one ref>}`
        arg.len() == refs[0].len() + 2 && arg.starts_with('{') && arg.ends_with('}')
    };
    (refs, is_bare)
}

/// A `{...}` token name is valid (and thus a parameter reference) iff it looks
/// like a recipe parameter name: starts with a letter, then letters/digits/
/// underscores. (Same shape as `RECIPE_NAME_PATTERN` minus the length cap —
/// parameter names are validated against `snake_case` separately below.)
fn is_token_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// True if the recipe looks state-changing — a database client, a
/// `docker compose` lifecycle command, or a migration runner. Such recipes may
/// not be set to `HostExecConfirm::Always` (they cap at `Session`): the cost
/// of an accidental destructive run is high enough that "the user clicked
/// through the warning once" is not enough. Heuristic, and documented as such
/// (the `always`-switch warning modal is the backstop); a recipe with a
/// novel `exec` we don't recognise is the user's risk. Used both here (to
/// reject `confirm: always`) and by the Desktop UI (to disable the `always`
/// option for such recipes).
pub fn is_state_changing_recipe(recipe: &HostExecRecipe) -> bool {
    const DB_CLIENTS: &[&str] = &["psql", "mysql", "mysqlsh", "mongo", "mongosh", "sqlite3"];
    const MIGRATION_HINTS: &[&str] = &["migrat", "flyway", "liquibase"];

    let base = exec_basename_lower(&recipe.exec);
    if DB_CLIENTS.contains(&base.as_str()) {
        return true;
    }
    if is_container_lifecycle_recipe(recipe) {
        return true;
    }
    if recipe.args.iter().any(|a| {
        let al = a.to_ascii_lowercase();
        MIGRATION_HINTS.iter().any(|h| al.contains(h))
    }) {
        return true;
    }
    false
}

/// True if `recipe` is a container-engine *lifecycle* command — `docker` /
/// `docker-compose` / `podman` (`podman compose`) with `up` / `down` / `exec`
/// / `rm` / `prune` in `args`. Such a recipe is `docker run` with arbitrary
/// mounts/privileges from a compose file Claude can edit (`/workspace:rw`),
/// i.e. effectively host root — so it gets stricter treatment than other
/// state-changing recipes (`validate_host_exec_config` forces `confirm:"ask"`
/// on it, not just bans `"always"`).
pub fn is_container_lifecycle_recipe(recipe: &HostExecRecipe) -> bool {
    const LIFECYCLE: &[&str] = &["up", "down", "exec", "rm", "prune"];
    let base = exec_basename_lower(&recipe.exec);
    if base != "docker" && base != "docker-compose" && base != "podman" {
        return false;
    }
    recipe
        .args
        .iter()
        .any(|a| LIFECYCLE.contains(&a.to_ascii_lowercase().as_str()))
}

/// Validates a per-project `host_exec` config (the `commands` whitelist plus
/// the `enabled` flag). An empty whitelist is valid (`host_exec` enabled with
/// no recipes simply means Claude can run nothing). Returns the first error
/// found, with a message suitable for surfacing in the Desktop UI.
pub fn validate_host_exec_config(cfg: &HostExecConfig) -> anyhow::Result<()> {
    let name_re = recipe_name_re()?;
    let mut seen_names: HashSet<&str> = HashSet::new();

    for recipe in &cfg.commands {
        validate_recipe(recipe, name_re)?;
        if !seen_names.insert(recipe.name.as_str()) {
            anyhow::bail!("duplicate host_exec recipe name: '{}'", recipe.name);
        }
    }
    Ok(())
}

fn validate_recipe(recipe: &HostExecRecipe, name_re: &regex::Regex) -> anyhow::Result<()> {
    // -- name -----------------------------------------------------------------
    if !name_re.is_match(&recipe.name) {
        anyhow::bail!(
            "invalid host_exec recipe name '{}': must match {RECIPE_NAME_PATTERN} (lowercase \
             snake_case, starts with a letter, max 64 chars — so the hub exposes it as a valid \
             JS identifier `host_exec.{}()`)",
            recipe.name,
            recipe.name,
        );
    }

    // -- exec -----------------------------------------------------------------
    if recipe.exec.is_empty() {
        anyhow::bail!("host_exec recipe '{}': exec must not be empty", recipe.name);
    }
    if recipe.exec.contains('=') || recipe.exec.contains("..") || has_control_chars(&recipe.exec) {
        anyhow::bail!(
            "host_exec recipe '{}': exec '{}' must not contain '=', '..', NUL, or line breaks",
            recipe.name,
            recipe.exec,
        );
    }
    let exec_base = exec_basename_lower(&recipe.exec);
    if consts::HOST_EXEC_SHELL_LAUNCHERS.contains(&exec_base.as_str()) {
        anyhow::bail!(
            "host_exec recipe '{}': exec '{}' is a direct shell/eval launcher, which is not \
             allowed — those exist only to run an arbitrary string. If you need a one-liner, \
             split it into named recipes or wrap it in a script in the repo with a fixed, \
             parameter-free interface (e.g. ./scripts/ci.sh build).",
            recipe.name,
            recipe.exec,
        );
    }
    let is_meta_tool = consts::HOST_EXEC_META_TOOLS.contains(&exec_base.as_str());

    // -- args + parameter cross-checks ---------------------------------------
    let declared_params: HashSet<&str> = recipe
        .params
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|p| p.name.as_str())
        .collect();
    let mut referenced_params: HashSet<String> = HashSet::new();

    for (idx, arg) in recipe.args.iter().enumerate() {
        if has_control_chars(arg) {
            anyhow::bail!(
                "host_exec recipe '{}': args[{idx}] must not contain NUL or line breaks",
                recipe.name,
            );
        }
        let (refs, is_bare_param) = arg_param_refs(arg);
        for r in &refs {
            if !declared_params.contains(r.as_str()) {
                anyhow::bail!(
                    "host_exec recipe '{}': args[{idx}] references parameter '{{{r}}}' but no \
                     such parameter is declared in `params`",
                    recipe.name,
                );
            }
            referenced_params.insert(r.clone());
        }
        if is_bare_param && is_meta_tool {
            anyhow::bail!(
                "host_exec recipe '{}': exec '{}' is a meta-tool and args[{idx}] is a bare \
                 parameter ('{arg}') — that is \"run whatever Claude types\" through {}. A \
                 *literal* sub-command is fine (e.g. `make test`, `npm run build`); a \
                 parameterised one is not.",
                recipe.name,
                recipe.exec,
                exec_base,
            );
        }
    }

    // -- params --------------------------------------------------------------
    let mut seen_param_names: HashSet<&str> = HashSet::new();
    for param in recipe.params.as_deref().unwrap_or(&[]) {
        validate_param(&recipe.name, param)?;
        if !seen_param_names.insert(param.name.as_str()) {
            anyhow::bail!(
                "host_exec recipe '{}': duplicate parameter name '{}'",
                recipe.name,
                param.name,
            );
        }
        if !referenced_params.contains(&param.name) {
            anyhow::bail!(
                "host_exec recipe '{}': parameter '{}' is declared but never used in `args` \
                 (a `{{{}}}` token) — remove it or reference it",
                recipe.name,
                param.name,
                param.name,
            );
        }
    }

    // -- cwd_sub -------------------------------------------------------------
    if let Some(ref sub) = recipe.cwd_sub {
        validate_cwd_sub(&recipe.name, sub)?;
    }

    // -- env -----------------------------------------------------------------
    if let Some(ref env) = recipe.env {
        for (k, v) in env {
            if consts::RESERVED_ENV_KEYS
                .iter()
                .any(|reserved| reserved.eq_ignore_ascii_case(k))
            {
                anyhow::bail!(
                    "host_exec recipe '{}': env key '{k}' is reserved (auto-injected by \
                     Speedwave or a dangerous runtime hijack vector — PATH/HOME/LD_*/DYLD_*/\
                     NODE_OPTIONS/...)",
                    recipe.name,
                );
            }
            if k.is_empty() || k.contains('=') || has_control_chars(k) {
                anyhow::bail!(
                    "host_exec recipe '{}': env key '{k}' must be non-empty and contain no '=', \
                     NUL, or line breaks",
                    recipe.name,
                );
            }
            if has_control_chars(v) {
                anyhow::bail!(
                    "host_exec recipe '{}': env value for '{k}' must not contain NUL or line \
                     breaks",
                    recipe.name,
                );
            }
        }
    }

    // -- confirm -------------------------------------------------------------
    if recipe.confirm == crate::config::HostExecConfirm::Always && is_state_changing_recipe(recipe)
    {
        anyhow::bail!(
            "host_exec recipe '{}': confirm: \"always\" is not allowed for a state-changing \
             recipe (database client / `docker compose up|down|exec|rm|prune` / migration) — \
             the cost of an accidental run is too high; use \"ask\" or \"session\"",
            recipe.name,
        );
    }
    // A `docker`/`docker-compose`/`podman` lifecycle recipe must be `confirm: "ask"`
    // — NOT `session`/`always`. Such a recipe is, by construction, `docker run`
    // with whatever mounts/privileges the compose file (which Claude can edit via
    // `/workspace:rw`) declares — effectively host root. `confirm:session` would
    // let Claude re-run it silently after one approval with a rewritten compose
    // file. So it must re-prompt every time. (See ADR-054 §Negative.)
    if recipe.confirm != crate::config::HostExecConfirm::Ask && is_container_lifecycle_recipe(recipe)
    {
        anyhow::bail!(
            "host_exec recipe '{}': a `docker`/`docker-compose`/`podman` lifecycle recipe \
             (`up`/`down`/`exec`/`rm`/`prune`) must use confirm: \"ask\" — it can mount arbitrary \
             host paths into a privileged container (effectively host root), and the compose file \
             it runs is editable by Claude, so it must re-prompt on every invocation",
            recipe.name,
        );
    }

    Ok(())
}

fn validate_param(recipe_name: &str, param: &HostExecParam) -> anyhow::Result<()> {
    // name: snake_case, same shape as a recipe name (length cap reused — a
    // parameter name longer than 64 chars is absurd and almost certainly a
    // mistake).
    if !is_token_name(&param.name) || param.name.len() > 64 {
        anyhow::bail!(
            "host_exec recipe '{recipe_name}': parameter name '{}' must be lowercase snake_case, \
             start with a letter, max 64 chars",
            param.name,
        );
    }
    // pattern: a bounded string. Semantics validated in the worker (JS RegExp).
    if param.pattern.is_empty() {
        anyhow::bail!(
            "host_exec recipe '{recipe_name}': parameter '{}' has an empty `pattern` — supply a \
             regex (it is anchored as ^(?:…)$ by the worker)",
            param.name,
        );
    }
    if param.pattern.len() > consts::HOST_EXEC_PARAM_PATTERN_MAX_LEN {
        anyhow::bail!(
            "host_exec recipe '{recipe_name}': parameter '{}' `pattern` is too long ({} chars, \
             max {})",
            param.name,
            param.pattern.len(),
            consts::HOST_EXEC_PARAM_PATTERN_MAX_LEN,
        );
    }
    if param.pattern.contains('\0') || param.pattern.contains('\n') || param.pattern.contains('\r')
    {
        anyhow::bail!(
            "host_exec recipe '{recipe_name}': parameter '{}' `pattern` must not contain NUL or \
             line breaks",
            param.name,
        );
    }
    if let Some(max_len) = param.max_len {
        if max_len == 0 {
            anyhow::bail!(
                "host_exec recipe '{recipe_name}': parameter '{}' `maxLen` must be > 0 (omit it \
                 to use the default of {})",
                param.name,
                consts::HOST_EXEC_PARAM_MAX_LEN,
            );
        }
        if max_len > consts::HOST_EXEC_PARAM_MAX_LEN {
            anyhow::bail!(
                "host_exec recipe '{recipe_name}': parameter '{}' `maxLen` ({}) exceeds the \
                 ceiling of {}",
                param.name,
                max_len,
                consts::HOST_EXEC_PARAM_MAX_LEN,
            );
        }
    }
    Ok(())
}

fn validate_cwd_sub(recipe_name: &str, sub: &str) -> anyhow::Result<()> {
    if sub.is_empty() {
        anyhow::bail!(
            "host_exec recipe '{recipe_name}': cwdSub must not be empty (omit it to run in the \
             project root)"
        );
    }
    if has_control_chars(sub) {
        anyhow::bail!(
            "host_exec recipe '{recipe_name}': cwdSub must not contain NUL or line breaks"
        );
    }
    let path = std::path::Path::new(sub);
    if path.is_absolute() {
        anyhow::bail!(
            "host_exec recipe '{recipe_name}': cwdSub '{sub}' must be a relative path inside the \
             project directory, not an absolute path"
        );
    }
    // Reject `..` anywhere — the worker also canonicalises and re-checks at
    // exec time (the project dir isn't known here), but rejecting the obvious
    // case at config-save time gives a clearer error and a defence-in-depth
    // layer. Use the parsed components so `a/../b` and `a/..` are both caught,
    // and a bare `..` segment isn't missed by a naive `contains("..")` (which
    // would also flag a legitimate `..foo` filename — components don't).
    for comp in path.components() {
        match comp {
            std::path::Component::ParentDir => anyhow::bail!(
                "host_exec recipe '{recipe_name}': cwdSub '{sub}' must not contain '..' — it \
                 must stay inside the project directory"
            ),
            std::path::Component::Prefix(_) | std::path::Component::RootDir => anyhow::bail!(
                "host_exec recipe '{recipe_name}': cwdSub '{sub}' must be a plain relative path"
            ),
            std::path::Component::CurDir | std::path::Component::Normal(_) => {}
        }
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::config::HostExecConfirm;
    use std::collections::HashMap;

    fn recipe(name: &str, exec: &str, args: &[&str]) -> HostExecRecipe {
        HostExecRecipe {
            name: name.to_string(),
            exec: exec.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd_sub: None,
            params: None,
            env: None,
            confirm: HostExecConfirm::Ask,
        }
    }

    fn cfg(recipes: Vec<HostExecRecipe>) -> HostExecConfig {
        HostExecConfig {
            enabled: Some(true),
            commands: recipes,
        }
    }

    // -- per-project layout helper -------------------------------------------

    #[test]
    fn host_exec_project_dir_layout() {
        assert_eq!(
            host_exec_project_dir(Path::new("/data"), "myproj"),
            Path::new("/data/host-exec/myproj")
        );
    }

    #[test]
    fn host_exec_project_dir_is_per_project() {
        let a = host_exec_project_dir(Path::new("/data"), "proj-a");
        let b = host_exec_project_dir(Path::new("/data"), "proj-b");
        assert_ne!(a, b, "different projects must get different state dirs");
        assert!(a.starts_with(Path::new("/data/host-exec")));
        assert!(b.starts_with(Path::new("/data/host-exec")));
    }

    // -- happy paths ---------------------------------------------------------

    #[test]
    fn empty_whitelist_is_valid() {
        validate_host_exec_config(&cfg(vec![])).unwrap();
        validate_host_exec_config(&HostExecConfig::default()).unwrap();
    }

    #[test]
    fn basic_recipes_are_valid() {
        validate_host_exec_config(&cfg(vec![
            recipe("test", "./gradlew", &["test"]),
            recipe("build", "./gradlew", &["build", "-x", "test"]),
            recipe("fe_build", "npm", &["run", "build"]),
            recipe("compose_logs", "docker", &["compose", "logs", "--tail=200"]),
        ]))
        .unwrap();
    }

    #[test]
    fn recipe_with_a_parameter_is_valid() {
        let mut r = recipe(
            "psql",
            "docker",
            &["compose", "exec", "-T", "db", "psql", "-c", "{sql}"],
        );
        r.params = Some(vec![HostExecParam {
            name: "sql".to_string(),
            pattern: "^SELECT .{0,500}$".to_string(),
            max_len: Some(600),
        }]);
        // `docker compose exec` is state-changing → must not be `always`;
        // `ask` (the default here) is fine.
        validate_host_exec_config(&cfg(vec![r])).unwrap();
    }

    #[test]
    fn parameter_inside_an_arg_element_is_valid() {
        // `{cls}` is part of a larger arg, not a bare token → allowed even
        // though `node` is a meta-tool, IF exec weren't a meta-tool... here we
        // use gradlew, which isn't. The point: a token inside an element is OK.
        let mut r = recipe("test_one", "./gradlew", &["test", "--tests", "{cls}"]);
        r.params = Some(vec![HostExecParam {
            name: "cls".to_string(),
            pattern: "^[A-Za-z0-9_.]+$".to_string(),
            max_len: None,
        }]);
        validate_host_exec_config(&cfg(vec![r])).unwrap();
    }

    #[test]
    fn env_map_with_safe_keys_is_valid() {
        let mut r = recipe("test", "./gradlew", &["test"]);
        r.env = Some(HashMap::from([
            ("SPRING_PROFILES_ACTIVE".to_string(), "test".to_string()),
            ("CI".to_string(), "true".to_string()),
            ("JAVA_HOME".to_string(), "/opt/jdk-21".to_string()),
        ]));
        validate_host_exec_config(&cfg(vec![r])).unwrap();
    }

    #[test]
    fn cwd_sub_relative_subdir_is_valid() {
        let mut r = recipe("fe_test", "npm", &["test", "--", "--watchAll=false"]);
        r.cwd_sub = Some("frontend".to_string());
        validate_host_exec_config(&cfg(vec![r.clone()])).unwrap();
        r.cwd_sub = Some("services/api".to_string());
        validate_host_exec_config(&cfg(vec![r.clone()])).unwrap();
        r.cwd_sub = Some("./frontend".to_string());
        validate_host_exec_config(&cfg(vec![r])).unwrap();
    }

    #[test]
    fn absolute_exec_is_allowed() {
        // Allowed-but-flagged: the recipe author's deliberate choice (the UI
        // surfaces a hint). Validation does not reject it.
        validate_host_exec_config(&cfg(vec![recipe(
            "compose_up",
            "/usr/local/bin/docker",
            &["compose", "logs"],
        )]))
        .unwrap();
    }

    #[test]
    fn literal_subcommand_through_a_meta_tool_is_valid() {
        // `make test` / `npm run build` — literal sub-commands, not bare params.
        validate_host_exec_config(&cfg(vec![
            recipe("mk", "make", &["test"]),
            recipe("fe_build", "npm", &["run", "build"]),
            recipe("fe_lint", "npm", &["run", "lint"]),
        ]))
        .unwrap();
    }

    #[test]
    fn confirm_session_on_a_state_changing_recipe_is_valid() {
        let mut r = recipe("db_psql", "psql", &["-c", "{q}"]);
        r.params = Some(vec![HostExecParam {
            name: "q".to_string(),
            pattern: "^SELECT.*$".to_string(),
            max_len: None,
        }]);
        r.confirm = HostExecConfirm::Session;
        validate_host_exec_config(&cfg(vec![r])).unwrap();
    }

    // -- name errors ---------------------------------------------------------

    #[test]
    fn rejects_hyphenated_recipe_name() {
        let err =
            validate_host_exec_config(&cfg(vec![recipe("gradle-help", "./gradlew", &["help"])]))
                .unwrap_err()
                .to_string();
        assert!(err.contains("gradle-help"), "{err}");
        assert!(
            err.contains("snake_case") || err.contains("JS identifier"),
            "{err}"
        );
    }

    #[test]
    fn rejects_uppercase_or_leading_digit_recipe_name() {
        assert!(
            validate_host_exec_config(&cfg(vec![recipe("Test", "./gradlew", &["test"])])).is_err()
        );
        assert!(
            validate_host_exec_config(&cfg(vec![recipe("1test", "./gradlew", &["test"])])).is_err()
        );
        assert!(validate_host_exec_config(&cfg(vec![recipe("", "./gradlew", &["test"])])).is_err());
    }

    #[test]
    fn rejects_overlong_recipe_name() {
        let long = "a".repeat(65);
        assert!(
            validate_host_exec_config(&cfg(vec![recipe(&long, "./gradlew", &["test"])])).is_err()
        );
    }

    #[test]
    fn rejects_duplicate_recipe_name() {
        let err = validate_host_exec_config(&cfg(vec![
            recipe("test", "./gradlew", &["test"]),
            recipe("test", "npm", &["test"]),
        ]))
        .unwrap_err()
        .to_string();
        assert!(err.contains("duplicate"), "{err}");
        assert!(err.contains("test"), "{err}");
    }

    // -- exec errors ---------------------------------------------------------

    #[test]
    fn rejects_shell_launcher_exec() {
        for sh in [
            "bash",
            "sh",
            "zsh",
            "/bin/bash",
            "./sh",
            "bash.exe",
            "ENV",
            "xargs",
            "find",
            "ssh",
            // `busybox sh -c {x}` / `toybox sh -c {x}` is a shell.
            "busybox",
            "toybox",
            "/bin/busybox",
        ] {
            let err = validate_host_exec_config(&cfg(vec![recipe("x", sh, &["-c", "{cmd}"])]))
                .unwrap_err()
                .to_string();
            assert!(
                err.contains("direct shell/eval launcher"),
                "exec {sh:?} should be rejected as a shell launcher; got: {err}"
            );
        }
    }

    #[test]
    fn path_based_exec_bypasses_basename_ban_by_design() {
        // Documented residual (ADR-054 §Negative): the launcher / meta-tool
        // checks are by *basename*, so a *path* — `./node_modules/.bin/node`,
        // here `./node_modules/.bin/some-tool` with a bare-param arg — is NOT
        // caught by the `node`/meta-tool rules. Intentional: the recipe author
        // chose it. Pin the behaviour so a future "tighten the ban" change is a
        // conscious one. (The bare-param `{x}` is fine here because `some-tool`
        // is not in HOST_EXEC_META_TOOLS — only `node`/`python`/`make`/… are.)
        let mut r = recipe("run_x", "./node_modules/.bin/some-tool", &["{x}"]);
        r.params = Some(vec![HostExecParam {
            name: "x".to_string(),
            pattern: "^[a-z]+$".to_string(),
            max_len: Some(32),
        }]);
        validate_host_exec_config(&cfg(vec![r])).unwrap_or_else(|e| {
            panic!("a path-based exec (basename not on the ban/meta lists) should be allowed; got: {e}")
        });
    }

    #[test]
    fn rejects_exec_with_dotdot_or_equals_or_control() {
        assert!(validate_host_exec_config(&cfg(vec![recipe("x", "../evil/tool", &[])])).is_err());
        assert!(validate_host_exec_config(&cfg(vec![recipe("x", "FOO=bar", &[])])).is_err());
        assert!(validate_host_exec_config(&cfg(vec![recipe("x", "to\nol", &[])])).is_err());
        assert!(validate_host_exec_config(&cfg(vec![recipe("x", "", &[])])).is_err());
    }

    // -- parameterised-meta-invocation rule ----------------------------------

    #[test]
    fn rejects_bare_param_through_a_meta_tool() {
        for (exec, arg) in [
            ("make", "{target}"),
            ("node", "{script}"),
            ("python", "{f}"),
            ("python3", "{f}"),
            ("npm", "{x}"),
            ("npx", "{x}"),
            ("yarn", "{x}"),
            ("/usr/bin/node", "{x}"),
            // `awk '{prog}'` runs an arbitrary AWK program (with `system()`).
            ("awk", "{prog}"),
            ("gawk", "{prog}"),
            ("mawk", "{prog}"),
            ("nawk", "{prog}"),
        ] {
            let mut r = recipe("x", exec, &[arg]);
            r.params = Some(vec![HostExecParam {
                name: arg.trim_matches(['{', '}']).to_string(),
                pattern: "^[A-Za-z0-9_.-]+$".to_string(),
                max_len: None,
            }]);
            let err = validate_host_exec_config(&cfg(vec![r]))
                .unwrap_err()
                .to_string();
            assert!(
                err.contains("meta-tool") && err.contains("bare parameter"),
                "exec {exec:?} arg {arg:?} should be rejected; got: {err}"
            );
        }
    }

    #[test]
    fn allows_bare_param_through_a_non_meta_tool() {
        // `./gradlew {task}` — gradlew is a repo wrapper script, not a generic
        // interpreter; a parameter for the task name is fine (the parameter's
        // own regex is what constrains it). This is allowed.
        let mut r = recipe("gradle_task", "./gradlew", &["{task}"]);
        r.params = Some(vec![HostExecParam {
            name: "task".to_string(),
            pattern: "^[a-z][a-zA-Z0-9]*$".to_string(),
            max_len: Some(64),
        }]);
        validate_host_exec_config(&cfg(vec![r])).unwrap();
    }

    // -- args/params cross-checks --------------------------------------------

    #[test]
    fn rejects_arg_token_without_a_params_entry() {
        let err = validate_host_exec_config(&cfg(vec![recipe(
            "psql",
            "docker",
            &["compose", "exec", "db", "psql", "-c", "{sql}"],
        )]))
        .unwrap_err()
        .to_string();
        assert!(err.contains("{sql}") || err.contains("sql"), "{err}");
        assert!(err.contains("params"), "{err}");
    }

    #[test]
    fn rejects_declared_param_never_used() {
        let mut r = recipe("test", "./gradlew", &["test"]);
        r.params = Some(vec![HostExecParam {
            name: "unused".to_string(),
            pattern: "^.*$".to_string(),
            max_len: None,
        }]);
        let err = validate_host_exec_config(&cfg(vec![r]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("unused"), "{err}");
        assert!(err.contains("never used"), "{err}");
    }

    #[test]
    fn rejects_duplicate_param_name() {
        let mut r = recipe("q", "psql", &["-c", "{a}", "-c", "{a}"]);
        r.params = Some(vec![
            HostExecParam {
                name: "a".to_string(),
                pattern: "^x$".to_string(),
                max_len: None,
            },
            HostExecParam {
                name: "a".to_string(),
                pattern: "^y$".to_string(),
                max_len: None,
            },
        ]);
        r.confirm = HostExecConfirm::Session; // psql is state-changing
        let err = validate_host_exec_config(&cfg(vec![r]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("duplicate parameter"), "{err}");
    }

    #[test]
    fn rejects_arg_with_control_chars() {
        assert!(validate_host_exec_config(&cfg(vec![recipe("x", "./tool", &["a\nb"])])).is_err());
        assert!(validate_host_exec_config(&cfg(vec![recipe("x", "./tool", &["a\0b"])])).is_err());
    }

    // -- param errors --------------------------------------------------------

    #[test]
    fn rejects_param_bad_name() {
        let mut r = recipe("x", "./tool", &["{Bad}"]);
        r.params = Some(vec![HostExecParam {
            name: "Bad".to_string(),
            pattern: "^x$".to_string(),
            max_len: None,
        }]);
        // `{Bad}` isn't a recognised token (uppercase), so it's treated as a
        // literal — meaning the *declared* param "Bad" is "never used". Either
        // way it errors; assert it does.
        assert!(validate_host_exec_config(&cfg(vec![r])).is_err());

        let mut r2 = recipe("x", "./tool", &["{ok}"]);
        r2.params = Some(vec![HostExecParam {
            name: "1bad".to_string(),
            pattern: "^x$".to_string(),
            max_len: None,
        }]);
        assert!(validate_host_exec_config(&cfg(vec![r2])).is_err());
    }

    #[test]
    fn rejects_empty_or_overlong_pattern() {
        let mut r = recipe("x", "./tool", &["{p}"]);
        r.params = Some(vec![HostExecParam {
            name: "p".to_string(),
            pattern: String::new(),
            max_len: None,
        }]);
        assert!(validate_host_exec_config(&cfg(vec![r.clone()])).is_err());

        r.params = Some(vec![HostExecParam {
            name: "p".to_string(),
            pattern: "a".repeat(consts::HOST_EXEC_PARAM_PATTERN_MAX_LEN + 1),
            max_len: None,
        }]);
        assert!(validate_host_exec_config(&cfg(vec![r])).is_err());
    }

    #[test]
    fn rejects_bad_max_len() {
        let mut r = recipe("x", "./tool", &["{p}"]);
        r.params = Some(vec![HostExecParam {
            name: "p".to_string(),
            pattern: "^.*$".to_string(),
            max_len: Some(0),
        }]);
        assert!(validate_host_exec_config(&cfg(vec![r.clone()])).is_err());
        r.params = Some(vec![HostExecParam {
            name: "p".to_string(),
            pattern: "^.*$".to_string(),
            max_len: Some(consts::HOST_EXEC_PARAM_MAX_LEN + 1),
        }]);
        assert!(validate_host_exec_config(&cfg(vec![r])).is_err());
    }

    #[test]
    fn rejects_pattern_with_control_chars() {
        let mut r = recipe("x", "./tool", &["{p}"]);
        r.params = Some(vec![HostExecParam {
            name: "p".to_string(),
            pattern: "^a\nb$".to_string(),
            max_len: None,
        }]);
        assert!(validate_host_exec_config(&cfg(vec![r])).is_err());
    }

    // -- cwd_sub errors ------------------------------------------------------

    #[test]
    fn rejects_cwd_sub_with_dotdot() {
        for bad in ["..", "../escape", "frontend/../../etc", "a/.."] {
            let mut r = recipe("x", "./tool", &[]);
            r.cwd_sub = Some(bad.to_string());
            let err = validate_host_exec_config(&cfg(vec![r]))
                .unwrap_err()
                .to_string();
            assert!(
                err.contains("'..'") || err.contains(".."),
                "cwdSub {bad:?}: {err}"
            );
        }
    }

    #[test]
    fn rejects_absolute_cwd_sub() {
        let mut r = recipe("x", "./tool", &[]);
        r.cwd_sub = Some("/etc".to_string());
        assert!(validate_host_exec_config(&cfg(vec![r.clone()])).is_err());
        r.cwd_sub = Some(String::new());
        assert!(validate_host_exec_config(&cfg(vec![r])).is_err());
    }

    #[test]
    fn allows_dotfile_cwd_sub_segment() {
        // `..foo` is a legitimate directory name, not `..` — must NOT be
        // rejected (a naive `contains("..")` would wrongly flag it).
        let mut r = recipe("x", "./tool", &[]);
        r.cwd_sub = Some("..config-dir".to_string());
        validate_host_exec_config(&cfg(vec![r.clone()])).unwrap();
        r.cwd_sub = Some("a/..b/c".to_string());
        validate_host_exec_config(&cfg(vec![r])).unwrap();
    }

    // -- env errors ----------------------------------------------------------

    #[test]
    fn rejects_reserved_env_key() {
        for bad in [
            "PATH",
            "path",
            "HOME",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "NODE_OPTIONS",
            "BASH_ENV",
            "PORT",
        ] {
            let mut r = recipe("x", "./tool", &[]);
            r.env = Some(HashMap::from([(bad.to_string(), "v".to_string())]));
            let err = validate_host_exec_config(&cfg(vec![r]))
                .unwrap_err()
                .to_string();
            assert!(err.contains("reserved"), "env key {bad:?}: {err}");
        }
    }

    #[test]
    fn rejects_env_key_or_value_with_control_chars_or_equals() {
        let mut r = recipe("x", "./tool", &[]);
        r.env = Some(HashMap::from([("FOO=BAR".to_string(), "v".to_string())]));
        assert!(validate_host_exec_config(&cfg(vec![r.clone()])).is_err());
        r.env = Some(HashMap::from([("FOO".to_string(), "a\nb".to_string())]));
        assert!(validate_host_exec_config(&cfg(vec![r.clone()])).is_err());
        r.env = Some(HashMap::from([("FO\0O".to_string(), "v".to_string())]));
        assert!(validate_host_exec_config(&cfg(vec![r.clone()])).is_err());
        r.env = Some(HashMap::from([(String::new(), "v".to_string())]));
        assert!(validate_host_exec_config(&cfg(vec![r])).is_err());
    }

    // -- confirm:always restriction ------------------------------------------

    #[test]
    fn rejects_confirm_always_on_state_changing_recipes() {
        // database client
        let mut r = recipe("db", "psql", &["-c", "{q}"]);
        r.params = Some(vec![HostExecParam {
            name: "q".to_string(),
            pattern: "^x$".to_string(),
            max_len: None,
        }]);
        r.confirm = HostExecConfirm::Always;
        assert!(validate_host_exec_config(&cfg(vec![r])).is_err());

        // docker compose lifecycle
        let mut r = recipe("up", "docker", &["compose", "up", "-d"]);
        r.confirm = HostExecConfirm::Always;
        assert!(validate_host_exec_config(&cfg(vec![r])).is_err());

        let mut r = recipe("down", "docker-compose", &["down"]);
        r.confirm = HostExecConfirm::Always;
        assert!(validate_host_exec_config(&cfg(vec![r])).is_err());

        // migration
        let mut r = recipe("migrate", "./gradlew", &["flywayMigrate"]);
        r.confirm = HostExecConfirm::Always;
        assert!(validate_host_exec_config(&cfg(vec![r])).is_err());

        let mut r = recipe("mig2", "./mvnw", &["liquibase:update"]);
        r.confirm = HostExecConfirm::Always;
        assert!(validate_host_exec_config(&cfg(vec![r])).is_err());
    }

    #[test]
    fn container_lifecycle_recipe_must_be_confirm_ask() {
        // `docker`/`docker-compose`/`podman` + a lifecycle verb ⇒ confirm must
        // be "ask" (not session/always) — it's `docker run` with mounts/privs
        // from a Claude-editable compose file (≈ host root); must re-prompt.
        for (exec, args) in [
            ("docker", &["compose", "up", "-d"][..]),
            ("docker-compose", &["down"][..]),
            ("podman", &["compose", "up"][..]),
            ("/usr/bin/docker", &["compose", "exec", "db", "sh"][..]),
            ("docker", &["compose", "rm", "-f"][..]),
            ("docker", &["system", "prune"][..]),
        ] {
            let mut r = recipe("c", exec, args);
            r.confirm = HostExecConfirm::Session;
            assert!(
                validate_host_exec_config(&cfg(vec![r.clone()])).is_err(),
                "{exec} {args:?} with confirm:session must be rejected"
            );
            r.confirm = HostExecConfirm::Always;
            assert!(
                validate_host_exec_config(&cfg(vec![r.clone()])).is_err(),
                "{exec} {args:?} with confirm:always must be rejected"
            );
            r.confirm = HostExecConfirm::Ask;
            validate_host_exec_config(&cfg(vec![r])).unwrap_or_else(|e| {
                panic!("{exec} {args:?} with confirm:ask must be allowed; got: {e}")
            });
        }
        // Non-lifecycle docker (`ps`, `build`, `logs`) is unaffected — session OK.
        for args in [
            &["compose", "ps"][..],
            &["build", "-t", "x", "."][..],
            &["compose", "logs"][..],
        ] {
            let mut r = recipe("c", "docker", args);
            r.confirm = HostExecConfirm::Session;
            validate_host_exec_config(&cfg(vec![r.clone()])).unwrap_or_else(|e| {
                panic!("docker {args:?} confirm:session should be allowed; got: {e}")
            });
            // ...but `build` IS state-changing-ish? no — only lifecycle verbs;
            // `build` isn't on the list, so `always` is also fine here.
            r.confirm = HostExecConfirm::Always;
            // `compose logs`/`compose ps`/`build` are not state-changing either.
            validate_host_exec_config(&cfg(vec![r])).unwrap_or_else(|e| {
                panic!("docker {args:?} confirm:always should be allowed; got: {e}")
            });
        }
    }

    #[test]
    fn allows_confirm_always_on_non_state_changing_recipes() {
        let mut r = recipe("test", "./gradlew", &["test"]);
        r.confirm = HostExecConfirm::Always;
        validate_host_exec_config(&cfg(vec![r])).unwrap();

        let mut r = recipe("fe_build", "npm", &["run", "build"]);
        r.confirm = HostExecConfirm::Always;
        validate_host_exec_config(&cfg(vec![r])).unwrap();

        // `docker compose logs` / `ps` are read-only — not lifecycle verbs.
        let mut r = recipe("compose_ps", "docker", &["compose", "ps"]);
        r.confirm = HostExecConfirm::Always;
        validate_host_exec_config(&cfg(vec![r])).unwrap();
    }

    #[test]
    fn is_state_changing_recipe_classifies_correctly() {
        assert!(is_state_changing_recipe(&recipe(
            "x",
            "psql",
            &["-c", "SELECT 1"]
        )));
        assert!(is_state_changing_recipe(&recipe(
            "x",
            "/usr/bin/mysql",
            &["-e", "..."]
        )));
        assert!(is_state_changing_recipe(&recipe(
            "x",
            "docker",
            &["compose", "up", "-d"]
        )));
        assert!(is_state_changing_recipe(&recipe(
            "x",
            "docker",
            &["compose", "exec", "db", "sh"]
        )));
        assert!(is_state_changing_recipe(&recipe(
            "x",
            "docker-compose",
            &["down"]
        )));
        assert!(is_state_changing_recipe(&recipe(
            "x",
            "./gradlew",
            &["flywayMigrate"]
        )));
        assert!(is_state_changing_recipe(&recipe(
            "x",
            "./mvnw",
            &["liquibase:update"]
        )));
        assert!(is_state_changing_recipe(&recipe(
            "x",
            "rails",
            &["db:migrate"]
        ))); // "migrat" substring

        assert!(!is_state_changing_recipe(&recipe(
            "x",
            "./gradlew",
            &["test"]
        )));
        assert!(!is_state_changing_recipe(&recipe(
            "x",
            "npm",
            &["run", "build"]
        )));
        assert!(!is_state_changing_recipe(&recipe(
            "x",
            "docker",
            &["compose", "ps"]
        )));
        assert!(!is_state_changing_recipe(&recipe(
            "x",
            "docker",
            &["compose", "logs"]
        )));
        assert!(!is_state_changing_recipe(&recipe(
            "x",
            "docker",
            &["build", "-t", "x", "."]
        )));
    }

    // -- helper unit tests ---------------------------------------------------

    #[test]
    fn exec_basename_lower_strips_dirs_and_exe() {
        assert_eq!(exec_basename_lower("./gradlew"), "gradlew");
        assert_eq!(exec_basename_lower("/usr/bin/Python3"), "python3");
        assert_eq!(exec_basename_lower("BASH.EXE"), "bash");
        assert_eq!(exec_basename_lower("docker-compose"), "docker-compose");
        assert_eq!(exec_basename_lower(r"C:\tools\node.exe"), "node");
        assert_eq!(exec_basename_lower("npm"), "npm");
    }

    #[test]
    fn arg_param_refs_recognises_tokens() {
        assert_eq!(arg_param_refs("{sql}"), (vec!["sql".to_string()], true));
        assert_eq!(
            arg_param_refs("--tests={cls}"),
            (vec!["cls".to_string()], false)
        );
        assert_eq!(
            arg_param_refs("psql -c {q} --more"),
            (vec!["q".to_string()], false)
        );
        assert_eq!(arg_param_refs("test"), (Vec::<String>::new(), false));
        assert_eq!(arg_param_refs("{}"), (Vec::<String>::new(), false)); // empty name → literal
        assert_eq!(arg_param_refs("{1abc}"), (Vec::<String>::new(), false)); // bad name → literal
        assert_eq!(arg_param_refs("{unclosed"), (Vec::<String>::new(), false));
        assert_eq!(
            arg_param_refs("{a}{b}"),
            (vec!["a".to_string(), "b".to_string()], false)
        );
    }

    #[test]
    fn host_exec_config_snapshot_shape() {
        use crate::config::host_exec_config_snapshot;
        let recipes = vec![recipe("test", "./gradlew", &["test"])];
        let snap = host_exec_config_snapshot(std::path::Path::new("/home/u/proj"), &recipes);
        assert_eq!(snap["projectDir"], "/home/u/proj");
        assert_eq!(snap["commands"].as_array().unwrap().len(), 1);
        assert_eq!(snap["commands"][0]["name"], "test");
        assert_eq!(snap["commands"][0]["exec"], "./gradlew");
        assert_eq!(snap["commands"][0]["args"][0], "test");
        // `confirm` defaults to "ask" and is serialised lowercase.
        assert_eq!(snap["commands"][0]["confirm"], "ask");
    }

    #[test]
    fn host_exec_confirm_serde_lowercase() {
        assert_eq!(
            serde_json::to_value(HostExecConfirm::Ask).unwrap(),
            serde_json::json!("ask")
        );
        assert_eq!(
            serde_json::to_value(HostExecConfirm::Session).unwrap(),
            serde_json::json!("session")
        );
        assert_eq!(
            serde_json::to_value(HostExecConfirm::Always).unwrap(),
            serde_json::json!("always")
        );
        assert_eq!(
            serde_json::from_value::<HostExecConfirm>(serde_json::json!("session")).unwrap(),
            HostExecConfirm::Session
        );
    }
}
