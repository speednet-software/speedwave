// URL validation Tauri commands. The SSRF validator is the SSOT in
// `speedwave_runtime::url_validation`; re-exported here so existing callsites
// keep compiling. Only the Tauri-bound commands live here (runtime is Tauri-free).

pub(crate) use speedwave_runtime::url_validation::{
    is_private_on_premise, validate_url, PrivatePolicy,
};

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if url.len() > 8192 {
        return Err("URL too long".to_string());
    }
    let parsed = validate_url(&url)?;
    open::that(parsed.as_str()).map_err(|e| e.to_string())
}

/// Returns the current platform as a string ("macos" or "windows").
#[tauri::command]
pub fn get_platform() -> String {
    if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else {
        "unknown".to_string()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn open_url_rejects_overlong() {
        let long = format!("https://example.com/{}", "a".repeat(9000));
        assert!(open_url(long).unwrap_err().contains("too long"));
    }

    #[test]
    fn open_url_rejects_private_ip() {
        // Delegates to the runtime SSOT validator.
        assert!(open_url("https://127.0.0.1/".to_string()).is_err());
    }

    #[test]
    fn get_platform_returns_known_value() {
        let platform = get_platform();
        assert!(["macos", "windows"].contains(&platform.as_str()));
    }

    #[test]
    fn reexports_resolve() {
        // Compile-time check that the re-exported symbols are reachable here.
        assert!(validate_url("https://example.com").is_ok());
        let url: url::Url = "http://10.0.0.1/".parse().unwrap();
        assert!(is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
    }
}
