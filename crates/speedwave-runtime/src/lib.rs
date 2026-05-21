#![allow(missing_docs)]

pub mod binary;
pub mod build;
pub mod bundle;
pub mod claude_home;
pub mod cloudstorage;
pub mod compose;
pub mod config;
pub mod consts;
pub mod defaults;
pub mod fs_perms;
pub mod fs_security;
pub mod host_exec;
pub mod host_exec_process;
pub mod host_mcp_process;
pub mod http_debug_collator;
pub mod log_file;
pub mod log_sanitizer;
pub mod log_ts;
pub mod mcp_os_process;
pub mod migration_oauth;
pub mod oauth_process;
pub mod os_prereqs;
pub mod plugin;
pub mod project;
pub mod resources;
pub mod runtime;
pub mod session;
pub mod signing;
pub mod slash;
pub mod stream;
/// Host-side meeting transcription (audio capture, Whisper, diarization, model
/// catalogue) — gated behind the `audio-transcription` feature so the CLI
/// (which never enables it) stays lean. See `docs/adr/ADR-056-*`.
#[cfg(feature = "audio-transcription")]
pub mod transcription;
pub mod tz;
pub mod update;
pub mod validation;
