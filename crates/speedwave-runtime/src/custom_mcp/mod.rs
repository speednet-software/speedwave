//! Custom MCP servers outside the built-in and plugin catalog: config model, effective set,
//! guard/egress policies, state layout, npm lockfile pin, per-server image, gate expectations,
//! the repository `.mcp.json` scan, the hub tool catalog and the egress refusal log.

pub mod build;
pub mod catalog;
pub mod detect;
pub mod effective;
pub mod egress_log;
pub mod expect;
pub mod failure;
pub mod model;
pub mod notices;
pub mod npm_resolve;
pub mod paths;
pub mod policy;
pub mod relay;

pub use expect::{expectations_for, CustomMcpExpectations};
