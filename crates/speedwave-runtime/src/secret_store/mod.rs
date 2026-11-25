//! Encrypted per-secret file store: one AES-SIV sealed file per secret under `<data_dir>/secrets`.

mod error;
mod fields;
mod format;
mod key_source;
mod layout;
mod name;
mod recovery;
mod state;
mod store;

pub use error::SecretStoreError;
pub use fields::{builtin_secret_fields, is_builtin_secret_field};
pub use key_source::{FileKeySource, KeySource};
pub use name::SecretName;
pub use recovery::{
    discard_secrets_without_key, encrypted_integrations, undiscardable_count, EncryptedIntegration,
};
pub use state::{secret_store_state, SecretStoreState};
pub use store::{secret_exists_in, unreadable_integration_messages, ProjectSecrets, SecretStore};
