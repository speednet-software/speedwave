//! Encrypted per-secret file store: one AES-SIV sealed file per secret under `<data_dir>/secrets`.

mod error;
mod format;
mod key_source;
mod layout;
mod name;
mod store;

pub use error::{unreadable_secret_message, SecretStoreError};
pub use key_source::{FileKeySource, KeySource};
pub use name::SecretName;
pub use store::{ProjectSecrets, SecretStore};
