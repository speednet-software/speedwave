use std::path::PathBuf;

use speedwave_runtime::engine_path;
use speedwave_runtime::validation;

pub(super) fn run(custom_name: Option<&str>) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let canonical = std::fs::canonicalize(&cwd)?;
    let raw_canonical = canonical.to_string_lossy();
    let canonical_str = engine_path::strip_extended_length_prefix(&raw_canonical).to_string();
    let name = match custom_name {
        Some(n) => n.to_string(),
        None => PathBuf::from(&canonical_str)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .ok_or_else(|| anyhow::anyhow!("Cannot determine directory name"))?,
    };
    validation::validate_project_name(&name)?;

    match speedwave_runtime::project::add_project(&name, &canonical_str) {
        Ok(()) => {
            out!("Project '{}' registered at {}", name, canonical_str);
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("already registered") || msg.contains("already exists") {
                out!("{}", msg);
            } else {
                return Err(e);
            }
        }
    }
    Ok(())
}
