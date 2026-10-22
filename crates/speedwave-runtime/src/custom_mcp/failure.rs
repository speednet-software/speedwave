//! The text a person sees when a Custom MCP action fails: one sentence they can act on plus a
//! short code. The technical cause goes to the log and never reaches the screen.

use std::fmt::Display;

/// The exact version is newer than the release-age minimum or does not exist.
pub const NPM_VERSION: &str = "CMCP-NPM-VERSION";
/// The package is not on the npm registry.
pub const NPM_NOT_FOUND: &str = "CMCP-NPM-NOT-FOUND";
/// The npm registry could not be reached.
pub const NPM_NETWORK: &str = "CMCP-NPM-NETWORK";
/// npm failed for a reason with no more specific code.
pub const NPM_FAILED: &str = "CMCP-NPM-FAILED";
/// The container engine failed or is not running.
pub const ENGINE: &str = "CMCP-ENGINE";
/// The settings file could not be read or written.
pub const CONFIG: &str = "CMCP-CONFIG";
/// The files for the server image could not be prepared.
pub const BUILD: &str = "CMCP-BUILD";
/// The tool list of a server could not be read.
pub const CATALOG: &str = "CMCP-CATALOG";
/// A leftover file or network of a removed server stayed behind.
pub const CLEANUP: &str = "CMCP-CLEANUP";
/// The npm registry answered something Speedwave cannot use.
pub const REGISTRY: &str = "CMCP-REGISTRY";
/// The action stopped unexpectedly.
pub const INTERNAL: &str = "CMCP-INTERNAL";

/// `summary (code). Details are in the Speedwave log.`; `cause` is written to the log.
pub fn failure(code: &str, summary: &str, cause: impl Display) -> String {
    log::warn!("custom MCP action failed ({code}), {summary}: {cause}");
    format!("{summary} ({code}). Details are in the Speedwave log.")
}

/// The settings file could not be read or written.
pub fn settings_failed(cause: impl Display) -> String {
    failure(
        CONFIG,
        "Your Speedwave settings could not be read or saved",
        cause,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_text_carries_the_summary_and_the_code_but_not_the_cause() {
        let text = failure(ENGINE, "The engine is not running", "exec failed: exit 255");
        assert_eq!(
            text,
            "The engine is not running (CMCP-ENGINE). Details are in the Speedwave log."
        );
        assert!(!text.contains("exit 255"));
    }

    #[test]
    fn codes_are_unique_and_prefixed() {
        let codes = [
            NPM_VERSION,
            NPM_NOT_FOUND,
            NPM_NETWORK,
            NPM_FAILED,
            ENGINE,
            CONFIG,
            BUILD,
            CATALOG,
            CLEANUP,
            REGISTRY,
            INTERNAL,
        ];
        let unique: std::collections::BTreeSet<_> = codes.iter().collect();
        assert_eq!(unique.len(), codes.len());
        assert!(codes.iter().all(|c| c.starts_with("CMCP-")));
    }
}
