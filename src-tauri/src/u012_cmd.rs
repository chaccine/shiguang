//! M05 authoritative local search; no mutation or independent index.
use crate::{to_value, u07_cmd::{with_store, FilterInput}, AppState, CommandError};
use serde::Deserialize;
use shiguang_core::{CoreError, SearchFilter};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchInput {
    keyword: String,
    #[serde(flatten)]
    timeline: FilterInput,
}

#[tauri::command(rename_all = "camelCase")]
pub fn search_page(filter: SearchInput, cursor: Option<String>, limit: usize, today: String,
    state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    if filter.timeline.order.as_deref().is_some_and(|v| v != "asc" && v != "desc") {
        return Err(CoreError::new("INVALID_SEARCH_FILTER", "排序需为 asc 或 desc").into());
    }
    let filter = SearchFilter { keyword: filter.keyword, timeline: filter.timeline.into_core() };
    to_value(with_store(&state, |s| s.search_page(&filter, cursor, limit, &today))?.to_json())
}
