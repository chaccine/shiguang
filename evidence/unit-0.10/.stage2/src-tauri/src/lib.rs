//! Tauri v2 命令层：只做参数适配与错误转换，权威逻辑全部在 shiguang_core。
//!
//! box 本机缺 webkit2gtk 无法构建桌面壳；三端构建由 GitHub Actions 验证。

use serde::{Deserialize, Serialize};
use shiguang_core::json::Json;
use shiguang_core::model::{
    ConflictChoice, ConflictCopy, CoreError, MediaReport, PhotoStatus, PurgeOutcome, RecordRow,
};
use shiguang_core::session::OpenOnce;
use shiguang_core::Store;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

#[cfg(target_os = "android")]
mod android_thumb;
mod backup_cmd;
mod u07_cmd;

/// 进程级共享状态：在注册命令前就交给 Tauri 管理（热修复：不再只在 setup 里 manage）。
/// Android Activity 重建会在同一进程里再次进入 `run()`；此时复用同一个 Store，
/// 而不是再次打开数据目录（那会撞上仍被持有的进程内锁）。
pub struct Shared {
    store: OpenOnce<Store>,
    /// 启动核查结果；覆盖恢复后会被新的核查结果替换。
    media_report: Mutex<Result<MediaReport, CoreError>>,
}

#[derive(Clone)]
pub struct AppState(Arc<Shared>);

impl std::ops::Deref for AppState {
    type Target = Shared;
    fn deref(&self) -> &Shared {
        &self.0
    }
}

