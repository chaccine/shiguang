//! 领域模型：草稿快照与正式快照同构，但存放位置与可见性严格分离。

use crate::json::Json;
use crate::sha256;
use crate::time;
use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreError {
    pub code: &'static str,
    pub message: String,
}

impl CoreError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn io(message: impl Into<String>) -> Self {
        Self::new("IO_ERROR", message)
    }
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("ok", Json::Bool(false)),
            ("code", Json::str(self.code)),
            ("message", Json::str(self.message.clone())),
        ])
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
        Ok(PhotoUse {
            photo_use_id: req_str(value, "photoUseId")?,
            asset_id: req_str(value, "assetId")?,
            caption: req_str(value, "caption").unwrap_or_default(),
            sha256: req_str(value, "sha256")?,
            bytes: value
                .get("bytes")
                .and_then(Json::as_i64)
                .unwrap_or(0)
                .max(0) as u64,
            media_type: req_str(value, "mediaType").unwrap_or_else(|_| "application/octet-stream".into()),
        })
    }
}

/// 一次可提交的内容快照（标题/正文/事件日期/可选时刻/照片引用）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub title: String,
    pub body: String,
    pub event_date: String,
    pub event_time: Option<String>,
    pub photos: Vec<PhotoUse>,
}

impl Snapshot {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("title", Json::str(self.title.clone())),
            ("body", Json::str(self.body.clone())),
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
            _ => Vec::new(),
        };
        Ok(Snapshot {
            title: req_str(value, "title").unwrap_or_default(),
            body: req_str(value, "body").unwrap_or_default(),
            event_date: req_str(value, "eventDate").unwrap_or_default(),
            event_time: match value.get("eventTime") {
                Some(Json::Str(s)) if !s.is_empty() => Some(s.clone()),
                _ => None,
            },
            photos,
        })
    }

    /// 规范化哈希：用于验收中“重启前后内容一致”的比对。
    pub fn content_hash(&self) -> String {
        sha256::hex_digest(self.to_json().dump().as_bytes())
    }

    /// 提交规则：eventDate 必填且合法；正文非空 或 至少 1 张照片；仅标题拒绝。
    pub fn validate_for_commit(&self) -> Result<(), CoreError> {
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

fn req_str(value: &Json, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Json::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| format!("字段 {key} 缺失或不是字符串"))
}

/// 记录的持久化形态：正式快照与草稿分字段保存。
#[derive(Clone, Debug, Default)]
pub struct RecordRow {
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
        Ok(RecordRow {
            record_id: req_str(value, "recordId")?,
            content_revision: value
                .get("contentRevision")
                .and_then(Json::as_i64)
                .unwrap_or(0)
                .max(0) as u32,
            created_at: req_str(value, "createdAt").unwrap_or_default(),
            updated_at: req_str(value, "updatedAt").unwrap_or_default(),
            committed_at: value
                .get("committedAt")
                .and_then(Json::as_str)
                .map(|s| s.to_string()),
            base_revision: value
                .get("baseRevision")
                .and_then(Json::as_i64)
                .unwrap_or(0)
                .max(0) as u32,
            formal: match value.get("formal") {
                Some(Json::Null) | None => None,
                Some(v) => Some(Snapshot::from_json(v)?),
            },
            draft: match value.get("draft") {
                Some(Json::Null) | None => None,
                Some(v) => Some(Snapshot::from_json(v)?),
            },
        })
    }
}
