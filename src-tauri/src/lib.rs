//! Tauri v2 命令层：只做参数适配与错误转换，权威逻辑全部在 shiguang_core。
//!
//! 注意：本目录在 Unit-0 环境因缺少 pkg-config / webkit2gtk 无法构建，状态记 BLOCKED。

use serde::Deserialize;
use shiguang_core::json::Json;
use shiguang_core::model::RecordRow;
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

fn to_value(json: Json) -> Result<serde_json::Value, String> {
    serde_json::from_str(&json.dump()).map_err(|e| format!("序列化失败：{e}"))
}

fn record_value(row: &RecordRow) -> Result<serde_json::Value, String> {
    to_value(row.to_json())
}

#[tauri::command]
fn create_draft(
    input: CreateDraftInput,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut store = state.store.lock().map_err(|e| e.to_string())?;
    let row = store
        .create_draft(
            input.base_record_id.as_deref(),
            &input.title,
            &input.body,
            &input.event_date,
            input.event_time.as_deref(),
        )
        .map_err(|e| e.message)?;
    record_value(&row)
}

#[tauri::command]
fn save_draft(
    input: SaveDraftInput,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut store = state.store.lock().map_err(|e| e.to_string())?;
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
        .map_err(|e| e.message)?;
    record_value(&row)
}

#[tauri::command]
fn attach_photo(
    input: AttachPhotoInput,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut store = state.store.lock().map_err(|e| e.to_string())?;
    store
        .attach_photo(
            &input.record_id,
            std::path::Path::new(&input.source_path),
            &input.caption,
            input.media_type.as_deref(),
        )
        .map_err(|e| e.message)?;
    let row = store.row(&input.record_id).map_err(|e| e.message)?;
    record_value(row)
}

#[tauri::command]
fn commit_record(
    record_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut store = state.store.lock().map_err(|e| e.to_string())?;
    let outcome = store.commit(&record_id).map_err(|e| e.message)?;
    to_value(Json::obj(vec![
        ("recordId", Json::str(outcome.record_id)),
        (
            "contentRevision",
            Json::Num(outcome.content_revision as i64),
        ),
        ("committedAt", Json::str(outcome.committed_at)),
    ]))
}

#[tauri::command]
fn list_formal_records(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let rows: Result<Vec<_>, String> = store
        .list_formal()
        .into_iter()
        .map(record_value)
        .collect();
    Ok(serde_json::Value::Array(rows?))
}

#[tauri::command]
fn get_record(
    record_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let row = store.row(&record_id).map_err(|e| e.message)?;
    record_value(row)
}

#[tauri::command]
fn export_manifest(
    out_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let manifest = store
        .manifest_json(&[("tauri".to_string(), tauri::VERSION.to_string())])
        .map_err(|e| e.message)?;
    std::fs::write(&out_path, manifest.pretty()).map_err(|e| e.to_string())?;
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
            commit_record,
            list_formal_records,
            get_record,
            export_manifest
        ])
        .run(tauri::generate_context!())
        .expect("启动拾光桌面壳失败");
}
