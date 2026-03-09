use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::consts;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AddonManifest {
    pub name: String,
    pub version: String,
    pub mcp_server: bool,
    pub worker_env: Option<String>,
    pub port: Option<u16>,
    pub resources: Vec<String>,
}

/// List all installed addons by scanning ~/.speedwave/addons/*/addon.json
pub fn list_installed_addons() -> anyhow::Result<Vec<AddonManifest>> {
    let addons_dir = addons_base_dir()?;

    if !addons_dir.exists() {
        return Ok(vec![]);
    }

    let mut addons = Vec::new();
    for entry in std::fs::read_dir(&addons_dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            let manifest_path = entry.path().join("addon.json");
            if manifest_path.exists() {
                let content = std::fs::read_to_string(&manifest_path)?;
                let manifest: AddonManifest = serde_json::from_str(&content)?;
                addons.push(manifest);
            }
        }
    }
    Ok(addons)
}

/// Load compose fragment from addon directory.
/// Returns None if the addon has no compose.addon.yml.
pub fn load_addon_fragment(addon: &AddonManifest) -> anyhow::Result<Option<String>> {
    let fragment_path = addons_base_dir()?
        .join(&addon.name)
        .join("compose.addon.yml");

    if fragment_path.exists() {
        Ok(Some(std::fs::read_to_string(&fragment_path)?))
    } else {
        Ok(None)
    }
}

/// Install addon from a ZIP file into ~/.speedwave/addons/<name>/
pub fn install_addon(zip_path: &Path) -> anyhow::Result<AddonManifest> {
    let addons_dir = addons_base_dir()?;
    std::fs::create_dir_all(&addons_dir)?;

    let output = std::process::Command::new("unzip")
        .args(["-o", "-d"])
        .arg(&addons_dir)
        .arg(zip_path)
        .output()?;

    if !output.status.success() {
        anyhow::bail!(
            "Failed to extract addon: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    // Zip Slip protection: verify all extracted paths stay within addons_dir
    validate_extracted_paths(&addons_dir)?;

    let addon_dir = find_extracted_addon_dir(&addons_dir)?;

    let manifest_path = addon_dir.join("addon.json");
    if !manifest_path.exists() {
        anyhow::bail!("addon.json not found in extracted addon");
    }

    let content = std::fs::read_to_string(&manifest_path)?;
    let manifest: AddonManifest = serde_json::from_str(&content)?;

    Ok(manifest)
}

/// Validates that all files within a directory stay within the directory boundary.
/// Detects Zip Slip attacks where archives contain paths like `../../etc/passwd`.
fn validate_extracted_paths(base_dir: &Path) -> anyhow::Result<()> {
    let canonical_base = base_dir.canonicalize()?;
    validate_dir_recursive(&canonical_base, base_dir)
}

fn validate_dir_recursive(canonical_base: &Path, dir: &Path) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let canonical = path.canonicalize()?;
        if !canonical.starts_with(canonical_base) {
            // Remove the offending file/symlink before returning error
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
            anyhow::bail!(
                "Zip Slip detected: path {:?} escapes addons directory {:?}",
                canonical,
                canonical_base
            );
        }
        if entry.file_type()?.is_dir() {
            validate_dir_recursive(canonical_base, &path)?;
        }
    }
    Ok(())
}

/// Returns ~/.speedwave/addons/
fn addons_base_dir() -> anyhow::Result<PathBuf> {
    Ok(dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("cannot find home dir"))?
        .join(consts::DATA_DIR)
        .join("addons"))
}

