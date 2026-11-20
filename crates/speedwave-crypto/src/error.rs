use std::fmt;

/// Cryptographic or encoding failure; never reveals which check failed.
#[derive(Debug, PartialEq, Eq)]
pub enum CryptoError {
    /// Authentication or format check failed.
    Crypto,
    /// Input encoding is invalid.
    Encoding,
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Crypto => write!(f, "authentication or format check failed"),
            Self::Encoding => write!(f, "input encoding is invalid"),
        }
    }
}

impl std::error::Error for CryptoError {}
