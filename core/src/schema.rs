//! Unit-0.4 migration API; phase 1 contains signatures only.
use crate::{json::Json, CoreError};
pub const CURRENT_SCHEMA_VERSION: i64 = 2;
pub type Migration = fn(Json) -> Result<Json, CoreError>;
pub const MIGRATIONS: &[(i64, Migration)] = &[(1, migrate_v1_to_v2)];
pub fn migrate_v1_to_v2(_value: Json) -> Result<Json, CoreError> {
    Err(CoreError::new("NOT_IMPLEMENTED", "migrate_v1_to_v2"))
}
