//! Sync protocol core for the Notebook desktop shell.
//!
//! Kept free of Tauri so the protocol can be built and tested on any host
//! (including CI runners without WebKit) against the shared fixtures in
//! `SyncContractFixtures/webdav-v4`.

pub mod webdav;
