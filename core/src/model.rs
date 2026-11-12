//! 领域模型：草稿快照与正式快照同构，但存放位置与可见性严格分离。

use crate::json::Json;
use crate::sha256;
use crate::time;
use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreError {
    /// Existing tag to use or merge into when a name conflicts.
    pub tag_id: Option<String>,
    pub code: &'static str,
    pub stage: Option<&'static str>,
    pub message: String,
}

impl CoreError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            tag_id: None,
            stage: None,
            message: message.into(),
        }
    }
    pub fn with_stage(code: &'static str, stage: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            tag_id: None,
            stage: Some(stage),
            message: message.into(),
        }
    }
    pub fn io(message: impl Into<String>) -> Self {
        Self::new("IO_ERROR", message)
    }
    pub fn to_json(&self) -> Json {
        let mut entries = vec![
            ("ok", Json::Bool(false)),
            ("code", Json::str(self.code)),
            ("message", Json::str(self.message.clone())),
        ];
        if let Some(stage) = self.stage {
            entries.push(("stage", Json::str(stage)));
        }
        if let Some(tag_id) = &self.tag_id {
            entries.push(("tagId", Json::str(tag_id)));
        }
        Json::obj(entries)
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for CoreError {}

impl From<std::io::Error> for CoreError {
    fn from(err: std::io::Error) -> Self {
        CoreError::io(err.to_string())
    }
}

/// 一张照片在一条记录中的“使用关系”。
/// asset 是原图实体；photoUse 是可被编辑的引用，各自独立 caption。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PhotoUse {
    pub photo_use_id: String,
    pub asset_id: String,
    pub caption: String,
    pub sha256: String,
    pub bytes: u64,
    pub media_type: String,
}

impl PhotoUse {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("photoUseId", Json::str(self.photo_use_id.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("caption", Json::str(self.caption.clone())),
            ("sha256", Json::str(self.sha256.clone())),
            ("bytes", Json::Num(self.bytes as i64)),
            ("mediaType", Json::str(self.media_type.clone())),
        ])
    }

    pub fn from_json(value: &Json) -> Result<Self, String> {
        let sha256 = req_str(value, "sha256")?;
        if sha256.len() != 64
            || !sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(format!("字段 sha256 必须是 64 位小写十六进制：{sha256}"));
        }
        Ok(PhotoUse {
            photo_use_id: req_str(value, "photoUseId")?,
            asset_id: req_str(value, "assetId")?,
            caption: req_str(value, "caption")?,
            sha256,
            bytes: req_u64(value, "bytes")?,
            media_type: req_str(value, "mediaType")?,
        })
    }
}

/// 一次可提交的内容快照（标题/正文/事件日期/可选时刻/照片引用）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mood {
    Happy,
    Calm,
    Moved,
    Missing,
    Tired,
    Sad,
}
impl Mood {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Happy => "开心",
            Self::Calm => "平静",
            Self::Moved => "感动",
            Self::Missing => "想念",
            Self::Tired => "疲惫",
            Self::Sad => "难过",
        }
    }
    pub fn parse(value: &str) -> Result<Self, CoreError> {
        match value {
            "开心" => Ok(Self::Happy),
            "平静" => Ok(Self::Calm),
            "感动" => Ok(Self::Moved),
            "想念" => Ok(Self::Missing),
            "疲惫" => Ok(Self::Tired),
            "难过" => Ok(Self::Sad),
            _ => Err(CoreError::new("MOOD_INVALID", "请选择列表中的心情，或留空")),
        }
    }
}

/// Scalar content changes. None = unchanged; Some(None) clears an optional field.
#[derive(Clone, Debug, Default)]
pub struct DraftPatch {
    pub title: Option<String>,
    pub body: Option<String>,
    pub event_date: Option<String>,
    pub event_time: Option<Option<String>>,
    pub location: Option<String>,
    pub mood: Option<Option<Mood>>,
}

pub const MAX_LOCATION_CHARS: usize = 200;
pub fn validate_location(value: &str) -> Result<(), CoreError> {
    if value.chars().count() > MAX_LOCATION_CHARS {
        return Err(CoreError::new("LOCATION_TOO_LONG", "地点最多 200 个字符"));
    }
    Ok(())
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub title: String,
    pub body: String,
    pub event_date: String,
    pub event_time: Option<String>,
    pub location: String,
    pub mood: Option<Mood>,
    pub cover_photo_use_id: Option<String>,
    /// The array is the sole authoritative photo order; no second ordering list.
    pub photos: Vec<PhotoUse>,
}

