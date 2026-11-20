//! Secrets tmpfs inside the VM: pure layout and frame types, and the adapter that writes them
//! through stdin of a root VM command.

pub(crate) mod frame;
pub(crate) mod layout;
pub(crate) mod stage;

pub(crate) use layout::Slot;
