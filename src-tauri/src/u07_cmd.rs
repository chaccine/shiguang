//! Unit-0.7 命令：珍藏 / 标签（独立元数据事务）与时光轴 / 日历只读查询。权威逻辑在 shiguang_core。
//! “今天”由前端传入设备本地日期（按发生日期的日历日期投影，不做 UTC 转换）。
use crate::{to_value, AppState, CommandError};
use serde::Deserialize;
use shiguang_core::json::Json;
use shiguang_core::{Order, Store, TagInfo, TimelineFilter};

fn with_store<T>(
    state: &tauri::State<'_, AppState>,
    f: impl FnOnce(&mut Store) -> Result<T, shiguang_core::CoreError>,
) -> Result<T, CommandError> {
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    f(store).map_err(CommandError::from)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FilterInput {
    pub from: Option<String>,
    pub to: Option<String>,
    pub favorite_only: bool,
    pub tag_ids: Vec<String>,
    pub has_photo: Option<bool>,
    pub order: Option<String>,
}

fn order(v: Option<&str>) -> Order {
    if v == Some("asc") {
        Order::Asc
    } else {
        Order::Desc
    }
}

impl FilterInput {
    fn into_core(self) -> TimelineFilter {
        TimelineFilter {
            from: self.from.filter(|s| !s.is_empty()),
            to: self.to.filter(|s| !s.is_empty()),
            favorite_only: self.favorite_only,
            tag_ids: self.tag_ids,
            has_photo: self.has_photo,
            order: order(self.order.as_deref()),
        }
    }
}

fn arr<T>(items: &[T], f: impl Fn(&T) -> Json) -> Json {
    Json::Arr(items.iter().map(f).collect())
}

fn info_of(store: &Store, tag_id: &str) -> Result<TagInfo, shiguang_core::CoreError> {
    store
        .list_tags()
        .into_iter()
        .find(|t| t.tag_id == tag_id)
        .ok_or_else(|| shiguang_core::CoreError::new("TAG_NOT_FOUND", "标签不存在"))
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_favorite(
    record_id: String,
    favorite: bool,
    expected_revision: Option<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let out = with_store(&state, |s| s.set_favorite(&record_id, favorite, expected_revision))?;
    to_value(out.to_json())
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_record_tags(
    record_id: String,
    tag_ids: Vec<String>,
    expected_revision: Option<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let out = with_store(&state, |s| s.set_record_tags(&record_id, &tag_ids, expected_revision))?;
    to_value(out.to_json())
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_tags(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let tags = with_store(&state, |s| Ok(s.list_tags()))?;
    to_value(arr(&tags, TagInfo::to_json))
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_tag(name: String, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let info = with_store(&state, |s| {
        let tag = s.create_tag(&name)?;
        info_of(s, &tag.tag_id)
    })?;
    to_value(info.to_json())
}

#[tauri::command(rename_all = "camelCase")]
pub fn rename_tag(
    tag_id: String,
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let info = with_store(&state, |s| {
        let tag = s.rename_tag(&tag_id, &name)?;
        info_of(s, &tag.tag_id)
    })?;
    to_value(info.to_json())
}

#[tauri::command(rename_all = "camelCase")]
pub fn merge_tags(
    from_tag_id: String,
    into_tag_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let (out, info) = with_store(&state, |s| {
        let out = s.merge_tags(&from_tag_id, &into_tag_id)?;
        let info = info_of(s, &out.into.tag_id)?;
        Ok((out, info))
    })?;
    to_value(Json::obj(vec![
        ("into", info.to_json()),
        ("affectedRecords", Json::Num(out.affected_records as i64)),
        ("durability", Json::str(out.durability.as_str())),
    ]))
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_tag(tag_id: String, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let out = with_store(&state, |s| s.delete_tag(&tag_id))?;
    to_value(out.to_json())
}

#[tauri::command(rename_all = "camelCase")]
pub fn tag_impact(tag_id: String, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let out = with_store(&state, |s| s.tag_impact(&tag_id))?;
    to_value(out.to_json())
}

#[tauri::command(rename_all = "camelCase")]
pub fn timeline_page(
    filter: FilterInput,
    cursor: Option<String>,
    limit: usize,
    today: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let f = filter.into_core();
    let page = with_store(&state, |s| s.timeline_page(&f, cursor, limit, &today))?;
    to_value(page.to_json())
}

#[tauri::command(rename_all = "camelCase")]
pub fn timeline_months(
    filter: FilterInput,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let f = filter.into_core();
    let months = with_store(&state, |s| s.timeline_months(&f))?;
    to_value(arr(&months, |m| m.to_json()))
}

#[tauri::command(rename_all = "camelCase")]
pub fn calendar_month(
    year: i64,
    month: u32,
    filter: Option<FilterInput>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let f = filter.map(FilterInput::into_core);
    let days = with_store(&state, |s| s.calendar_month(year, month, f.as_ref()))?;
    to_value(arr(&days, |d| d.to_json()))
}

#[tauri::command(rename_all = "camelCase")]
pub fn day_entries(
    date: String,
    order: Option<String>,
    today: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let o = self::order(order.as_deref());
    let items = with_store(&state, |s| s.day_entries(&date, o, &today))?;
    to_value(arr(&items, |i| i.to_json()))
}

#[tauri::command(rename_all = "camelCase")]
pub fn on_this_day(
    month: u32,
    day: u32,
    today: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    let groups = with_store(&state, |s| s.on_this_day(month, day, &today))?;
    to_value(arr(&groups, |g| g.to_json()))
}
