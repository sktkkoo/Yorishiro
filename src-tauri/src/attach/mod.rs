//! Local external-terminal attachment server and its frozen wire protocol.

pub mod protocol;
#[cfg(target_os = "macos")]
mod registry_file;
mod server;
#[cfg(target_os = "macos")]
mod transport;

pub(crate) use server::AttachServer;
