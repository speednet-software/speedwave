//! PII tokenization engine core: deterministic AES-SIV seal/open plus
//! base64url payload encoding, shared by the hub, proxy, and CLI.

pub mod patterns;
pub mod policy;
pub mod scan;
pub mod siv;
mod validators;

pub use patterns::validator_by_name;
pub use policy::{
    compile_policy_v3, default_policy_json, is_valid_rule_id, CategoryFlags, CompiledKeyword,
    CompiledPolicy, CompiledRule, PolicyError,
};
pub use scan::{
    alias_json, alias_text, collect_string_leaves, collect_string_leaves_with_keys,
    detokenize_json, detokenize_text, detokenize_text_lossy, detokenize_text_with,
    incomplete_token_span_start, scan_json, scan_json_with_external, scan_text,
    scan_text_with_external, unalias_json_preserving_tokens, unalias_text,
    unalias_text_preserving_tokens, unalias_text_preserving_tokens_with, Detection,
    DetectionAction, DetokenizeError, ExternalScanOutcome, ExternalScanReport, ExternalSpan,
    ScanError, ScanOutcome, StringLeaf, TOKEN_SPAN_RE,
};
pub use siv::{EngineKey, SivError};
