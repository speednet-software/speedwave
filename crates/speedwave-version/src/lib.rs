//! Computes Speedwave's app version from git state.
//! Dev builds: `0.<M+1>.0+N`. Release-line builds (`release/0.M`): `0.M.Z`.

mod build_script;
mod error;
mod git;
mod notes;
mod release_line;
#[cfg(test)]
mod test_support;
mod version;

pub use build_script::emit_cargo_version;
pub use error::VersionError;
pub use notes::{notes_range, reject_if_ancestor_of_previous_line, NotesRange};
pub use release_line::stable_tag_for_line;
pub use version::{compute_version, resolve_version};
