//! Local external-terminal attachment server and its frozen wire protocol.

pub mod protocol;
mod registry_file;
mod server;
mod transport;

pub(crate) use server::AttachServer;