impl Snapshot {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("title", Json::str(self.title.clone())),
            ("body", Json::str(self.body.clone())),
            ("location", Json::str(&self.location)),
            (
                "mood",
                self.mood
                    .map(|m| Json::str(m.as_str()))
                    .unwrap_or(Json::Null),
            ),
            (
                "coverPhotoUseId",
                self.cover_photo_use_id
                    .as_ref()
                    .map(Json::str)
                    .unwrap_or(Json::Null),
            ),
            ("eventDate", Json::str(self.event_date.clone())),
            (
                "eventTime",
                match &self.event_time {
                    Some(t) => Json::str(t.clone()),
                    None => Json::Null,
                },
            ),
            (
                "photos",
                Json::Arr(self.photos.iter().map(PhotoUse::to_json).collect()),
            ),
        ])
    }

    pub fn from_json(value: &Json) -> Result<Self, String> {
        let photos = match value.get("photos") {
            Some(Json::Arr(items)) => items
                .iter()
                .map(PhotoUse::from_json)
                .collect::<Result<Vec<_>, _>>()?,
            Some(_) => return Err("字段 photos 必须是数组".to_string()),
            None => return Err("字段 photos 缺失".to_string()),
        };
        let snapshot = Snapshot {
            title: req_str(value, "title")?,
            body: req_str(value, "body")?,
            event_date: req_str(value, "eventDate")?,
            event_time: req_opt_str(value, "eventTime")?.filter(|s| !s.is_empty()),
            location: req_str(value, "location")?,
            mood: req_opt_str(value, "mood")?
                .map(|s| Mood::parse(&s).map_err(|e| e.message))
                .transpose()?,
            cover_photo_use_id: req_opt_str(value, "coverPhotoUseId")?,
            photos,
        };
        snapshot.validate_details().map_err(|e| e.message)?;
        Ok(snapshot)
    }

    pub fn cover(&self) -> Option<&PhotoUse> {
        self.cover_photo_use_id
            .as_ref()
            .and_then(|id| self.photos.iter().find(|p| &p.photo_use_id == id))
    }
    pub fn validate_details(&self) -> Result<(), CoreError> {
        validate_location(&self.location)?;
        if (self.photos.is_empty() && self.cover_photo_use_id.is_some())
            || (!self.photos.is_empty() && self.cover().is_none())
        {
            return Err(CoreError::new(
                "COVER_PHOTO_INVALID",
                "封面必须是当前记录中的照片",
            ));
        }
        let mut ids = std::collections::BTreeSet::new();
        if self.photos.iter().any(|p| !ids.insert(&p.photo_use_id)) {
            return Err(CoreError::new(
                "PHOTO_ORDER_INVALID",
                "照片顺序不能有重复或缺失",
            ));
        }
        Ok(())
    }

    /// 规范化哈希：用于验收中“重启前后内容一致”的比对。
    pub fn content_hash(&self) -> String {
        sha256::hex_digest(self.to_json().dump().as_bytes())
    }

    /// 提交规则：eventDate 必填且合法；正文非空 或 至少 1 张照片；仅标题拒绝。
    pub fn validate_for_commit(&self) -> Result<(), CoreError> {
        self.validate_details()?;
        let date = self.event_date.trim();
        if date.is_empty() {
            return Err(CoreError::new(
                "MISSING_EVENT_DATE",
                "缺少事件日期：eventDate 为必填项（YYYY-MM-DD）",
            ));
        }
        if !time::is_valid_date(date) {
            return Err(CoreError::new(
                "INVALID_EVENT_DATE",
                format!("事件日期无效：{}（需为真实的 YYYY-MM-DD）", self.event_date),
            ));
        }
        if let Some(raw) = &self.event_time {
            if !raw.trim().is_empty() && !time::is_valid_time(raw) {
                return Err(CoreError::new(
                    "INVALID_EVENT_TIME",
                    format!("事件时刻无效：{}（需为 HH:MM，可留空）", raw),
                ));
            }
        }
        if self.body.trim().is_empty() && self.photos.is_empty() {
            return Err(CoreError::new(
                "EMPTY_CONTENT",
                "缺少正文或照片，无法存入时光（仅标题不能提交）",
            ));
        }
        Ok(())
    }
}

pub(crate) fn req_str(value: &Json, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Json::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| format!("字段 {key} 缺失或不是字符串"))
}

pub(crate) fn req_u32(value: &Json, key: &str) -> Result<u32, String> {
    let n = value
        .get(key)
        .and_then(Json::as_i64)
        .ok_or_else(|| format!("字段 {key} 缺失或不是整数"))?;
    if n < 0 {
        return Err(format!("字段 {key} 不能为负数：{n}"));
    }
    u32::try_from(n).map_err(|_| format!("字段 {key} 超出 u32 范围：{n}"))
}

