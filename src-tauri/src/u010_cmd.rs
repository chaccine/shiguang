//! Task A settings and optional UI gate. All Argon2 work stays on a worker.
use super::{command_error, to_value, AppState, CommandError};
use shiguang_core::{json::Json, CoreError, Store, ThemePreference};
use zeroize::Zeroizing;

async fn work(
    state: AppState,
    op: impl FnOnce(&mut Store) -> Result<Json, CoreError> + Send + 'static,
) -> Result<serde_json::Value, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut slot = state.store.wait_lock()?;
        let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
        to_value(op(store)?)
    })
    .await
    .map_err(|_| command_error("APP_LOCK_INTERNAL", "应用锁或设置操作未完成，请重试"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_settings(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    work(state.inner().clone(), |s| Ok(s.settings()?.to_json())).await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn set_theme(
    theme: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    work(state.inner().clone(), move |s| {
        Ok(s.set_theme(ThemePreference::parse(&theme)?)?.to_json())
    })
    .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn set_app_lock(
    passcode: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let passcode = Zeroizing::new(passcode);
    work(state.inner().clone(), move |s| {
        Ok(s.set_app_lock(&passcode)?.to_json())
    })
    .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn verify_app_lock(
    passcode: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let passcode = Zeroizing::new(passcode);
    work(state.inner().clone(), move |s| {
        Ok(s.verify_app_lock(&passcode)?.to_json())
    })
    .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn change_app_lock(
    current_passcode: String,
    new_passcode: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let current = Zeroizing::new(current_passcode);
    let replacement = Zeroizing::new(new_passcode);
    work(state.inner().clone(), move |s| {
        Ok(s.change_app_lock(&current, &replacement)?.to_json())
    })
    .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn disable_app_lock(
    current_passcode: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let current = Zeroizing::new(current_passcode);
    work(state.inner().clone(), move |s| {
        Ok(s.disable_app_lock(&current)?.to_json())
    })
    .await
}

#[tauri::command]
pub async fn storage_stats(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    work(state.inner().clone(), |s| Ok(s.storage_stats()?.to_json())).await
}
