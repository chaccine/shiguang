//! Tauri v2 命令层：只做参数适配与错误转换，权威逻辑全部在 shiguang_core。
//!
//! 注意：本目录在 Unit-0 环境因缺少 pkg-config / webkit2gtk 无法构建，状态记 BLOCKED。

use serde::{Deserialize, Serialize};
use shiguang_core::json::Json;
use shiguang_core::model::{CoreError, RecordRow};
use shiguang_core::Store;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    store: Mutex<Store>,
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

#[tauri::command(rename_all = "camelCase")]
fn create_draft(
    input: CreateDraftInput,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut store = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let row = store
        .create_draft(
            input.base_record_id.as_deref(),
            &input.title,
            &input.body,
            &input.event_date,
            input.event_time.as_deref(),
        )
        .map_err(CommandError::from)?;
    save_value(Some(&row), &store)
}

#[tauri::command(rename_all = "camelCase")]
fn save_draft(
    input: SaveDraftInput,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut store = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    save_value(Some(&row), &store)
}

#[tauri::command(rename_all = "camelCase")]
fn attach_photo(
    input: AttachPhotoInput,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut store = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let mut store = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
        &store,
    )
}

#[tauri::command(rename_all = "camelCase")]
fn remove_draft_photo(
    record_id: String,
    photo_use_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut store = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let row = store
        .remove_draft_photo(&record_id, &photo_use_id)
        .map_err(CommandError::from)?;
    save_value(Some(&row), &store)
}

#[tauri::command(rename_all = "camelCase")]
fn discard_draft(
    record_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let mut store = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let row = store
        .discard_draft(&record_id)
        .map_err(CommandError::from)?;
    save_value(row.as_ref(), &store)
}

#[tauri::command(rename_all = "camelCase")]
fn list_drafts(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let store = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let rows: Result<Vec<_>, _> = store.list_drafts().into_iter().map(record_value).collect();
    Ok(serde_json::Value::Array(rows?))
}

#[tauri::command(rename_all = "camelCase")]
fn photo_data_url(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, CommandError> {
    use std::io::Read;
    let store = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let rows = store.list_drafts().into_iter().chain(store.list_formal());
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
    let mut store = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
    let store = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let rows: Result<Vec<_>, CommandError> =
        store.list_formal().into_iter().map(record_value).collect();
    Ok(serde_json::Value::Array(rows?))
}

#[tauri::command(rename_all = "camelCase")]
fn get_record(
    record_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let store = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
    let row = store.row(&record_id).map_err(CommandError::from)?;
    record_value(row)
}

#[tauri::command(rename_all = "camelCase")]
fn export_manifest(
    out_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let store = state
        .store
        .lock()
        .map_err(|e| command_error("STORE_LOCK_FAILED", e))?;
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
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法解析应用数据目录：{e}"))?;
            let store = Store::open(dir).map_err(|e| e.message)?;
            app.manage(AppState {
                store: Mutex::new(store),
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
            export_manifest
        ])
        .run(tauri::generate_context!())
        .expect("启动拾光桌面壳失败");
}
