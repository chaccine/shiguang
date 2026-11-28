//! 有序迁移链；容器 version 与数据结构 schemaVersion 分开演进。
use crate::{json::Json, CoreError};
pub const CURRENT_SCHEMA_VERSION: i64 = 6;
pub type Migration = fn(Json) -> Result<Json, CoreError>;
pub const MIGRATIONS: &[(i64, Migration)] = &[
    (1, migrate_v1_to_v2),
    (2, migrate_v2_to_v3),
    (3, migrate_v3_to_v4),
    (4, migrate_v4_to_v5),
    (5, migrate_v5_to_v6),
];

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
    let outer = match value.get("version").and_then(Json::as_i64) {
        Some(n @ (1 | 2)) => n,
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
    };
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
    if n > CURRENT_SCHEMA_VERSION || (outer == 1 && n > 5) {
        return Err(CoreError::new(
            "SCHEMA_TOO_NEW",
            "这份数据由更新版本的拾光写入，当前版本无法安全读取。请升级拾光；原数据未改动。",
        ));
    }
    if outer == 2 && n != CURRENT_SCHEMA_VERSION {
        return Err(CoreError::new("STATE_VERSION_UNSUPPORTED", "状态容器与数据结构版本不匹配"));
    }
    Ok(n)
}

pub(crate) fn migrate(value: Json) -> Result<Json, CoreError> {
    migrate_to(value, CURRENT_SCHEMA_VERSION)
}
pub(crate) fn migrate_to(mut value: Json, target: i64) -> Result<Json, CoreError> {
    let mut current = version(&value)?;
    while current < target {
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

/// Add content fields to EVERY snapshot, including trash, edit drafts and conflicts.
/// Captions and photo array order already exist in v3 and are preserved verbatim.
pub fn migrate_v3_to_v4(mut value: Json) -> Result<Json, CoreError> {
    fn snapshot(v: &mut Json) -> Result<(), CoreError> {
        let photos = v
            .get("photos")
            .and_then(Json::as_arr)
            .ok_or_else(|| CoreError::new("STATE_CORRUPT", "快照 photos 必须是数组"))?;
        let cover = photos
            .first()
            .map(|p| {
                p.get("photoUseId")
                    .cloned()
                    .ok_or_else(|| CoreError::new("STATE_CORRUPT", "照片缺少 photoUseId"))
            })
            .transpose()?
            .unwrap_or(Json::Null);
        set(v, "coverPhotoUseId", cover)?;
        set(v, "location", Json::str(""))?;
        set(v, "mood", Json::Null)
    }
    let mut rows = value
        .get("records")
        .and_then(Json::as_arr)
        .ok_or_else(|| CoreError::new("STATE_CORRUPT", "records 必须是数组"))?
        .to_vec();
    for row in &mut rows {
        for key in ["formal", "draft"] {
            let mut v = row
                .get(key)
                .cloned()
                .ok_or_else(|| CoreError::new("STATE_CORRUPT", "记录缺少快照槽"))?;
            if v != Json::Null {
                snapshot(&mut v)?;
            }
            set(row, key, v)?;
        }
    }
    set(&mut value, "records", Json::Arr(rows))?;
    let mut conflicts = value
        .get("conflictCopies")
        .and_then(Json::as_arr)
        .ok_or_else(|| CoreError::new("STATE_CORRUPT", "conflictCopies 必须是数组"))?
        .to_vec();
    for copy in &mut conflicts {
        let mut v = copy
            .get("snapshot")
            .cloned()
            .ok_or_else(|| CoreError::new("STATE_CORRUPT", "冲突副本缺少快照"))?;
        snapshot(&mut v)?;
        set(copy, "snapshot", v)?;
    }
    set(&mut value, "conflictCopies", Json::Arr(conflicts))?;
    set(
        &mut value,
        "settings",
        crate::settings::Settings::default().to_json(),
    )?;
    set(&mut value, "schemaVersion", Json::Num(4))?;
    Ok(value)
}

/// A row-level preference, never a content snapshot or a persisted exhibition.
pub fn migrate_v4_to_v5(mut value: Json) -> Result<Json, CoreError> {
    let mut rows = value.get("records").and_then(Json::as_arr)
        .ok_or_else(|| CoreError::new("STATE_CORRUPT", "records 必须是数组"))?.to_vec();
    for row in &mut rows {
        set(row, "museumHidden", Json::Bool(false))?;
    }
    set(&mut value, "records", Json::Arr(rows))?;
    set(&mut value, "schemaVersion", Json::Num(5))?;
    Ok(value)
}

use crate::{story::{Story, LegacyContent}, State};
pub(super) fn bad(message: impl Into<String>) -> CoreError {
    CoreError::new("CANDIDATE_INVALID", message)
}

pub(super) fn field_mut<'a>(v: &'a mut Json, key: &str) -> Result<&'a mut Json, CoreError> {
    if let Json::Obj(fields) = v {
        if let Some((_, child)) = fields.iter_mut().find(|(k, _)| k == key) {
            return Ok(child);
        }
    }
    Err(bad(format!("missing {key}")))
}

