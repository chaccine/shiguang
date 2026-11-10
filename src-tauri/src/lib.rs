//! Tauri v2 命令层：只做参数适配与错误转换，权威逻辑全部在 shiguang_core。
//!
//! box 本机缺 webkit2gtk 无法构建桌面壳；三端构建由 GitHub Actions 验证。

use serde::{Deserialize, Serialize};
use shiguang_core::json::Json;
use shiguang_core::model::{
    ConflictChoice, ConflictCopy, CoreError, MediaReport, PhotoStatus, PurgeOutcome, RecordRow,
};
use shiguang_core::Store;
use std::sync::Mutex;
use tauri::Manager;

mod backup_cmd;

pub struct AppState {
    store: Mutex<Result<Store, CoreError>>,
    /// 启动核查结果；覆盖恢复后会被新的核查结果替换。
    media_report: Mutex<Result<MediaReport, CoreError>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CreateDraftInput {
    pub title: String,
    pub body: String,
    pub event_date: String,
    pub event_time: Option<String>,
    pub base_record_id: Option<String>,
}

impl Default for CreateDraftInput {
    fn default() -> Self {
        Self {
            title: String::new(),
            body: String::new(),
            event_date: String::new(),
            event_time: None,
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
}

impl From<CoreError> for CommandError {
    fn from(error: CoreError) -> Self {
        Self {
            code: error.code,
            stage: error.stage,
            message: error.message,
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

#[tauri::command(rename_all = "camelCase")]
fn store_status(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    match slot.as_ref() {
        Ok(_) => Ok(serde_json::json!({ "ok": true })),
        Err(error) => to_value(error.to_json()),
    }
}

#[tauri::command(rename_all = "camelCase")]
fn media_report(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let mut slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let row = store.trash_record(&record_id).map_err(CommandError::from)?;
    save_value(Some(&row), store)
}

#[tauri::command(rename_all = "camelCase")]
fn restore_record(
    record_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let mut slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let outcome = store.purge_record(&record_id).map_err(CommandError::from)?;
    Ok(purge_value(&outcome, store))
}

#[tauri::command(rename_all = "camelCase")]
fn empty_trash(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let mut slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let outcome = store.empty_trash().map_err(CommandError::from)?;
    Ok(purge_value(&outcome, store))
}

#[tauri::command(rename_all = "camelCase")]
fn list_trash(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let mut slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let mut slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let mut slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let row = store
        .create_draft(
            input.base_record_id.as_deref(),
            &input.title,
            &input.body,
            &input.event_date,
            input.event_time.as_deref(),
        )
        .map_err(CommandError::from)?;
    save_value(Some(&row), store)
}

#[tauri::command(rename_all = "camelCase")]
fn save_draft(
    input: SaveDraftInput,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let time_patch = if input.clear_event_time {
        Some(None)
    } else {
        input.event_time.as_deref().map(Some)
    };
    let row = store
        .save_draft(
            &input.record_id,
            input.title.as_deref(),
            input.body.as_deref(),
            input.event_date.as_deref(),
            time_patch,
        )
        .map_err(CommandError::from)?;
    save_value(Some(&row), store)
}

#[tauri::command(rename_all = "camelCase")]
fn attach_photo(
    input: AttachPhotoInput,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let mut slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let mut slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let row = store
        .remove_draft_photo(&record_id, &photo_use_id)
        .map_err(CommandError::from)?;
    save_value(Some(&row), store)
}

#[tauri::command(rename_all = "camelCase")]
fn discard_draft(
    record_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    let row = store
        .discard_draft(&record_id)
        .map_err(CommandError::from)?;
    save_value(row.as_ref(), store)
}

#[tauri::command(rename_all = "camelCase")]
fn list_drafts(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let store = slot.as_ref().map_err(|e| CommandError::from(e.clone()))?;
    let rows: Result<Vec<_>, _> = store.list_drafts().into_iter().map(record_value).collect();
    Ok(serde_json::Value::Array(rows?))
}

#[tauri::command(rename_all = "camelCase")]
fn photo_data_url(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, CommandError> {
    use std::io::Read;
    let slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let mut slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let store = slot.as_ref().map_err(|e| CommandError::from(e.clone()))?;
    let row = store.row(&record_id).map_err(CommandError::from)?;
    record_value(row)
}

#[tauri::command(rename_all = "camelCase")]
fn export_manifest(
    out_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let slot = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            backup_cmd::clean_cache(app.handle());
            // 数据目录/锁/迁移错误由命令返回，仍然启动窗口以显示中文提示。
            let opened = app
                .path()
                .app_data_dir()
                .map_err(|e| CoreError::io(format!("无法解析应用数据目录：{e}")))
                .and_then(Store::open_exclusive);
            let (store, media_report) = match opened {
                Ok(mut store) => {
                    let report = store.reconcile_media();
                    (Ok(store), report)
                }
                Err(error) => (Err(error.clone()), Err(error)),
            };
            app.manage(AppState {
                store: Mutex::new(store),
                media_report: Mutex::new(media_report),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_draft,
            save_draft,
            attach_photo,
            attach_photo_bytes,
            remove_draft_photo,
            discard_draft,
            list_drafts,
            photo_data_url,
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
            backup_cmd::discard_picked_backup
        ])
        .run(tauri::generate_context!())
        .expect("启动拾光桌面壳失败");
}
