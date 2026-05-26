//! Child-process environment policy shared by every host MCP worker.
//!
//! `apply_child_env` clears the inherited environment so secrets in the
//! parent (API keys, tokens) cannot leak to the worker, then re-adds
//! only the variables the child needs. The `EnvSource` indirection lets
//! tests inject a `FakeEnv` instead of mutating process-global state.

use std::process::Command;

use crate::consts;

/// Windows system environment variables required for Node.js OpenSSL
/// CSPRNG (BCryptGenRandom) initialization. Without these, `node.exe`
/// aborts with "Assertion failed: ncrypto::CSPRNG(nullptr, 0)".
#[cfg(target_os = "windows")]
pub const WINDOWS_SYSTEM_ENV_VARS: &[&str] = &[
    "SystemRoot",
    "SYSTEMDRIVE",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "PROGRAMDATA",
];

/// On non-Windows targets the list is empty — Unix-y shells don't have
/// equivalent system vars Node.js depends on at startup.
#[cfg(not(target_os = "windows"))]
pub const WINDOWS_SYSTEM_ENV_VARS: &[&str] = &[];

/// Source of environment values. Production reads `std::env`; tests
/// provide a `FakeEnv` so they don't race with each other or with
/// concurrent Speedwave instances on the host.
pub trait EnvSource {
    fn var(&self, key: &str) -> Option<String>;
}

/// Real implementation reading from `std::env`.
pub struct CurrentProcessEnv;

