//! 拾光 Unit-0 领域核心。
//!
//! 设计要点（对应 UNIT0_ACCEPTANCE）：
//! - 草稿与正式快照分离存放；正式列表只读取正式快照。
//! - 每次变更同步落盘（临时文件 + fsync + rename），重启后读回。
//! - 原图 asset 不可变、无删除接口；预览是派生缓存，可删除并重建。
//! - photoUse 与 asset 分离：同一原图可被多次引用，各自拥有 caption。

pub mod base64;
#[cfg(feature = "fault-injection")]
pub mod fault;
#[cfg(not(feature = "fault-injection"))]
mod fault;
pub mod json;
pub mod model;
pub mod persist;
pub mod preview;
pub mod sha256;
pub mod store;
pub mod time;

pub use model::{CoreError, PhotoUse, Snapshot};
pub use store::{CommitOutcome, Store, StoreConfig};

pub mod error_codes;
pub mod schema;
pub use schema::CURRENT_SCHEMA_VERSION;
pub use model::{RecordRow, RecordStatus, DeletionMarker, ConflictCopy, ConflictChoice, QuarantinedMedia, MediaIssue, MediaReport, PhotoStatus, PurgeOutcome};