pub(crate) fn req_u64(value: &Json, key: &str) -> Result<u64, String> {
    let n = value
        .get(key)
        .and_then(Json::as_i64)
        .ok_or_else(|| format!("字段 {key} 缺失或不是整数"))?;
    if n < 0 {
        return Err(format!("字段 {key} 不能为负数：{n}"));
    }
    Ok(n as u64)
}

fn req_opt_str(value: &Json, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        None => Err(format!("字段 {key} 缺失")),
        Some(Json::Null) => Ok(None),
        Some(Json::Str(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("字段 {key} 必须是字符串或 null")),
    }
}

/// 记录的持久化形态：正式快照与草稿分字段保存。
#[derive(Clone, Debug, Default)]
pub struct RecordRow {
    /// Recommendation preference only; independent of content and draft revisions.
    pub museum_hidden: bool,
    pub favorite: bool,
    pub favorite_revision: u32,
    pub tag_ids: Vec<String>,
    pub tag_revision: u32,
    pub status: RecordStatus,
    pub trashed_at: Option<String>,
    pub record_id: String,
    pub content_revision: u32,
    pub created_at: String,
    pub updated_at: String,
    pub committed_at: Option<String>,
    /// 草稿基于的正式版本；新记录为 0。
    pub base_revision: u32,
    pub formal: Option<Snapshot>,
    pub draft: Option<Snapshot>,
}

impl RecordRow {
    pub fn is_formal(&self) -> bool {
        self.formal.is_some()
    }

    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("museumHidden", Json::Bool(self.museum_hidden)),
            ("favorite", Json::Bool(self.favorite)),
            ("favoriteRevision", Json::Num(self.favorite_revision as i64)),
            (
                "tagIds",
                Json::Arr(self.tag_ids.iter().map(Json::str).collect()),
            ),
            ("tagRevision", Json::Num(self.tag_revision as i64)),
            ("status", Json::str(self.status.as_str())),
            (
                "trashedAt",
                self.trashed_at
                    .as_ref()
                    .map(Json::str)
                    .unwrap_or(Json::Null),
            ),
            ("recordId", Json::str(self.record_id.clone())),
            ("contentRevision", Json::Num(self.content_revision as i64)),
            ("createdAt", Json::str(self.created_at.clone())),
            ("updatedAt", Json::str(self.updated_at.clone())),
            (
                "committedAt",
                match &self.committed_at {
                    Some(v) => Json::str(v.clone()),
                    None => Json::Null,
                },
            ),
            ("baseRevision", Json::Num(self.base_revision as i64)),
            (
                "formal",
                match &self.formal {
                    Some(s) => s.to_json(),
                    None => Json::Null,
                },
            ),
            (
                "draft",
                match &self.draft {
                    Some(s) => s.to_json(),
                    None => Json::Null,
                },
            ),
        ])
    }

    pub fn from_json(value: &Json) -> Result<Self, String> {
        let formal = match value.get("formal") {
            None => return Err("字段 formal 缺失".to_string()),
            Some(Json::Null) => None,
            Some(v @ Json::Obj(_)) => Some(Snapshot::from_json(v)?),
            Some(_) => return Err("字段 formal 必须是对象或 null".to_string()),
        };
        let draft = match value.get("draft") {
            None => return Err("字段 draft 缺失".to_string()),
            Some(Json::Null) => None,
            Some(v @ Json::Obj(_)) => Some(Snapshot::from_json(v)?),
            Some(_) => return Err("字段 draft 必须是对象或 null".to_string()),
        };
        Ok(RecordRow {
            museum_hidden: match value.get("museumHidden") {
                Some(Json::Bool(v)) => *v,
                _ => return Err("字段 museumHidden 必须是布尔值".into()),
            },
            favorite: match value.get("favorite") {
                Some(Json::Bool(v)) => *v,
                _ => return Err("字段 favorite 必须是布尔值".into()),
            },
            favorite_revision: req_u32(value, "favoriteRevision")?,
            tag_revision: req_u32(value, "tagRevision")?,
            tag_ids: value
                .get("tagIds")
                .and_then(Json::as_arr)
                .ok_or("字段 tagIds 必须是数组")?
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| "tagId 必须是字符串".to_string())
                })
                .collect::<Result<_, _>>()?,
            status: match value.get("status").and_then(Json::as_str) {
                Some("active") => RecordStatus::Active,
                Some("trashed") => RecordStatus::Trashed,
                _ => return Err("字段 status 必须是 active 或 trashed".to_string()),
            },
            trashed_at: req_opt_str(value, "trashedAt")?,
            record_id: req_str(value, "recordId")?,
            content_revision: req_u32(value, "contentRevision")?,
            created_at: req_str(value, "createdAt")?,
            updated_at: req_str(value, "updatedAt")?,
            committed_at: req_opt_str(value, "committedAt")?,
            base_revision: req_u32(value, "baseRevision")?,
            formal,
            draft,
        })
    }
}

