//! M05: on-demand search of active FORMAL snapshots. No persisted index.
//! A content-derived generation binds every page to the authoritative search source,
//! including restored/imported content even when revision counters coincide.
use crate::{json::{self, Json}, query, sha256, CoreError, RecordRow, RecordStatus, State, Store, TimelineFilter, TimelinePage};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Default)]
pub struct SearchFilter {
    pub keyword: String,
    pub timeline: TimelineFilter,
}
#[derive(Clone, Debug)]
pub struct SearchPage {
    pub page: TimelinePage,
    pub query_key: String,
    pub source_generation: String,
}
impl SearchPage {
    pub fn to_json(&self) -> Json {
        let Json::Obj(mut fields) = self.page.to_json() else { unreachable!() };
        fields.push(("queryKey".into(), Json::str(&self.query_key)));
        fields.push(("sourceGeneration".into(), Json::str(&self.source_generation)));
        Json::Obj(fields)
    }
}
// Match ECMAScript trim exactly; case folding is ASCII English only. Other
// Unicode remains literal (no normalization, stemming or cross-field matching).
fn trim_query(s: &str) -> &str {
    s.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
fn strings(values: &[String]) -> Json { Json::Arr(values.iter().map(Json::str).collect()) }
fn optional(value: Option<&str>) -> Json { value.map(Json::str).unwrap_or(Json::Null) }
fn fingerprint(value: Json) -> String { sha256::hex_digest(value.dump().as_bytes()) }
fn source_row(r: &RecordRow) -> Json {
    let f = r.formal.as_ref().expect("active formal");
    let mut source = vec![
        Json::str(&r.record_id), Json::str(&r.created_at), Json::Num(r.content_revision.into()),
        Json::Bool(r.favorite), Json::Num(r.favorite_revision.into()), strings(&r.tag_ids), Json::Num(r.tag_revision.into()),
        Json::Arr(vec![Json::str(&f.title), Json::str(&f.body), Json::str(&f.event_date), optional(f.event_time.as_deref()),
            Json::str(&f.location), f.mood.map(|m| Json::str(m.as_str())).unwrap_or(Json::Null), optional(f.cover_photo_use_id.as_deref()),
            Json::Arr(f.photos.iter().map(|p| Json::Arr(vec![Json::str(&p.photo_use_id), Json::str(&p.asset_id), Json::str(&p.caption),
                Json::str(&p.sha256), Json::Num(p.bytes as i64), Json::str(&p.media_type)])).collect())]),
    ];
    if !f.story.is_legacy_shape() { source.push(f.story.to_json()); }
    Json::Arr(source)
}
fn source_generation(s: &State) -> String {
    let mut rows: Vec<_> = s.records.iter().filter(|r| r.status == RecordStatus::Active && r.formal.is_some()).collect();
    rows.sort_unstable_by(|a,b| a.record_id.cmp(&b.record_id));
    let mut tags: Vec<_> = s.tags.iter().collect();
    tags.sort_unstable_by(|a,b| a.tag_id.cmp(&b.tag_id));
    // Stream per-row serialization rather than cloning all bodies into an index.
    let mut digest = sha256::Sha256::new();
    for r in rows { digest.update(source_row(r).dump().as_bytes()); digest.update(b"\n"); }
    digest.update(Json::Arr(tags.iter().map(|t| Json::Arr(vec![Json::str(&t.tag_id),Json::str(&t.name)])).collect()).dump().as_bytes());
    sha256::hex(&digest.finalize())
}

// The shared JSON parser is recursive. Cursors contain only a flat array of
// scalar values; reject nested containers before passing untrusted bytes to it.
fn flat_array(raw: &str) -> bool {
    let (mut quoted, mut escaped, mut opens, mut depth) = (false, false, 0, 0);
    for b in raw.bytes() {
        if quoted {
            if escaped { escaped = false; }
            else if b == b'\\' { escaped = true; }
            else if b == b'"' { quoted = false; }
        } else {
            match b {
                b'"' => quoted = true,
                b'[' => { opens += 1; depth += 1; if opens > 1 { return false; } },
                b']' => { depth -= 1; if depth < 0 { return false; } },
                b'{' | b'}' => return false,
                _ => (),
            }
        }
    }
    !quoted && opens == 1 && depth == 0
}
fn flat_inner(raw: &str) -> bool {
    if raw.len() > 16384 || !raw.len().is_multiple_of(2) || !raw.bytes().all(|b| b.is_ascii_hexdigit()) { return false; }
    let bytes: Vec<_> = (0..raw.len()).step_by(2).map(|i| u8::from_str_radix(&raw[i..i+2], 16).expect("checked hex")).collect();
    std::str::from_utf8(&bytes).is_ok_and(flat_array)
}

pub fn search_page(s: &State, filter: &SearchFilter, cursor: Option<String>, limit: usize, today: &str) -> Result<SearchPage, CoreError> {
    let mut f = filter.timeline.clone();
    f.from = f.from.filter(|s| !s.is_empty()); f.to = f.to.filter(|s| !s.is_empty());
    f.tag_ids.sort(); f.tag_ids.dedup();
    query::validate_filter(&f)?; query::date(today)?;
    if !(1..=500).contains(&limit) { return Err(CoreError::new("INVALID_LIMIT", "每页条数请设置为 1–500")); }
    let keyword = trim_query(&filter.keyword).to_ascii_lowercase();
    let query_key = fingerprint(Json::Arr(vec![Json::str(&keyword), optional(f.from.as_deref()), optional(f.to.as_deref()),
        Json::Bool(f.favorite_only), strings(&f.tag_ids), f.has_photo.map(Json::Bool).unwrap_or(Json::Null),
        Json::str(if f.order == crate::Order::Asc { "asc" } else { "desc" }), Json::str(today)]));
    let bad = || CoreError::new("INVALID_CURSOR", "分页位置无效，请从第一页重新查找");
    let parsed = cursor.as_deref().map(|raw| {
        if raw.len() > 32768 || !flat_array(raw) { return Err(bad()); }
        let v = json::parse(raw).map_err(|_| bad())?;
        let a = v.as_arr().filter(|a| a.len() == 4).ok_or_else(bad)?;
        if a[0].as_str() != Some("sg12") || a.iter().any(|v| v.as_str().is_none()) { return Err(bad()); }
        if a[1].as_str() != Some(&query_key) { return Err(CoreError::new("SEARCH_CURSOR_MISMATCH", "查找条件已改变，请从第一页重新查找")); }
        let generation = a[2].as_str().unwrap().to_owned();
        let inner = a[3].as_str().unwrap().to_owned();
        if !flat_inner(&inner) { return Err(bad()); }
        query::decode(&inner, f.order)?;
        Ok((generation, inner))
    }).transpose()?;
    let source_generation = source_generation(s);
    if parsed.as_ref().is_some_and(|(generation,_)| generation != &source_generation) {
        return Err(CoreError::new("SEARCH_CURSOR_STALE", "正式内容或标签已更新，请从第一页重新查找"));
    }
    let tags: BTreeMap<_,_> = s.tags.iter().map(|t| (t.tag_id.as_str(), t.name.to_ascii_lowercase())).collect();
    let contains = |v: &str| v.to_ascii_lowercase().contains(&keyword);
    let mut seen = BTreeSet::new();
    let rows = query::sorted(s, &f).into_iter().filter(|r| {
        let snap = r.formal.as_ref().expect("formal");
        (keyword.is_empty() || contains(&snap.title) || contains(&snap.body) || contains(&snap.location)
            || snap.photos.iter().any(|p| contains(&p.caption))
            || r.tag_ids.iter().any(|id| tags.get(id.as_str()).is_some_and(|name| name.contains(&keyword))))
            && seen.insert(r.record_id.as_str())
    }).collect();
    let mut page = query::page_rows(rows, f.order, parsed.map(|(_,inner)| inner), limit, today)?;
    page.next_cursor = page.next_cursor.map(|inner| Json::Arr(vec![Json::str("sg12"),Json::str(&query_key),Json::str(&source_generation),Json::str(inner)]).dump());
    Ok(SearchPage { page, query_key, source_generation })
}
impl Store {
    pub fn search_page(&self, filter: &SearchFilter, cursor: Option<String>, limit: usize, today: &str) -> Result<SearchPage, CoreError> {
        search_page(&self.state, filter, cursor, limit, today)
    }
}
