//! M04 projections and independent recommendation preferences.
//! Today is a validated DEVICE LOCAL calendar date supplied by the adapter.
use crate::{to_value, u07_cmd::with_store, AppState, CommandError};
use shiguang_core::{json::Json, Order};

fn order(value: Option<&str>) -> Order {
    if value == Some("asc") { Order::Asc } else { Order::Desc }
}

#[tauri::command(rename_all = "camelCase")]
pub fn museum_reunion_preview(today: String, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    to_value(with_store(&state, |s| s.museum_reunion_preview(&today))?.to_json())
}
#[tauri::command(rename_all = "camelCase")]
pub fn museum_reunion_page(cursor: Option<String>, limit: usize, today: String, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    to_value(with_store(&state, |s| s.museum_reunion_page(cursor,limit,&today))?.to_json())
}
#[tauri::command(rename_all = "camelCase")]
pub fn museum_favorites_page(cursor: Option<String>, limit: usize, order: Option<String>, today: String, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    to_value(with_store(&state, |s| s.museum_favorites_page(self::order(order.as_deref()),cursor,limit,&today))?.to_json())
}
#[tauri::command(rename_all = "camelCase")]
pub fn museum_photos_page(cursor: Option<String>, limit: usize, order: Option<String>, today: String, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    to_value(with_store(&state, |s| s.museum_photos_page(self::order(order.as_deref()),cursor,limit,&today))?.to_json())
}
#[tauri::command(rename_all = "camelCase")]
pub fn museum_years(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let years=with_store(&state, |s| s.museum_years())?;
    to_value(Json::Arr(years.iter().map(|y| y.to_json()).collect()))
}
#[tauri::command(rename_all = "camelCase")]
pub fn museum_year_room(year: i64, cursor: Option<String>, limit: usize, order: Option<String>, today: String, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    to_value(with_store(&state, |s| s.museum_year_room(year,self::order(order.as_deref()),cursor,limit,&today))?.to_json())
}
#[tauri::command(rename_all = "camelCase")]
pub fn museum_reshuffle(seed: u32, previous_ids: Vec<String>, limit: usize, today: String, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    to_value(with_store(&state, |s| s.museum_reshuffle(seed,&previous_ids,limit,&today))?.to_json())
}
#[tauri::command(rename_all = "camelCase")]
pub fn museum_home_summary(today: String, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    to_value(with_store(&state, |s| s.museum_home_summary(&today))?.to_json())
}
#[tauri::command(rename_all = "camelCase")]
pub fn set_museum_hidden(record_id: String, hidden: bool, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    to_value(with_store(&state, |s| s.set_museum_hidden(&record_id,hidden))?.to_json())
}
#[tauri::command(rename_all = "camelCase")]
pub fn reset_museum_hidden(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    to_value(with_store(&state, |s| s.reset_museum_hidden())?.to_json())
}
