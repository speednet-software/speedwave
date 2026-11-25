//! Moves every plaintext secret of the data directory into the encrypted secret store: token files
//! of built-in and plugin integrations, LLM provider and local LLM keys, the Anthropic API key, the
//! PII key, and the refresh token and client secret inside the OAuth state and seed files. Also
//! removes generated compose files and snapshots that carry plaintext secrets. A plaintext copy is
//! deleted only after the encrypted copy was written and read back, or when an encrypted file
//! already exists for it. Jira: SPEED-1016.
//! Added in: v0.23.0

mod generated;
mod oauth;
mod project_files;
mod tokens;
mod walk;

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests;

use std::path::Path;

use speedwave_runtime::plugin::{self, PluginManifest};
use speedwave_runtime::secret_store::{secret_exists_in, SecretName, SecretStore};

use crate::Migration;

pub(super) const MIGRATION: Migration = Migration {
    name: "secrets_at_rest",
    run: migrate,
};

struct Run<'a> {
    data_dir: &'a Path,
    manifests: Vec<PluginManifest>,
    store: Option<SecretStore>,
    failures: Vec<String>,
    migrated: usize,
    skipped: usize,
    unlisted: usize,
    stale_files: usize,
}

fn migrate(data_dir: &Path) -> Result<(), String> {
    let mut run = Run::new(data_dir);
    oauth::migrate(&mut run);
    tokens::migrate(&mut run);
    project_files::migrate(&mut run);
    generated::migrate(&mut run);
    run.finish()
}

impl<'a> Run<'a> {
    fn new(data_dir: &'a Path) -> Self {
        let manifests =
            plugin::list_installed_from_dir(&data_dir.join("plugins")).unwrap_or_else(|_| {
                log::warn!("the installed plugin manifests could not be listed");
                Vec::new()
            });
        Self {
            data_dir,
            manifests,
            store: None,
            failures: Vec::new(),
            migrated: 0,
            skipped: 0,
            unlisted: 0,
            stale_files: 0,
        }
    }

    fn finish(self) -> Result<(), String> {
        if self.migrated > 0 || self.skipped > 0 {
            log::info!(
                "secrets at rest: {} secret(s) moved into the store, {} item(s) skipped",
                self.migrated,
                self.skipped
            );
        }
        let mut problems = self.failures;
        if self.unlisted > 0 {
            problems.push(format!(
                "{} director(ies) could not be listed.",
                self.unlisted
            ));
        }
        if self.stale_files > 0 {
            problems.push(format!(
                "{} generated file(s) with plaintext secrets could not be removed.",
                self.stale_files
            ));
        }
        if problems.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "{} problem(s): {}",
                problems.len(),
                problems.join(" ")
            ))
        }
    }

    fn manifest_by_config_key(&self, key: &str) -> Option<&PluginManifest> {
        self.manifests
            .iter()
            .find(|manifest| manifest.config_key() == key)
    }

    fn manifest_by_slug(&self, slug: &str) -> Option<&PluginManifest> {
        self.manifests.iter().find(|manifest| manifest.slug == slug)
    }

    fn store_secret(&mut self, name: &SecretName, value: &str) -> bool {
        let already_stored = secret_exists_in(self.data_dir, name);
        let Some(store) = self.open_store() else {
            return false;
        };
        if already_stored {
            return true;
        }
        if store.ensure_key().is_err() || store.write(name, value).is_err() {
            return false;
        }
        match store.read(name) {
            Ok(Some(stored)) => same_bytes(stored.as_bytes(), value.as_bytes()),
            _ => false,
        }
    }

    fn open_store(&mut self) -> Option<&SecretStore> {
        if self.store.is_none() {
            self.store = SecretStore::open(self.data_dir).ok();
        }
        self.store.as_ref()
    }

    fn fail_integration(&mut self, project: &str, service: &str) {
        self.record_failure(format!(
            "Integration {service} (project {project}): could not encrypt the secret. Speedwave will try again on the next start."
        ));
    }

    fn fail_pii_key(&mut self, project: &str) {
        self.record_failure(format!(
            "project {project}: the PII key could not be migrated"
        ));
    }

    fn record_failure(&mut self, message: String) {
        if !self.failures.contains(&message) {
            self.failures.push(message);
        }
    }
}

fn same_bytes(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}