/// 回收站、删除标记、冲突副本及媒体核对结果。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RecordStatus {
    #[default]
    Active,
    Trashed,
}
impl RecordStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Trashed => "trashed",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeletionMarker {
    pub created_at: Option<String>,
    pub record_id: String,
    pub deleted_at: String,
    pub last_content_revision: u32,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConflictCopy {
    pub conflict_id: String,
    pub record_id: String,
    pub base_revision: u32,
    pub snapshot: Snapshot,
    pub created_at: String,
    pub reason: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConflictChoice {
    KeepMine,
    KeepFormal,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuarantinedMedia {
    pub asset_id: Option<String>,
    pub file: String,
    pub moved_to: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaIssue {
    pub record_id: String,
    pub photo_use_id: String,
    pub asset_id: String,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MediaReport {
    pub quarantined: Vec<QuarantinedMedia>,
    pub missing: Vec<MediaIssue>,
    pub corrupt: Vec<MediaIssue>,
    pub checked_at: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhotoStatus {
    Available,
    Missing,
    Corrupt,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PurgeOutcome {
    pub deletion_markers: Vec<DeletionMarker>,
    pub quarantined: Vec<QuarantinedMedia>,
}

impl DeletionMarker {
    pub fn matches(&self, record_id: &str, created_at: Option<&str>) -> bool {
        self.record_id == record_id
            && (self.created_at.is_none()
                || created_at.is_none()
                || self.created_at.as_deref() == created_at)
    }
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("recordId", Json::str(&self.record_id)),
            ("deletedAt", Json::str(&self.deleted_at)),
            (
                "createdAt",
                self.created_at
                    .as_ref()
                    .map(Json::str)
                    .unwrap_or(Json::Null),
            ),
            (
                "lastContentRevision",
                Json::Num(self.last_content_revision as i64),
            ),
        ])
    }
    pub fn from_json(value: &Json) -> Result<Self, String> {
        Ok(Self {
            record_id: req_str(value, "recordId")?,
            deleted_at: req_str(value, "deletedAt")?,
            created_at: match value.get("createdAt") {
                None | Some(Json::Null) => None,
                Some(Json::Str(s)) => Some(s.clone()),
                _ => return Err("字段 createdAt 必须是字符串或 null".into()),
            },
            last_content_revision: req_u32(value, "lastContentRevision")?,
        })
    }
}
impl ConflictCopy {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("conflictId", Json::str(&self.conflict_id)),
            ("recordId", Json::str(&self.record_id)),
            ("baseRevision", Json::Num(self.base_revision as i64)),
            ("snapshot", self.snapshot.to_json()),
            ("createdAt", Json::str(&self.created_at)),
            ("reason", Json::str(&self.reason)),
        ])
    }
    pub fn from_json(value: &Json) -> Result<Self, String> {
        Ok(Self {
            conflict_id: req_str(value, "conflictId")?,
            record_id: req_str(value, "recordId")?,
            base_revision: req_u32(value, "baseRevision")?,
            snapshot: Snapshot::from_json(value.get("snapshot").ok_or("字段 snapshot 缺失")?)?,
            created_at: req_str(value, "createdAt")?,
            reason: req_str(value, "reason")?,
        })
    }
}

impl QuarantinedMedia {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            (
                "assetId",
                self.asset_id.as_ref().map(Json::str).unwrap_or(Json::Null),
            ),
            ("file", Json::str(&self.file)),
            ("movedTo", Json::str(&self.moved_to)),
        ])
    }
}
impl MediaIssue {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("recordId", Json::str(&self.record_id)),
            ("photoUseId", Json::str(&self.photo_use_id)),
            ("assetId", Json::str(&self.asset_id)),
        ])
    }
}
impl MediaReport {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            (
                "quarantined",
                Json::Arr(
                    self.quarantined
                        .iter()
                        .map(QuarantinedMedia::to_json)
                        .collect(),
                ),
            ),
            (
                "missing",
                Json::Arr(self.missing.iter().map(MediaIssue::to_json).collect()),
            ),
            (
                "corrupt",
                Json::Arr(self.corrupt.iter().map(MediaIssue::to_json).collect()),
            ),
            ("checkedAt", Json::str(&self.checked_at)),
        ])
    }
}
impl PurgeOutcome {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            (
                "deletionMarkers",
                Json::Arr(
                    self.deletion_markers
                        .iter()
                        .map(DeletionMarker::to_json)
                        .collect(),
                ),
            ),
            (
                "quarantined",
                Json::Arr(
                    self.quarantined
                        .iter()
                        .map(QuarantinedMedia::to_json)
                        .collect(),
                ),
            ),
        ])
    }
}