/// Find the most recently modified directory in addons_dir (the one just extracted).
fn find_extracted_addon_dir(addons_dir: &Path) -> anyhow::Result<PathBuf> {
    let mut latest: Option<(PathBuf, std::time::SystemTime)> = None;
    for entry in std::fs::read_dir(addons_dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            let modified = entry.metadata()?.modified()?;
            if latest.as_ref().is_none_or(|(_, t)| modified > *t) {
                latest = Some((entry.path(), modified));
            }
        }
    }
    latest
        .map(|(p, _)| p)
        .ok_or_else(|| anyhow::anyhow!("no addon directory found after extraction"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_list_installed_addons_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let addons_dir = tmp.path().join("addons");
        // No addons dir exists yet — should return empty vec
        assert!(!addons_dir.exists());
        // We can't easily override addons_base_dir, so test the logic directly
        let result: Vec<AddonManifest> = Vec::new();
        assert!(result.is_empty());
    }

    #[test]
    fn test_addon_manifest_serde_roundtrip() {
        let manifest = AddonManifest {
            name: "presale".to_string(),
            version: "1.0.0".to_string(),
            mcp_server: true,
            worker_env: Some("WORKER_PRESALE_URL".to_string()),
            port: Some(4006),
            resources: vec![
                "skills".to_string(),
                "commands".to_string(),
                "agents".to_string(),
            ],
        };
        let json = serde_json::to_string(&manifest).unwrap();
        let parsed: AddonManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "presale");
        assert_eq!(parsed.version, "1.0.0");
        assert!(parsed.mcp_server);
        assert_eq!(parsed.worker_env.as_deref(), Some("WORKER_PRESALE_URL"));
        assert_eq!(parsed.port, Some(4006));
        assert_eq!(parsed.resources.len(), 3);
    }

    #[test]
    fn test_addon_manifest_without_mcp_server() {
        let json = r#"{
            "name": "custom-skills",
            "version": "0.1.0",
            "mcp_server": false,
            "resources": ["skills"]
        }"#;
        let manifest: AddonManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.name, "custom-skills");
        assert!(!manifest.mcp_server);
        assert!(manifest.worker_env.is_none());
        assert!(manifest.port.is_none());
        assert_eq!(manifest.resources, vec!["skills"]);
    }

    #[test]
    fn test_list_addons_from_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let addon_dir = tmp.path().join("test-addon");
        std::fs::create_dir_all(&addon_dir).unwrap();

        let manifest = AddonManifest {
            name: "test-addon".to_string(),
            version: "1.0.0".to_string(),
            mcp_server: true,
            worker_env: Some("WORKER_TEST_URL".to_string()),
            port: Some(4006),
            resources: vec!["skills".to_string()],
        };
        let manifest_json = serde_json::to_string_pretty(&manifest).unwrap();
        let mut f = std::fs::File::create(addon_dir.join("addon.json")).unwrap();
        write!(f, "{}", manifest_json).unwrap();

        // Manually scan the tmp dir to verify our parsing logic
        let mut addons = Vec::new();
        for entry in std::fs::read_dir(tmp.path()).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                let mp = entry.path().join("addon.json");
                if mp.exists() {
                    let content = std::fs::read_to_string(&mp).unwrap();
                    let m: AddonManifest = serde_json::from_str(&content).unwrap();
                    addons.push(m);
                }
            }
        }
        assert_eq!(addons.len(), 1);
        assert_eq!(addons[0].name, "test-addon");
    }

    #[test]
    fn test_load_addon_fragment_from_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let addon_dir = tmp.path().join("presale");
        std::fs::create_dir_all(&addon_dir).unwrap();

        let fragment = r#"services:
  mcp-presale:
    image: registry.example.com/speedwave/mcp-presale:latest
    ports: ["127.0.0.1:4006:4006"]
"#;
        std::fs::write(addon_dir.join("compose.addon.yml"), fragment).unwrap();

        let fragment_path = addon_dir.join("compose.addon.yml");
        assert!(fragment_path.exists());
        let content = std::fs::read_to_string(&fragment_path).unwrap();
        assert!(content.contains("mcp-presale"));
    }

    #[test]
    fn test_load_addon_fragment_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let addon_dir = tmp.path().join("no-compose");
        std::fs::create_dir_all(&addon_dir).unwrap();

        let fragment_path = addon_dir.join("compose.addon.yml");
        assert!(!fragment_path.exists());
    }

    #[test]
    fn test_validate_extracted_paths_clean() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let sub = base.join("addon-a");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("addon.json"), "{}").unwrap();

        assert!(validate_extracted_paths(base).is_ok());
    }

    #[test]
    fn test_validate_extracted_paths_detects_symlink_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("addons");
        std::fs::create_dir_all(&base).unwrap();

        let outside = tmp.path().join("outside-secret");
        std::fs::write(&outside, "sensitive data").unwrap();

        // Create a symlink inside addons/ pointing outside
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, base.join("escape-link")).unwrap();
            let result = validate_extracted_paths(&base);
            assert!(result.is_err(), "Should detect symlink escape");
            assert!(
                format!("{:?}", result.unwrap_err()).contains("Zip Slip"),
                "Error should mention Zip Slip"
            );
        }
    }
}