pub(super) fn snapshots(
    state: &mut Json,
    mut visit: impl FnMut(&mut Json) -> Result<(), CoreError>,
) -> Result<(), CoreError> {
    for (array, slots) in [
        ("records", &["formal", "draft"][..]),
        ("conflictCopies", &["snapshot"][..]),
    ] {
        let Json::Arr(rows) = field_mut(state, array)? else {
            return Err(bad(array));
        };
        for row in rows {
            for key in slots {
                let snapshot = field_mut(row, key)?;
                if *snapshot != Json::Null {
                    visit(snapshot)?;
                }
            }
        }
    }
    Ok(())
}

pub(super) fn remove_fields(v: &mut Json, keys: &[&str]) -> Result<(), CoreError> {
    let Json::Obj(fields) = v else {
        return Err(bad("expected object"));
    };
    fields.retain(|(k, _)| !keys.contains(&k.as_str()));
    Ok(())
}

fn legacy_story(v: &Json) -> Result<Story, CoreError> {
    if v.get("story").is_some() {
        return Err(bad("legacy snapshot has a story"));
    }
    let content = LegacyContent::from_json(v).map_err(bad)?;
    Story::from_legacy(&content).map_err(bad)
}

pub fn migrate_v5_to_v6(mut value: Json) -> Result<Json, CoreError> {
    // v5 had no replacement operation. Keep its original ownership check at the
    // legacy boundary now that v6 permits different originals across snapshots.
    let mut assets = std::collections::BTreeMap::new();
    snapshots(&mut value, |v| {
        let story = legacy_story(v)?;
        for p in story.photos() {
            if assets
                .insert(p.photo_use_id.clone(), p.asset_id.clone())
                .is_some_and(|id| id != p.asset_id)
            {
                return Err(CoreError::new(
                    "STATE_CORRUPT",
                    "旧版本照片使用位指向不同原图",
                ));
            }
        }
        remove_fields(v, &["body", "photos", "coverPhotoUseId"])?;
        set(v, "story", story.to_json())
    })?;
    *field_mut(&mut value, "version")? = Json::Num(2);
    *field_mut(&mut value, "schemaVersion")? = Json::Num(6);
    Ok(value)
}

// Compare every field at its original row/slot/array index. Object member
// ordering alone has no meaning in JSON.
fn sort_keys(v: &mut Json) {
    match v {
        Json::Obj(fields) => {
            fields.sort_by(|a, b| a.0.cmp(&b.0));
            for (_, item) in fields {
                sort_keys(item);
            }
        }
        Json::Arr(items) => items.iter_mut().for_each(sort_keys),
        _ => {}
    }
}

pub(super) fn validate(source: &Json, encoded: &Json) -> Result<(), CoreError> {
    if encoded.get("version") != Some(&Json::Num(2))
        || encoded.get("schemaVersion") != Some(&Json::Num(6))
    {
        return Err(bad("wrong candidate version pair"));
    }
    let mut rebuilt = encoded.clone();
    snapshots(&mut rebuilt, |v| {
        if ["body", "photos", "coverPhotoUseId"]
            .iter()
            .any(|k| v.get(k).is_some())
        {
            return Err(bad("two representations of one snapshot"));
        }
        let story =
            Story::from_json(v.get("story").ok_or_else(|| bad("missing story"))?).map_err(bad)?;
        remove_fields(v, &["story"])?;
        set(v, "body", Json::str(story.plain_text()))?;
        set(
            v,
            "photos",
            Json::Arr(story.photos().map(|p| p.to_json()).collect()),
        )?;
        set(
            v,
            "coverPhotoUseId",
            story
                .cover_photo_use_id()
                .map(Json::str)
                .unwrap_or(Json::Null),
        )?;
        if legacy_story(v)? != story {
            return Err(bad("changed blocks or marks"));
        }
        Ok(())
    })?;
    *field_mut(&mut rebuilt, "version")? = Json::Num(1);
    *field_mut(&mut rebuilt, "schemaVersion")? = Json::Num(5);
    State::from_json(encoded)?;
    let mut expected = migrate_to(source.clone(), 5)?;
    sort_keys(&mut expected);
    sort_keys(&mut rebuilt);
    if rebuilt != expected {
        return Err(bad("legacy state differs after story round trip"));
    }
    Ok(())
}
