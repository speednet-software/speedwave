//! PII tokenization engine core: deterministic AES-SIV seal/open plus
//! base64url payload encoding, shared by the hub, proxy, and CLI.

pub mod patterns;
pub mod policy;
pub mod scan;
pub mod siv;
mod validators;

pub use patterns::validator_by_name;
pub use policy::{
    compile_policy_v3, default_policy_json, CategoryFlags, CompiledKeyword, CompiledPolicy,
    CompiledRule, PolicyError,
};
pub use scan::{
    alias_text, detokenize_json, detokenize_text, detokenize_text_lossy, scan_json, scan_text,
    unalias_text, Detection, DetectionAction, DetokenizeError, ScanError, ScanOutcome,
    TOKEN_SPAN_RE,
};
pub use siv::{EngineKey, SivError};