fn shared_state() -> AppState {
    static SHARED: OnceLock<AppState> = OnceLock::new();
    SHARED
        .get_or_init(|| {
            AppState(Arc::new(Shared {
                store: OpenOnce::new(),
                media_report: Mutex::new(Err(CoreError::new(
                    shiguang_core::session::STORE_STARTING,
                    "拾光还在打开你的数据，请稍等几秒再试。",
                ))),
            }))
        })
        .clone()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CreateDraftInput {
    pub title: String,
    pub body: String,
    pub event_date: String,
    pub event_time: Option<String>,
    pub location: String,
    pub mood: Option<String>,
    pub base_record_id: Option<String>,
}

impl Default for CreateDraftInput {
    fn default() -> Self {
        Self {
            title: String::new(),
            body: String::new(),
            event_date: String::new(),
            event_time: None,
            location: String::new(),
            mood: None,
            base_record_id: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SaveDraftInput {
    pub record_id: String,
    pub title: Option<String>,
    pub body: Option<String>,
    pub event_date: Option<String>,
    pub event_time: Option<String>,
    pub clear_event_time: bool,
    pub location: Option<String>,
    pub mood: Option<String>,
    pub clear_mood: bool,
}

impl Default for SaveDraftInput {
    fn default() -> Self {
        Self {
            record_id: String::new(),
            title: None,
            body: None,
            event_date: None,
            event_time: None,
            clear_event_time: false,
            location: None,
            mood: None,
            clear_mood: false,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AttachPhotoInput {
    pub record_id: String,
    pub source_path: String,
    pub caption: String,
    pub media_type: Option<String>,
}

impl Default for AttachPhotoInput {
    fn default() -> Self {
        Self {
            record_id: String::new(),
            source_path: String::new(),
            caption: String::new(),
            media_type: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachPhotoBytesInput {
    pub record_id: String,
    pub file_name: String,
    #[serde(default)]
    pub caption: String,
    pub media_type: Option<String>,
    pub bytes: Vec<u8>,
}

#[derive(Serialize)]
pub struct CommandError {
    code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<&'static str>,
    message: String,
    /// TAG_NAME_CONFLICT：已存在的同名标签，界面据此提供“合并到它”。
    #[serde(rename = "tagId", skip_serializing_if = "Option::is_none")]
    tag_id: Option<String>,
}

impl From<CoreError> for CommandError {
    fn from(error: CoreError) -> Self {
        Self {
            code: error.code,
            stage: error.stage,
            message: error.message,
            tag_id: error.tag_id,
        }
    }
}

fn command_error(code: &'static str, error: impl std::fmt::Display) -> CommandError {
    CoreError::new(code, error.to_string()).into()
}

fn to_value(json: Json) -> Result<serde_json::Value, CommandError> {
    serde_json::from_str(&json.dump()).map_err(|e| {
        CoreError::with_stage(
            "STATE_SERIALIZE_FAILED",
            "serialize",
            format!("序列化失败：{e}"),
        )
        .into()
    })
}

fn record_value(row: &RecordRow) -> Result<serde_json::Value, CommandError> {
    to_value(row.to_json())
}

fn save_value(row: Option<&RecordRow>, store: &Store) -> Result<serde_json::Value, CommandError> {
    to_value(Json::obj(vec![
        ("row", row.map(RecordRow::to_json).unwrap_or(Json::Null)),
        ("durability", Json::str(store.last_durability().as_str())),
    ]))
}

fn quarantined_value(items: &[shiguang_core::QuarantinedMedia]) -> serde_json::Value {
    serde_json::Value::Array(
        items
            .iter()
            .map(|item| {
                serde_json::json!({
                    "assetId": item.asset_id,
                    "file": item.file,
                    "movedTo": item.moved_to,
                })
            })
            .collect(),
    )
}

fn purge_value(outcome: &PurgeOutcome, store: &Store) -> serde_json::Value {
    serde_json::json!({
        "deletionMarkers": outcome.deletion_markers.iter().map(|marker| serde_json::json!({
            "recordId": marker.record_id,
            "deletedAt": marker.deleted_at,
            "lastContentRevision": marker.last_content_revision,
        })).collect::<Vec<_>>(),
        "quarantined": quarantined_value(&outcome.quarantined),
        "durability": store.last_durability().as_str(),
    })
}

fn conflict_value(copy: &ConflictCopy) -> Result<serde_json::Value, CommandError> {
    Ok(serde_json::json!({
        "conflictId": copy.conflict_id,
        "recordId": copy.record_id,
        "baseRevision": copy.base_revision,
        "snapshot": to_value(copy.snapshot.to_json())?,
        "createdAt": copy.created_at,
        "reason": copy.reason,
    }))
}

fn report_value(report: &MediaReport) -> serde_json::Value {
    let issues = |items: &[shiguang_core::MediaIssue]| {
        items
            .iter()
            .map(|issue| {
                serde_json::json!({
                    "recordId": issue.record_id,
                    "photoUseId": issue.photo_use_id,
                    "assetId": issue.asset_id,
                })
            })
            .collect::<Vec<_>>()
    };
    serde_json::json!({
        "quarantined": quarantined_value(&report.quarantined),
        "missing": issues(&report.missing),
        "corrupt": issues(&report.corrupt),
        "checkedAt": report.checked_at,
    })
}

/// 启动时前端首先调用；在后台线程等待数据打开完成（不占用主线程），返回真实结果。
#[tauri::command(rename_all = "camelCase")]
async fn store_status(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let slot = shared.store.wait_lock()?;
        match slot.as_ref() {
            Ok(_) => Ok(serde_json::json!({ "ok": true })),
            Err(error) => to_value(error.to_json()),
        }
    })
    .await
    .map_err(|e| command_error("STORE_STARTING", format!("后台任务失败：{e}")))?
}

#[tauri::command(rename_all = "camelCase")]
fn media_report(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let slot = state.store.wait_lock()?;
    slot.as_ref().map_err(|e| CommandError::from(e.clone()))?;
    let report = state
        .media_report
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let report = report.as_ref().map_err(|e| CommandError::from(e.clone()))?;
    Ok(report_value(report))
}

#[tauri::command(rename_all = "camelCase")]
fn photo_status(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<&'static str, CommandError> {
    let slot = state.store.wait_lock()?;
    let store = slot.as_ref().map_err(|e| CommandError::from(e.clone()))?;
    Ok(
        match store.photo_status(&asset_id).map_err(CommandError::from)? {
            PhotoStatus::Available => "available",
            PhotoStatus::Missing => "missing",
            PhotoStatus::Corrupt => "corrupt",
        },
    )
}

#[tauri::command(rename_all = "camelCase")]
fn trash_record(
    record_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let row = store.trash_record(&record_id).map_err(CommandError::from)?;
    save_value(Some(&row), store)
}

#[tauri::command(rename_all = "camelCase")]
fn restore_record(
    record_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let row = store
        .restore_record(&record_id)
        .map_err(CommandError::from)?;
    save_value(Some(&row), store)
}

#[tauri::command(rename_all = "camelCase")]
fn purge_record(
    record_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let outcome = store.purge_record(&record_id).map_err(CommandError::from)?;
    Ok(purge_value(&outcome, store))
}

#[tauri::command(rename_all = "camelCase")]
fn empty_trash(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let outcome = store.empty_trash().map_err(CommandError::from)?;
    Ok(purge_value(&outcome, store))
}

#[tauri::command(rename_all = "camelCase")]
fn list_trash(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let slot = state.store.wait_lock()?;
    let store = slot.as_ref().map_err(|e| CommandError::from(e.clone()))?;
    let rows: Result<Vec<_>, _> = store
        .list_trash()
        .map_err(CommandError::from)?
        .into_iter()
        .map(record_value)
        .collect();
    Ok(serde_json::Value::Array(rows?))
}

#[tauri::command(rename_all = "camelCase")]
fn resolve_conflict(
    record_id: String,
    choice: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let choice = match choice.as_str() {
        "keepMine" => ConflictChoice::KeepMine,
        "keepFormal" => ConflictChoice::KeepFormal,
        _ => {
            return Err(command_error(
                "INVALID_CONFLICT_CHOICE",
                "请选择以我的草稿为准或保留当前正式版",
            ))
        }
    };
    let row = store
        .resolve_conflict(&record_id, choice)
        .map_err(CommandError::from)?;
    save_value(Some(&row), store)
}

#[tauri::command(rename_all = "camelCase")]
fn list_conflict_copies(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let slot = state.store.wait_lock()?;
    let store = slot.as_ref().map_err(|e| CommandError::from(e.clone()))?;
    let copies: Result<Vec<_>, _> = store
        .list_conflict_copies()
        .map_err(CommandError::from)?
        .iter()
        .map(conflict_value)
        .collect();
    Ok(serde_json::Value::Array(copies?))
}

#[tauri::command(rename_all = "camelCase")]
fn restore_conflict_copy(
    conflict_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let row = store
        .restore_conflict_copy(&conflict_id)
        .map_err(CommandError::from)?;
    save_value(Some(&row), store)
}

#[tauri::command(rename_all = "camelCase")]
fn create_draft(
    input: CreateDraftInput,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let row = store
        .create_draft_with_fields(
            input.base_record_id.as_deref(),
            &shiguang_core::DraftPatch {
                title: Some(input.title),
                body: Some(input.body),
                event_date: Some(input.event_date),
                event_time: Some(input.event_time),
                location: Some(input.location),
                mood: Some(
                    input
                        .mood
                        .as_deref()
                        .map(shiguang_core::Mood::parse)
                        .transpose()?,
                ),
            },
        )
        .map_err(CommandError::from)?;
    save_value(Some(&row), store)
}

#[tauri::command(rename_all = "camelCase")]
fn save_draft(
    input: SaveDraftInput,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let time_patch = if input.clear_event_time {
        Some(None)
    } else {
        input.event_time.map(Some)
    };
    let row = store
        .save_draft_patch(
            &input.record_id,
            &shiguang_core::DraftPatch {
                title: input.title,
                body: input.body,
                event_date: input.event_date,
                event_time: time_patch,
                location: input.location,
                mood: if input.clear_mood {
                    Some(None)
                } else {
                    input
                        .mood
                        .as_deref()
                        .map(shiguang_core::Mood::parse)
                        .transpose()?
                        .map(Some)
                },
            },
        )
        .map_err(CommandError::from)?;
    save_value(Some(&row), store)
}

#[tauri::command(rename_all = "camelCase")]
fn attach_photo(
    input: AttachPhotoInput,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    store
        .attach_photo(
            &input.record_id,
            std::path::Path::new(&input.source_path),
            &input.caption,
            input.media_type.as_deref(),
        )
        .map_err(CommandError::from)?;
    let row = store.row(&input.record_id).map_err(CommandError::from)?;
    record_value(row)
}

#[tauri::command(rename_all = "camelCase")]
fn attach_photo_bytes(
    input: AttachPhotoBytesInput,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    store
        .attach_photo_bytes(
            &input.record_id,
            &input.file_name,
            &input.bytes,
            &input.caption,
            input.media_type.as_deref(),
        )
        .map_err(CommandError::from)?;
    save_value(
        Some(store.row(&input.record_id).map_err(CommandError::from)?),
        store,
    )
}

#[tauri::command(rename_all = "camelCase")]
fn remove_draft_photo(
    record_id: String,
    photo_use_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let row = store
        .remove_draft_photo(&record_id, &photo_use_id)
        .map_err(CommandError::from)?;
    save_value(Some(&row), store)
}

#[tauri::command(rename_all = "camelCase")]
fn set_draft_photo_caption(
    record_id: String,
    photo_use_id: String,
    caption: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let row = store.set_draft_photo_caption(&record_id, &photo_use_id, &caption)?;
    save_value(Some(&row), store)
}
#[tauri::command(rename_all = "camelCase")]
fn set_draft_cover(
    record_id: String,
    photo_use_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let row = store.set_draft_cover(&record_id, &photo_use_id)?;
    save_value(Some(&row), store)
}
#[tauri::command(rename_all = "camelCase")]
fn reorder_draft_photos(
    record_id: String,
    photo_use_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let row = store.reorder_draft_photos(&record_id, &photo_use_ids)?;
    save_value(Some(&row), store)
}

#[tauri::command(rename_all = "camelCase")]
fn discard_draft(
    record_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let row = store
        .discard_draft(&record_id)
        .map_err(CommandError::from)?;
    save_value(row.as_ref(), store)
}

#[tauri::command(rename_all = "camelCase")]
fn list_drafts(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let slot = state.store.wait_lock()?;
    let store = slot.as_ref().map_err(|e| CommandError::from(e.clone()))?;
    let rows: Result<Vec<_>, _> = store.list_drafts().into_iter().map(record_value).collect();
    Ok(serde_json::Value::Array(rows?))
}

#[tauri::command(rename_all = "camelCase")]
async fn photo_thumb_url(
    asset_id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<String, CommandError> {
    // Run decoding and hashing off the IPC/UI thread. Store mutex serializes cache writers.
    let shared = state.inner().clone();
    #[cfg(not(target_os = "android"))]
    let _ = window;
    tauri::async_runtime::spawn_blocking(move || {
        let slot = shared.store.wait_lock()?;
        let store = slot.as_ref().map_err(|e| CommandError::from(e.clone()))?;
        match store.photo_status(&asset_id).map_err(CommandError::from)? {
            PhotoStatus::Available => {}
            PhotoStatus::Missing => return Err(command_error("ASSET_MISSING", "原图缺失")),
            PhotoStatus::Corrupt => {
                return Err(command_error("ASSET_HASH_MISMATCH", "原图校验失败"))
            }
        }
        let source = store
            .asset_path(&asset_id)
            .ok_or_else(|| command_error("ASSET_MISSING", "原图缺失"))?;
        // v2 suffix prevents reusing Unit-0's synthetic stripe caches.
        let target = store.preview_path(&asset_id);
        if !target.exists() {
            let heic = store.all_photos().iter().any(|p| {
                p.asset_id == asset_id
                    && matches!(p.media_type.as_str(), "image/heic" | "image/heif")
            });
            let decoded = shiguang_thumbnails::generate(&source, &target);
            #[cfg(target_os = "android")]
            let decoded = decoded.or_else(|_| android_thumb::generate(window, &source, &target));
            decoded.map_err(|_| {
                command_error(
                    if heic {
                        "HEIC_UNSUPPORTED"
                    } else {
                        "PREVIEW_UNSUPPORTED"
                    },
                    if heic {
                        "无法预览 HEIC 图片"
                    } else {
                        "图片暂时无法显示"
                    },
                )
            })?;
        }
        let bytes = std::fs::read(target).map_err(|e| command_error("ASSET_READ_FAILED", e))?;
        Ok(format!(
            "data:image/png;base64,{}",
            shiguang_core::base64::encode(&bytes)
        ))
    })
    .await
    .map_err(|e| command_error("PREVIEW_UNSUPPORTED", e))?
}

#[tauri::command(rename_all = "camelCase")]
fn photo_data_url(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, CommandError> {
    use std::io::Read;
    let slot = state.store.wait_lock()?;
    let store = slot.as_ref().map_err(|e| CommandError::from(e.clone()))?;
    match store.photo_status(&asset_id).map_err(CommandError::from)? {
        PhotoStatus::Available => {}
        PhotoStatus::Missing => return Err(command_error("ASSET_MISSING", "原图缺失")),
        PhotoStatus::Corrupt => return Err(command_error("ASSET_HASH_MISMATCH", "原图校验失败")),
    }
    let path = store
        .asset_path(&asset_id)
        .ok_or_else(|| command_error("ASSET_MISSING", "原图不存在"))?;
    let file = std::fs::File::open(&path).map_err(|e| command_error("ASSET_READ_FAILED", e))?;
    const LIMIT: u64 = 8 * 1024 * 1024;
    if file
        .metadata()
        .map_err(|e| command_error("ASSET_READ_FAILED", e))?
        .len()
        > LIMIT
    {
        return Err(command_error(
            "PREVIEW_TOO_LARGE",
            "原图超过 8MB，暂不提供内嵌预览",
        ));
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| command_error("ASSET_READ_FAILED", e))?;
    if bytes.len() as u64 > LIMIT {
        return Err(command_error(
            "PREVIEW_TOO_LARGE",
            "原图超过 8MB，暂不提供内嵌预览",
        ));
    }
    // 优先使用持久化的 mediaType；孤立原图只能按受控扩展名回退。
    let rows = store
        .list_drafts()
        .into_iter()
        .chain(store.list_formal())
        .chain(store.list_trash().map_err(CommandError::from)?);
    let photo = rows
        .flat_map(|row| row.draft.iter().chain(row.formal.iter()))
        .flat_map(|snapshot| snapshot.photos.iter())
        .find(|p| p.asset_id == asset_id);
    let fallback = match path.extension().and_then(|v| v.to_str()) {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    };
    let media_type = photo.map(|p| p.media_type.as_str()).unwrap_or(fallback);
    Ok(format!(
        "data:{media_type};base64,{}",
        shiguang_core::base64::encode(&bytes)
    ))
}

#[tauri::command(rename_all = "camelCase")]
fn commit_record(
    record_id: String,
    expected_base_revision: u32,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let outcome = store
        .commit(&record_id, expected_base_revision)
        .map_err(CommandError::from)?;
    to_value(Json::obj(vec![
        ("recordId", Json::str(outcome.record_id)),
        (
            "contentRevision",
            Json::Num(outcome.content_revision as i64),
        ),
        ("committedAt", Json::str(outcome.committed_at)),
        ("durability", Json::str(outcome.durability.as_str())),
    ]))
}

#[tauri::command(rename_all = "camelCase")]
fn list_formal_records(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let slot = state.store.wait_lock()?;
    let store = slot.as_ref().map_err(|e| CommandError::from(e.clone()))?;
    let rows: Result<Vec<_>, CommandError> =
        store.list_formal().into_iter().map(record_value).collect();
    Ok(serde_json::Value::Array(rows?))
}

#[tauri::command(rename_all = "camelCase")]
fn get_record(
    record_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let slot = state.store.wait_lock()?;
    let store = slot.as_ref().map_err(|e| CommandError::from(e.clone()))?;
    let row = store.row(&record_id).map_err(CommandError::from)?;
    record_value(row)
}

#[tauri::command(rename_all = "camelCase")]
fn export_manifest(
    out_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let slot = state.store.wait_lock()?;
    let store = slot.as_ref().map_err(|e| CommandError::from(e.clone()))?;
    let manifest = store
        .manifest_json(&[("tauri".to_string(), tauri::VERSION.to_string())])
        .map_err(CommandError::from)?;
    std::fs::write(&out_path, manifest.pretty()).map_err(|e| command_error("IO_ERROR", e))?;
    to_value(Json::obj(vec![
        ("out", Json::str(out_path)),
        ("records", Json::Num(store.list_formal().len() as i64)),
    ]))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = shared_state();
    tauri::Builder::default()
        // 先 manage 再注册命令：任何时刻调用命令都不会出现 “state not managed”。
        .manage(state.clone())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(move |app| {
            // 同一进程只打开一次；Activity 重建再次进入时直接复用。
            if !state.store.begin() {
                return Ok(());
            }
            backup_cmd::clean_cache(app.handle());
            // 数据目录/锁/迁移错误保存在槽里由命令返回，仍然启动窗口以显示中文提示。
            let data_dir = app.path().app_data_dir();
            // 在后台线程打开并核查原图（可能要几秒），不阻塞 Android 主线程；
            // 命令在打开完成前会等待（OpenOnce），不会报“未管理”或读到半成品。
            let shared = state.clone();
            let spawned = std::thread::Builder::new()
                .name("shiguang-open".into())
                .spawn(move || {
                // 打开过程中的任何 panic 都转成可操作的错误，绝不让命令永远等待或报“未管理”。
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                    let opened = data_dir
                        .map_err(|e| CoreError::io(format!("无法解析应用数据目录：{e}")))
                        .and_then(Store::open_exclusive);
                    match opened {
                        Ok(mut store) => {
                            let report = store.reconcile_media();
                            (Ok(store), report)
                        }
                        Err(error) => (Err(error.clone()), Err(error)),
                    }
                }));
                let (store, media_report) = outcome.unwrap_or_else(|_| {
                    let error = CoreError::new(
                        "STORE_OPEN_PANIC",
                        "打开数据时发生内部错误。你的数据没有被改动；请完全退出拾光后重新打开，若仍出现请把这段提示截图发给开发者。",
                    );
                    (Err(error.clone()), Err(error))
                });
                if let Ok(mut slot) = shared.media_report.lock() {
                    *slot = media_report;
                }
                shared.store.finish(store);
                });
            if let Err(e) = spawned {
                state.store.finish(Err(CoreError::io(format!("无法启动数据打开线程：{e}"))));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_draft,
            save_draft,
            attach_photo,
            attach_photo_bytes,
            remove_draft_photo,
            set_draft_photo_caption,
            set_draft_cover,
            reorder_draft_photos,
            discard_draft,
            list_drafts,
            photo_data_url,
            photo_thumb_url,
            commit_record,
            list_formal_records,
            get_record,
            export_manifest,
            trash_record,
            restore_record,
            purge_record,
            empty_trash,
            list_trash,
            resolve_conflict,
            list_conflict_copies,
            restore_conflict_copy,
            media_report,
            photo_status,
            store_status,
            backup_cmd::backup_capabilities,
            backup_cmd::export_backup,
            backup_cmd::pick_backup,
            backup_cmd::restore_backup,
            backup_cmd::discard_picked_backup,
            backup_cmd::unlock_backup,
            backup_cmd::plan_merge,
            backup_cmd::merge_backup,
            u07_cmd::set_favorite,
            u07_cmd::set_record_tags,
            u07_cmd::list_tags,
            u07_cmd::create_tag,
            u07_cmd::rename_tag,
            u07_cmd::merge_tags,
            u07_cmd::delete_tag,
            u07_cmd::tag_impact,
            u07_cmd::timeline_page,
            u07_cmd::timeline_months,
            u07_cmd::calendar_month,
            u07_cmd::day_entries,
            u07_cmd::on_this_day
        ])
        .run(tauri::generate_context!())
        .expect("启动拾光桌面壳失败");
}
