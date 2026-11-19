use std::fmt;

/// Sealing, opening, key-decoding, or payload-decoding failure; never reveals which check failed.
#[derive(Debug, PartialEq, Eq)]
pub enum CryptoError {
    /// Authentication failed, the input is too short, or the cipher rejected the request.
    Crypto,
    /// Hex or base64url input is malformed.
    Encoding,
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Crypto => write!(f, "SIV authentication or format check failed"),
            Self::Encoding => write!(f, "payload encoding is invalid"),
        }
    }
}

impl std::error::Error for CryptoError {}
