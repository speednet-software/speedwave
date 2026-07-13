//! PII tokenization engine core: deterministic AES-SIV seal/open plus
//! base64url payload encoding, shared by the hub, proxy, and CLI.

pub mod siv;

pub use siv::EngineKey;
