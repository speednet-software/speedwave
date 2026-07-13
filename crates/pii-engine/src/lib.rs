//! PII tokenization engine core: deterministic AES-SIV seal/open plus
//! base64url payload encoding, shared by the hub, proxy, and CLI.

pub mod patterns;
pub mod siv;
mod validators;

pub use patterns::{
    builtin_rules, default_sensitive_keys, is_sensitive_key, BuiltinRule, PatternError,
    BUILTIN_CATEGORIES, SENSITIVE_FIELD,
};
pub use siv::EngineKey;