impl EnvSource for CurrentProcessEnv {
    fn var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

/// Apply the child-process environment policy to `cmd`.
///
/// Clears the inherited environment then re-adds only PATH,
/// HOME/USERPROFILE, optional Windows CSPRNG vars, and
/// `SPEEDWAVE_RESOURCES_DIR`/`SPEEDWAVE_PROD` when the parent is a
/// bundled .app. `path_override` lets callers (notably `host_exec`)
/// substitute the recovered login-shell PATH; pass `None` to forward
/// the inherited PATH instead.
pub fn apply_child_env(cmd: &mut Command, path_override: Option<&str>, env: &dyn EnvSource) {
    cmd.env_clear();

    #[cfg(target_os = "windows")]
    {
        for key in WINDOWS_SYSTEM_ENV_VARS {
            if let Some(val) = env.var(key) {
                cmd.env(key, val);
            }
        }
    }

    let path = match path_override {
        Some(p) => p.to_string(),
        None => env.var("PATH").unwrap_or_default(),
    };
    cmd.env("PATH", path);

    #[cfg(not(target_os = "windows"))]
    if let Some(home) = env.var("HOME") {
        cmd.env("HOME", home);
    }

    if let Some(res) = env.var(consts::BUNDLE_RESOURCES_ENV) {
        if !res.is_empty() {
            cmd.env(consts::BUNDLE_RESOURCES_ENV, &res);
            cmd.env("SPEEDWAVE_PROD", "1");
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
pub(crate) mod test_support {
    use super::EnvSource;
    use std::collections::HashMap;

    /// Test-only [`EnvSource`] that returns canned values without
    /// reading `std::env`. Used by every worker's env-policy tests so
    /// they don't race with each other or with the host shell.
    pub struct FakeEnv {
        pub vars: HashMap<String, String>,
    }

    impl FakeEnv {
        pub fn empty() -> Self {
            Self {
                vars: HashMap::new(),
            }
        }

        pub fn with(mut self, key: &str, value: &str) -> Self {
            self.vars.insert(key.to_string(), value.to_string());
            self
        }
    }

    impl EnvSource for FakeEnv {
        fn var(&self, key: &str) -> Option<String> {
            self.vars.get(key).cloned()
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::test_support::FakeEnv;
    use super::*;

    #[test]
    fn apply_child_env_clears_inherited_secrets() {
        let env = FakeEnv::empty()
            .with("PATH", "/usr/bin")
            .with("HOME", "/home/u");
        let mut cmd = Command::new("true");
        cmd.env("LEAK_KEY", "should-be-cleared");
        apply_child_env(&mut cmd, None, &env);
        let envs: Vec<_> = cmd.get_envs().collect();
        for (k, v) in envs {
            let k = k.to_string_lossy();
            if k == "LEAK_KEY" {
                assert!(v.is_none(), "LEAK_KEY must be cleared, got {v:?}");
            }
        }
    }

    #[test]
    fn apply_child_env_forwards_path_when_no_override() {
        let env = FakeEnv::empty().with("PATH", "/inherited/path");
        let mut cmd = Command::new("true");
        apply_child_env(&mut cmd, None, &env);
        let path = cmd
            .get_envs()
            .find(|(k, _)| k.to_string_lossy() == "PATH")
            .and_then(|(_, v)| v.map(|s| s.to_string_lossy().to_string()));
        assert_eq!(path.as_deref(), Some("/inherited/path"));
    }

    #[test]
    fn apply_child_env_uses_path_override_when_present() {
        let env = FakeEnv::empty().with("PATH", "/inherited");
        let mut cmd = Command::new("true");
        apply_child_env(&mut cmd, Some("/recovered/login-shell"), &env);
        let path = cmd
            .get_envs()
            .find(|(k, _)| k.to_string_lossy() == "PATH")
            .and_then(|(_, v)| v.map(|s| s.to_string_lossy().to_string()));
        assert_eq!(path.as_deref(), Some("/recovered/login-shell"));
    }

    #[test]
    fn apply_child_env_defaults_path_to_empty_when_unset() {
        let env = FakeEnv::empty();
        let mut cmd = Command::new("true");
        apply_child_env(&mut cmd, None, &env);
        let path = cmd
            .get_envs()
            .find(|(k, _)| k.to_string_lossy() == "PATH")
            .and_then(|(_, v)| v.map(|s| s.to_string_lossy().to_string()));
        assert_eq!(path.as_deref(), Some(""));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn apply_child_env_forwards_home_on_unix() {
        let env = FakeEnv::empty().with("HOME", "/home/u");
        let mut cmd = Command::new("true");
        apply_child_env(&mut cmd, None, &env);
        let home = cmd
            .get_envs()
            .find(|(k, _)| k.to_string_lossy() == "HOME")
            .and_then(|(_, v)| v.map(|s| s.to_string_lossy().to_string()));
        assert_eq!(home.as_deref(), Some("/home/u"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn apply_child_env_omits_home_when_unset() {
        let env = FakeEnv::empty();
        let mut cmd = Command::new("true");
        apply_child_env(&mut cmd, None, &env);
        let has_home = cmd
            .get_envs()
            .any(|(k, v)| k.to_string_lossy() == "HOME" && v.is_some());
        assert!(!has_home, "HOME should not be forwarded when unset");
    }

    #[test]
    fn apply_child_env_forwards_resources_dir_and_sets_prod() {
        let env = FakeEnv::empty().with(
            consts::BUNDLE_RESOURCES_ENV,
            "/Apps/Speedwave.app/Contents/Resources",
        );
        let mut cmd = Command::new("true");
        apply_child_env(&mut cmd, None, &env);
        let res = cmd
            .get_envs()
            .find(|(k, _)| k.to_string_lossy() == consts::BUNDLE_RESOURCES_ENV)
            .and_then(|(_, v)| v.map(|s| s.to_string_lossy().to_string()));
        let prod = cmd
            .get_envs()
            .find(|(k, _)| k.to_string_lossy() == "SPEEDWAVE_PROD")
            .and_then(|(_, v)| v.map(|s| s.to_string_lossy().to_string()));
        assert_eq!(
            res.as_deref(),
            Some("/Apps/Speedwave.app/Contents/Resources")
        );
        assert_eq!(prod.as_deref(), Some("1"));
    }

    #[test]
    fn apply_child_env_treats_empty_resources_as_unset() {
        let env = FakeEnv::empty().with(consts::BUNDLE_RESOURCES_ENV, "");
        let mut cmd = Command::new("true");
        apply_child_env(&mut cmd, None, &env);
        let has_prod = cmd
            .get_envs()
            .any(|(k, v)| k.to_string_lossy() == "SPEEDWAVE_PROD" && v.is_some());
        assert!(!has_prod, "empty resources dir must not set SPEEDWAVE_PROD");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn apply_child_env_forwards_windows_csprng_vars() {
        let env = FakeEnv::empty()
            .with("SystemRoot", "C:\\Windows")
            .with("APPDATA", "C:\\Users\\u\\AppData\\Roaming");
        let mut cmd = Command::new("true");
        apply_child_env(&mut cmd, None, &env);
        let has_sysroot = cmd.get_envs().any(|(k, v)| {
            k.to_string_lossy() == "SystemRoot"
                && v.is_some_and(|s| s.to_string_lossy() == "C:\\Windows")
        });
        let has_appdata = cmd
            .get_envs()
            .any(|(k, v)| k.to_string_lossy() == "APPDATA" && v.is_some());
        assert!(has_sysroot && has_appdata);
    }
}
