//! PII tokenization engine core: deterministic AES-SIV seal/open plus
//! base64url payload encoding, shared by the hub, proxy, and CLI.

pub mod patterns;
pub mod policy;
pub mod scan;
pub mod siv;
mod validators;

pub use patterns::{
    builtin_rules, default_sensitive_keys, is_sensitive_key, BuiltinRule, PatternError,
    BUILTIN_CATEGORIES, SENSITIVE_FIELD,
};
pub use policy::{
    compile_policy_v2, default_policy_json, CategoryFlags, CompiledPolicy, CompiledRule,
    PolicyError,
};
pub use scan::{
    detokenize_json, detokenize_text, scan_json, scan_text, Detection, DetectionAction,
    DetokenizeError, ScanError, ScanOutcome, TOKEN_SPAN_RE,
};
pub use siv::{EngineKey, SivError};
