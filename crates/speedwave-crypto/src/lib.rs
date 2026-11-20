//! Leaf cryptography crate: AES-SIV sealing and HKDF token derivation, no I/O.

mod error;
mod hex;
mod key;
mod siv;
mod token;

pub use error::CryptoError;
pub use key::Key;
pub use siv::{open_deterministic, open_with_nonce, seal_deterministic, seal_with_nonce};
pub use token::derive_token;
