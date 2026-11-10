//! 有序迁移链；容器 version 与数据结构 schemaVersion 分开演进。
use crate::{json::Json, CoreError};
pub const CURRENT_SCHEMA_VERSION: i64 = 3;
pub type Migration = fn(Json) -> Result<Json, CoreError>;
pub const MIGRATIONS: &[(i64, Migration)] = &[(1, migrate_v1_to_v2), (2, migrate_v2_to_v3)];

pub(crate) fn set(value: &mut Json, key: &str, item: Json) -> Result<(), CoreError> {
    let Json::Obj(fields) = value else {
        return Err(CoreError::new("STATE_CORRUPT", "状态必须是对象"));
    };
    fields.retain(|(k, _)| k != key);
    fields.push((key.to_string(), item));
    Ok(())
}

pub fn migrate_v1_to_v2(mut value: Json) -> Result<Json, CoreError> {
    let Some(Json::Arr(rows)) = value.get("records") else {
        return Err(CoreError::new(
            "STATE_CORRUPT",
            "状态文件 records 必须是数组",
        ));
    };
    let mut rows = rows.clone();
    for row in &mut rows {
        set(row, "status", Json::str("active"))?;
        set(row, "trashedAt", Json::Null)?;
    }
    set(&mut value, "records", Json::Arr(rows))?;
    set(&mut value, "deletionMarkers", Json::Arr(Vec::new()))?;
    set(&mut value, "conflictCopies", Json::Arr(Vec::new()))?;
    set(&mut value, "schemaVersion", Json::Num(2))?;
    Ok(value)
}

pub(crate) fn version(value: &Json) -> Result<i64, CoreError> {
    // 保留容器格式错误的既有错误码和优先级。
    match value.get("version").and_then(Json::as_i64) {
        Some(1) => {}
        Some(n) => {
            return Err(CoreError::new(
                "STATE_VERSION_UNSUPPORTED",
                format!("不支持的状态版本：{n}"),
            ))
        }
        None => {
            return Err(CoreError::new(
                "STATE_CORRUPT",
                "状态文件缺少 version 或不是整数",
            ))
        }
    }
    let n = match value.get("schemaVersion") {
        None => 1,
        Some(Json::Num(n)) if *n >= 1 => *n,
        _ => {
            return Err(CoreError::new(
                "STATE_CORRUPT",
                "schemaVersion 必须为正整数",
            ))
        }
    };
    if n > CURRENT_SCHEMA_VERSION {
        return Err(CoreError::new(
            "SCHEMA_TOO_NEW",
            "这份数据由更新版本的拾光写入，当前版本无法安全读取。请升级拾光；原数据未改动。",
        ));
    }
    Ok(n)
}

pub(crate) fn migrate(mut value: Json) -> Result<Json, CoreError> {
    let mut current = version(&value)?;
    while current < CURRENT_SCHEMA_VERSION {
        let (_, migration) = MIGRATIONS
            .iter()
            .find(|(from, _)| *from == current)
            .ok_or_else(|| CoreError::new("MIGRATION_FAILED", "迁移链不完整"))?;
        value = migration(value)?;
        current += 1;
    }
    Ok(value)
}

/// Add independent metadata without touching content snapshots.
pub fn migrate_v2_to_v3(mut value: Json) -> Result<Json, CoreError> {
    let rows = value
        .get("records")
        .and_then(Json::as_arr)
        .ok_or_else(|| CoreError::new("STATE_CORRUPT", "状态文件 records 必须是数组"))?;
    let mut rows = rows.to_vec();
    for row in &mut rows {
        set(row, "favorite", Json::Bool(false))?;
        set(row, "favoriteRevision", Json::Num(0))?;
        set(row, "tagIds", Json::Arr(vec![]))?;
        set(row, "tagRevision", Json::Num(0))?;
    }
    set(&mut value, "records", Json::Arr(rows))?;
    for key in ["tags", "tagAliases", "tagTombstones"] {
        set(&mut value, key, Json::Arr(vec![]))?;
    }
    set(&mut value, "tagDictRevision", Json::Num(0))?;
    set(&mut value, "schemaVersion", Json::Num(3))?;
    Ok(value)
}
