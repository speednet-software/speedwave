/// Validates that a project name is safe for filesystem paths and container names.
/// Rejects empty names, names starting with non-alphanumeric chars, names exceeding 63 characters,
/// and path traversal.
pub fn validate_project_name(name: &str) -> anyhow::Result<()> {
    if name.is_empty() {
        anyhow::bail!("project name is empty");
    }
    if name.len() > 63 {
        anyhow::bail!(
            "project name '{}' is too long ({} chars, max 63)",
            name,
            name.len()
        );
    }
    let first = name.as_bytes()[0];
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        if first.is_ascii_uppercase() {
            anyhow::bail!(
                "project name '{}' contains uppercase letter '{}' (container engines require lowercase). Try '{}'",
                name,
                first as char,
                name.to_ascii_lowercase()
            );
        }
        anyhow::bail!("project name '{}' must start with a letter or digit", name);
    }
    if let Some(c) = name.chars().find(|c| {
        !c.is_ascii_lowercase() && !c.is_ascii_digit() && *c != '_' && *c != '.' && *c != '-'
    }) {
        if c.is_ascii_uppercase() {
            anyhow::bail!(
                "project name '{}' contains uppercase letter '{}' (container engines require lowercase). Try '{}'",
                name,
                c,
                name.to_ascii_lowercase()
            );
        }
        anyhow::bail!(
            "project name '{}' contains invalid character '{}' (only a-z, 0-9, _, ., - allowed)",
            name,
            c
        );
    }
    // Reject path traversal attempts
    if name.contains("..") {
        anyhow::bail!("project name '{}' contains path traversal", name);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_project_name_valid() {
        assert!(validate_project_name("my-project").is_ok());
        assert!(validate_project_name("project_1.0").is_ok());
        assert!(validate_project_name("a").is_ok());
    }

    #[test]
    fn test_validate_project_name_uppercase_rejected() {
        let err = validate_project_name("MyProject").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("uppercase"), "should mention uppercase: {msg}");
        assert!(msg.contains("myproject"), "should suggest lowercase: {msg}");
    }

    #[test]
    fn test_validate_project_name_empty() {
        assert!(validate_project_name("").is_err());
    }

    #[test]
    fn test_validate_project_name_starts_with_special() {
        assert!(validate_project_name("-project").is_err());
        assert!(validate_project_name(".hidden").is_err());
    }

    #[test]
    fn test_validate_project_name_invalid_chars() {
        assert!(validate_project_name("my project").is_err());
        assert!(validate_project_name("path/name").is_err());
        assert!(validate_project_name("caf\u{00e9}").is_err());
    }

    #[test]
    fn test_validate_project_name_max_length_ok() {
        let name = "a".repeat(63);
        assert!(validate_project_name(&name).is_ok());
    }

    #[test]
    fn test_validate_project_name_too_long() {
        let name = "a".repeat(64);
        let err = validate_project_name(&name).unwrap_err();
        assert!(err.to_string().contains("too long"));
    }

    #[test]
    fn test_validate_project_name_path_traversal() {
        assert!(validate_project_name("..").is_err());
        assert!(validate_project_name("a..b").is_err());
    }
}
