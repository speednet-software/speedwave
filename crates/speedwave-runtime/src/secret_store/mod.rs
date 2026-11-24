//! Encrypted per-secret file store: one AES-SIV sealed file per secret under `<data_dir>/secrets`.

mod error;
mod fields;
mod format;
mod key_source;
mod layout;
mod name;
mod store;

pub use error::{unreadable_secret_message, SecretStoreError};
pub use fields::{builtin_secret_fields, is_builtin_secret_field};
pub use key_source::{FileKeySource, KeySource};
pub use name::SecretName;
pub use store::{secret_exists_in, ProjectSecrets, SecretStore};
