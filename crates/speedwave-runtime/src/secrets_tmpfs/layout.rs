//! Slot layout and payload types of the secrets tmpfs; pure data, no IO.

use std::fmt;

/// Root of the dedicated secrets tmpfs inside the VM.
pub(crate) const VM_ROOT: &str = "/run/speedwave-secrets";

pub(crate) const PURPOSE_TOKENS: &str = "tokens";
pub(crate) const PURPOSE_AUTH: &str = "auth";
pub(crate) const PURPOSE_SECRETS: &str = "secrets";
pub(crate) const PURPOSE_CONFIG: &str = "config";
pub(crate) const PURPOSE_POLICY: &str = "policy";

pub(crate) fn purpose_git_tokens(kind_key: &str) -> String {
    format!("git-{kind_key}")
}

/// One tmpfs directory of one container: `<VM_ROOT>/<project>/<service>/<purpose>`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Slot {
    service: String,
    purpose: String,
}

impl Slot {
    pub(crate) fn new(service: &str, purpose: &str) -> anyhow::Result<Self> {
        validate_slot_component(service)?;
        validate_slot_component(purpose)?;
        Ok(Self {
            service: service.to_string(),
            purpose: purpose.to_string(),
        })
    }

    /// Absolute directory of this slot inside the VM.
    pub(crate) fn vm_dir(&self, project: &str) -> String {
        format!("{VM_ROOT}/{project}/{}/{}", self.service, self.purpose)
    }

    pub(crate) fn frame_id(&self) -> String {
        format!("{}/{}", self.service, self.purpose)
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct SecretFile {
    pub(crate) name: String,
    pub(crate) content: Vec<u8>,
}

impl SecretFile {
    pub(crate) fn new(name: impl Into<String>, content: impl Into<Vec<u8>>) -> Self {
        Self {
            name: name.into(),
            content: content.into(),
        }
    }
}

impl fmt::Debug for SecretFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecretFile")
            .field("name", &self.name)
            .field("content", &format_args!("<{} bytes>", self.content.len()))
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SlotFiles {
    pub(crate) slot: Slot,
    pub(crate) files: Vec<SecretFile>,
    pub(crate) keep: Vec<String>,
}

impl SlotFiles {
    pub(crate) fn new(slot: Slot, files: Vec<SecretFile>) -> Self {
        Self {
            slot,
            files,
            keep: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ProjectPayload {
    pub(crate) slots: Vec<SlotFiles>,
}

pub(crate) fn validate_file_name(name: &str) -> anyhow::Result<()> {
    if name.is_empty() || name == "." || name == ".." {
        anyhow::bail!("invalid secret file name '{name}'");
    }
    if let Some(c) = name
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
    {
        anyhow::bail!("secret file name '{name}' contains '{c}'");
    }
    Ok(())
}

fn validate_slot_component(component: &str) -> anyhow::Result<()> {
    validate_file_name(component)?;
    let starts_alphanumeric = component
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if !starts_alphanumeric || component.chars().any(|c| c.is_ascii_uppercase()) {
        anyhow::bail!("invalid slot component '{component}'");
    }
    Ok(())
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code asserts via unwrap")]
mod tests {
    use super::*;

    #[test]
    fn slot_dir_joins_root_project_service_and_purpose() {
        let slot = Slot::new("mcp-slack", PURPOSE_TOKENS).unwrap();
        assert_eq!(
            slot.vm_dir("acme"),
            "/run/speedwave-secrets/acme/mcp-slack/tokens"
        );
        assert_eq!(slot.frame_id(), "mcp-slack/tokens");
    }

    #[test]
    fn git_purpose_is_a_valid_slot_component() {
        let slot = Slot::new("proxy", &purpose_git_tokens("github")).unwrap();
        assert_eq!(slot.frame_id(), "proxy/git-github");
    }

    #[test]
    fn slot_rejects_components_outside_the_charset() {
        for bad in [
            "", ".", "..", "a/b", "a b", "Upper", "_lead", "-lead", "a\nb", "é",
        ] {
            assert!(Slot::new(bad, PURPOSE_TOKENS).is_err(), "service {bad:?}");
            assert!(Slot::new("proxy", bad).is_err(), "purpose {bad:?}");
        }
    }

    #[test]
    fn file_names_allow_leading_underscore_but_not_traversal() {
        assert!(validate_file_name("_settings.json").is_ok());
        assert!(validate_file_name("access_token").is_ok());
        for bad in ["", ".", "..", "a/b", "a b", "a\n", "a;b"] {
            assert!(validate_file_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn secret_file_debug_hides_the_content() {
        let file = SecretFile::new("token", "hunter2-super-secret");
        let rendered = format!(
            "{file:?} {:?}",
            SlotFiles::new(Slot::new("a", "b").unwrap(), vec![file.clone()])
        );
        assert!(!rendered.contains("hunter2"));
        assert!(rendered.contains("token"));
        assert!(rendered.contains("20 bytes"));
    }
}
