//! Speedwave runtime — SSOT for all Lima/WSL2/nerdctl container orchestration, compose rendering,
//! resource budgeting, and host-side process management. The CLI and Desktop depend on this crate.

pub mod audit;
pub mod binary;
pub mod build;
pub mod bundle;
pub mod claude_home;
pub mod claude_managed;
pub mod cloudstorage;
pub mod compose;
pub mod config;
pub mod consts;
pub mod defaults;
pub mod diagnostic_sources;
pub mod engine_path;
pub mod fs_perms;
pub mod fs_security;
pub mod host_mcp_process;
pub mod http_debug_collator;
pub mod legacy_token_cleanup;
pub mod log_file;
pub mod log_sanitizer;
pub mod log_ts;
pub mod managed_config;
pub mod mcp_os_process;
pub mod model_id;
pub mod native_slash;
pub mod oauth_persist;
pub mod oauth_process;
pub mod oauth_state_migration;
pub mod os_prereqs;
pub mod pii_key;
pub mod pii_policy;
pub mod pkce;
pub mod plugin;
pub mod project;
pub mod prompts;
pub mod provision;
pub mod resources;
pub mod runtime;
pub mod session;
pub mod signing;
pub mod slash;
pub mod stream;
pub mod telemetry_env;
/// Host-side meeting transcription (audio capture, Whisper, model catalogue) — gated behind the
/// `audio-transcription` feature so the CLI (which never enables it) stays lean. See ADR-056.
#[cfg(feature = "audio-transcription")]
pub mod transcription;
pub mod tz;
pub mod update;
pub mod url_validation;
pub mod usage;
pub mod usage_cost;
pub mod validation;

/// Test-only re-exports of internal transaction helpers.
#[cfg(any(test, feature = "test-support"))]
pub mod update_test_support {
    pub use crate::update::{
        apply_rollback_transaction, apply_update_transaction, maybe_prune_previous_bundle,
    };
}
