//! Disposable M04 projections over current formal snapshots. No stories, media,
//! exhibition lists, random state or derived indexes are persisted.
use crate::{
    json::{self, Json}, persist::Durability, query, time, CoreError, Order, RecordRow,
    RecordStatus, State, Store, TimelineFilter, TimelineItem, TimelinePage,
};
use std::{cmp::Ordering, collections::{BTreeMap, BTreeSet}};

pub const PREVIEW_LIMIT: usize = 6;
pub const FEATURED_LIMIT: usize = 6;

#[derive(Clone, Debug)]
pub struct ReunionGroup {
    pub year: i64,
    pub years_ago: i64,
    pub label: String,
    pub items: Vec<TimelineItem>,
}
#[derive(Clone, Debug)]
pub struct ReunionPage {
    pub groups: Vec<ReunionGroup>,
    pub next_cursor: Option<String>,
    pub total: usize,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PhotoTile {
    pub record_id: String,
    pub title: Option<String>,
    pub event_date: String,
    pub event_time: Option<String>,
    pub is_future: bool,
    /// Zero-based position in the formal photo array, independent of cover.
    pub photo_index: usize,
    pub photo_use_id: String,
    pub asset_id: String,
    pub caption: String,
    /// Existing previews/{assetId}.thumb-v2.png cache; never an original copy.
    pub thumbnail_key: String,
}
#[derive(Clone, Debug)]
pub struct PhotoPage {
    pub items: Vec<PhotoTile>,
    pub next_cursor: Option<String>,
    pub total: usize,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MuseumYear {
    pub year: i64,
    pub record_count: usize,
    pub photo_count: usize,
    /// Record counts, January through December, including future entries.
    pub months: [usize; 12],
}
#[derive(Clone, Debug)]
pub struct YearRoom {
    pub summary: Option<MuseumYear>,
    pub page: TimelinePage,
    pub featured: Vec<TimelineItem>,
}
#[derive(Clone, Debug)]
pub struct ShufflePage {
    pub items: Vec<TimelineItem>,
    pub eligible_total: usize,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MuseumSummary {
    pub record_count: usize,
    pub reunion_count: usize,
    pub favorite_count: usize,
    pub photo_count: usize,
    pub year_count: usize,
    pub eligible_count: usize,
    /// Includes trashed rows so the reset action reports every preference.
    pub hidden_count: usize,
}
#[derive(Clone, Debug)]
pub struct MuseumHiddenOutcome {
    pub record_id: String,
    pub museum_hidden: bool,
    pub durability: Durability,
}
#[derive(Clone, Debug)]
pub struct MuseumResetOutcome {
    pub affected_records: usize,
    pub durability: Durability,
}

fn opt(v: Option<&str>) -> Json { v.map(Json::str).unwrap_or(Json::Null) }
fn items(v: &[TimelineItem]) -> Json { Json::Arr(v.iter().map(TimelineItem::to_json).collect()) }
impl ReunionPage {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("groups", Json::Arr(self.groups.iter().map(|g| Json::obj(vec![
                ("year", Json::Num(g.year)), ("yearsAgo", Json::Num(g.years_ago)),
                ("label", Json::str(&g.label)), ("items", items(&g.items)),
            ])).collect())),
            ("nextCursor", opt(self.next_cursor.as_deref())), ("total", Json::Num(self.total as i64)),
        ])
    }
}
impl PhotoTile {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("recordId", Json::str(&self.record_id)), ("title", opt(self.title.as_deref())),
            ("eventDate", Json::str(&self.event_date)), ("eventTime", opt(self.event_time.as_deref())),
            ("isFuture", Json::Bool(self.is_future)), ("photoIndex", Json::Num(self.photo_index as i64)),
            ("photoUseId", Json::str(&self.photo_use_id)), ("assetId", Json::str(&self.asset_id)),
            ("caption", Json::str(&self.caption)), ("thumbnailKey", Json::str(&self.thumbnail_key)),
        ])
    }
}
impl PhotoPage {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("items", Json::Arr(self.items.iter().map(PhotoTile::to_json).collect())),
            ("nextCursor", opt(self.next_cursor.as_deref())), ("total", Json::Num(self.total as i64)),
        ])
    }
}
impl MuseumYear {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("year", Json::Num(self.year)), ("recordCount", Json::Num(self.record_count as i64)),
            ("photoCount", Json::Num(self.photo_count as i64)),
            ("months", Json::Arr(self.months.iter().map(|n| Json::Num(*n as i64)).collect())),
        ])
    }
}
impl YearRoom {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("summary", self.summary.as_ref().map(MuseumYear::to_json).unwrap_or(Json::Null)),
            ("page", self.page.to_json()), ("featured", items(&self.featured)),
        ])
    }
}
impl ShufflePage {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![("items", items(&self.items)), ("eligibleTotal", Json::Num(self.eligible_total as i64))])
    }
}
impl MuseumSummary {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("recordCount", Json::Num(self.record_count as i64)), ("reunionCount", Json::Num(self.reunion_count as i64)),
            ("favoriteCount", Json::Num(self.favorite_count as i64)), ("photoCount", Json::Num(self.photo_count as i64)),
            ("yearCount", Json::Num(self.year_count as i64)), ("eligibleCount", Json::Num(self.eligible_count as i64)),
            ("hiddenCount", Json::Num(self.hidden_count as i64)),
        ])
    }
}
impl MuseumHiddenOutcome {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![("recordId", Json::str(&self.record_id)), ("museumHidden", Json::Bool(self.museum_hidden)),
            ("durability", Json::str(self.durability.as_str()))])
    }
}
impl MuseumResetOutcome {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![("affectedRecords", Json::Num(self.affected_records as i64)),
            ("durability", Json::str(self.durability.as_str()))])
    }
}

fn formal(r: &RecordRow) -> bool { r.status == RecordStatus::Active && r.formal.is_some() }
fn check_dates(s: &State) -> Result<(), CoreError> {
    for r in s.records.iter().filter(|r| formal(r)) {
        query::date(&r.formal.as_ref().unwrap().event_date)?;
    }
    Ok(())
}
fn eligible(r: &RecordRow, today: &str) -> bool {
    formal(r) && !r.museum_hidden && r.formal.as_ref().is_some_and(|f| f.event_date.as_str() <= today)
}
fn reunion_match(r: &RecordRow, md: &str, year: &str) -> bool {
    formal(r) && !r.museum_hidden && r.formal.as_ref().is_some_and(|f|
        &f.event_date[..4] < year && &f.event_date[5..] == md)
}
/// Shared with M03's light on-this-day list. An explicit month/day is retained
/// for the existing API; museum today always derives it from the injected date.
pub(crate) fn reunion_rows<'a>(s: &'a State, month: u32, day: u32, today: &str) -> Result<Vec<&'a RecordRow>, CoreError> {
    query::date(today)?;
    check_dates(s)?;
    if !(1..=12).contains(&month) || day == 0 || day > time::days_in_month(2000, month) {
        return Err(CoreError::new("INVALID_EVENT_DATE", "月日无效，请检查月份和日期"));
    }
    let md = format!("{month:02}-{day:02}");
    let mut rows: Vec<_> = s.records.iter().filter(|r| reunion_match(r, &md, &today[..4])).collect();
    rows.sort_unstable_by(|a,b| query::compare(query::key(a), query::key(b), Order::Desc));
    Ok(rows)
}
pub fn reunion_page(s: &State, cursor: Option<String>, limit: usize, today: &str) -> Result<ReunionPage, CoreError> {
    query::date(today)?;
    let rows = reunion_rows(s, today[5..7].parse().unwrap(), today[8..].parse().unwrap(), today)?;
    let page = query::page_rows(rows, Order::Desc, cursor, limit, today)?;
    let this_year: i64 = today[..4].parse().unwrap();
    let mut groups: Vec<ReunionGroup> = Vec::new();
    for item in page.items {
        let year = item.event_date[..4].parse().unwrap();
        if groups.last().is_none_or(|g| g.year != year) {
            groups.push(ReunionGroup { year, years_ago: this_year-year,
                label: format!("{} 年前的今天", this_year-year), items: Vec::new() });
        }
        groups.last_mut().unwrap().items.push(item);
    }
    Ok(ReunionPage { groups, next_cursor: page.next_cursor, total: page.total })
}
pub fn favorites_page(s: &State, order: Order, cursor: Option<String>, limit: usize, today: &str) -> Result<TimelinePage, CoreError> {
    query::timeline_page(s, &TimelineFilter { favorite_only: true, order, ..Default::default() }, cursor, limit, today)
}

/// Photo key = complete M02 record key followed by formal photo position (always
/// ascending). A removed boundary record still works; refresh after content edits.
pub fn photos_page(s: &State, order: Order, cursor: Option<String>, limit: usize, today: &str) -> Result<PhotoPage, CoreError> {
    query::date(today)?;
    if !(1..=500).contains(&limit) { return Err(CoreError::new("INVALID_LIMIT", "每页条数请设置为 1–500")); }
    let bad = || CoreError::new("INVALID_CURSOR", "分页位置无效，请刷新展墙后重试");
    let c = cursor.map(|raw| {
        if raw.len() > 32768 { return Err(bad()); }
        let v = json::parse(&raw).map_err(|_| bad())?;
        let a = v.as_arr().filter(|a| a.len()==3).ok_or_else(bad)?;
        if a[0].as_str() != Some("sg11-photo") { return Err(bad()); }
        let k = query::decode(a[1].as_str().ok_or_else(bad)?, order)?;
        let i = a[2].as_i64().and_then(|n| usize::try_from(n).ok()).ok_or_else(bad)?;
        Ok((k, i))
    }).transpose()?;
    let rows = query::sorted(s, &TimelineFilter { order, has_photo: Some(true), ..Default::default() });
    let total = rows.iter().map(|r| r.formal.as_ref().unwrap().photos.len()).sum();
    let mut after = rows.iter().flat_map(|r| r.formal.as_ref().unwrap().photos.iter().enumerate().map(move |(i,_)| (*r,i)))
        .filter(|(r,i)| c.as_ref().is_none_or(|(k,n)| query::compare(query::key(r), k.key(), order)
            .then_with(|| i.cmp(n)) == Ordering::Greater));
    let selected: Vec<_> = after.by_ref().take(limit).collect();
    let more = after.next().is_some();
    let next_cursor = if more { selected.last().map(|(r,i)| Json::Arr(vec![
        Json::str("sg11-photo"), Json::str(query::encode(r,order)), Json::Num(*i as i64),
    ]).dump()) } else { None };
    let items = selected.into_iter().map(|(r,i)| {
        let f = r.formal.as_ref().unwrap(); let p = &f.photos[i];
        PhotoTile { record_id:r.record_id.clone(), title:(!f.title.is_empty()).then(|| f.title.clone()),
            event_date:f.event_date.clone(), event_time:f.event_time.clone(), is_future:f.event_date.as_str()>today,
            photo_index:i, photo_use_id:p.photo_use_id.clone(), asset_id:p.asset_id.clone(), caption:p.caption.clone(),
            thumbnail_key:format!("{}.thumb-v2.png",p.asset_id) }
    }).collect();
    Ok(PhotoPage { items, next_cursor, total })
}

fn add_year(y: &mut MuseumYear, r: &RecordRow) {
    let f = r.formal.as_ref().unwrap();
    y.record_count+=1; y.photo_count+=f.photos.len();
    y.months[f.event_date[5..7].parse::<usize>().unwrap()-1]+=1;
}
pub fn years(s: &State) -> Result<Vec<MuseumYear>, CoreError> {
    check_dates(s)?;
    let mut years = BTreeMap::new();
    for r in s.records.iter().filter(|r| formal(r)) {
        let year = r.formal.as_ref().unwrap().event_date[..4].parse().unwrap();
        add_year(years.entry(year).or_insert(MuseumYear { year, record_count:0, photo_count:0, months:[0;12] }), r);
    }
    Ok(years.into_values().rev().collect())
}
pub fn year_room(s: &State, year: i64, order: Order, cursor: Option<String>, limit: usize, today: &str) -> Result<YearRoom, CoreError> {
    query::date(today)?;
    if !(0..=9999).contains(&year) { return Err(CoreError::new("INVALID_EVENT_DATE", "年份无效")); }
    check_dates(s)?;
    let f = TimelineFilter { from:Some(format!("{year:04}-01-01")), to:Some(format!("{year:04}-12-31")), order, ..Default::default() };
    let rows = query::sorted(s, &f);
    let mut summary = MuseumYear { year, record_count:0, photo_count:0, months:[0;12] };
    for r in &rows { add_year(&mut summary,r); }
    let mut picked: Vec<_> = rows.iter().copied().filter(|r| eligible(r,today)).collect();
    let rank = |r: &RecordRow| if r.favorite { 0 } else if !r.formal.as_ref().unwrap().photos.is_empty() { 1 } else { 2 };
    picked.sort_unstable_by(|a,b| rank(a).cmp(&rank(b))
        .then_with(|| query::compare(query::key(a),query::key(b),Order::Desc)));
    let featured = picked.into_iter().take(FEATURED_LIMIT).map(|r| query::item(r,today)).collect();
    Ok(YearRoom { summary:(summary.record_count>0).then_some(summary),
        page:query::page_rows(rows,order,cursor,limit,today)?, featured })
}

/// Canonical ID order + xorshift32 Fisher–Yates, identical to TS. Seed 0 uses
/// 0x6d2b79f5. Unseen IDs are consumed first, then only the unavoidable repeats.
pub fn reshuffle(s: &State, seed: u32, previous_ids: &[String], limit: usize, today: &str) -> Result<ShufflePage, CoreError> {
    query::date(today)?;
    if !(1..=50).contains(&limit) { return Err(CoreError::new("INVALID_LIMIT", "每次请查看 1–50 条")); }
    let mut rows: Vec<_> = s.records.iter().filter(|r| eligible(r,today)).collect();
    rows.sort_unstable_by(|a,b| a.record_id.cmp(&b.record_id));
    let eligible_total = rows.len();
    let mut rng = if seed==0 { 0x6d2b79f5 } else { seed };
    for i in (1..rows.len()).rev() {
        rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
        rows.swap(i, rng as usize % (i+1));
    }
    let previous: BTreeSet<_> = previous_ids.iter().map(String::as_str).collect();
    let (mut unseen, repeated): (Vec<_>,Vec<_>) = rows.into_iter().partition(|r| !previous.contains(r.record_id.as_str()));
    unseen.extend(repeated);
    Ok(ShufflePage { items:unseen.into_iter().take(limit).map(|r| query::item(r,today)).collect(), eligible_total })
}
/// One scan, no sort, card/text cloning, filesystem work or preview decoding.
pub fn home_summary(s: &State, today: &str) -> Result<MuseumSummary, CoreError> {
    query::date(today)?;
    let mut out = MuseumSummary::default(); let mut years = BTreeSet::new();
    for r in &s.records {
        out.hidden_count+=usize::from(r.museum_hidden);
        if !formal(r) { continue; }
        let f = r.formal.as_ref().unwrap();
        query::date(&f.event_date)?;
        out.record_count+=1; out.favorite_count+=usize::from(r.favorite); out.photo_count+=f.photos.len();
        years.insert(&f.event_date[..4]);
        out.reunion_count+=usize::from(reunion_match(r,&today[5..],&today[..4]));
        out.eligible_count+=usize::from(eligible(r,today));
    }
    out.year_count=years.len(); Ok(out)
}

impl Store {
    pub fn museum_reunion_preview(&self, today: &str) -> Result<ReunionPage,CoreError> { reunion_page(&self.state,None,PREVIEW_LIMIT,today) }
    pub fn museum_reunion_page(&self, cursor:Option<String>, limit:usize, today:&str) -> Result<ReunionPage,CoreError> { reunion_page(&self.state,cursor,limit,today) }
    pub fn museum_favorites_page(&self, order:Order, cursor:Option<String>, limit:usize, today:&str) -> Result<TimelinePage,CoreError> { favorites_page(&self.state,order,cursor,limit,today) }
    pub fn museum_photos_page(&self, order:Order, cursor:Option<String>, limit:usize, today:&str) -> Result<PhotoPage,CoreError> { photos_page(&self.state,order,cursor,limit,today) }
    pub fn museum_years(&self) -> Result<Vec<MuseumYear>,CoreError> { years(&self.state) }
    pub fn museum_year_room(&self, year:i64, order:Order, cursor:Option<String>, limit:usize, today:&str) -> Result<YearRoom,CoreError> { year_room(&self.state,year,order,cursor,limit,today) }
    pub fn museum_reshuffle(&self, seed:u32, previous_ids:&[String], limit:usize, today:&str) -> Result<ShufflePage,CoreError> { reshuffle(&self.state,seed,previous_ids,limit,today) }
    pub fn museum_home_summary(&self, today:&str) -> Result<MuseumSummary,CoreError> { home_summary(&self.state,today) }
    pub fn set_museum_hidden(&mut self, id:&str, hidden:bool) -> Result<MuseumHiddenOutcome,CoreError> {
        let (record_id,durability)=self.meta_transact(|s| {
            let r=s.row_mut(id)?;
            if r.formal.is_none() { return Err(CoreError::new("RECORD_NOT_FORMAL","草稿尚未正式保存")); }
            r.museum_hidden=hidden; Ok(r.record_id.clone())
        })?;
        Ok(MuseumHiddenOutcome {record_id,museum_hidden:hidden,durability})
    }
    /// 恢复所有暂时不看, including preferences retained in trash. Content,
    /// status and deletion markers are untouched; purged IDs are never recreated.
    pub fn reset_museum_hidden(&mut self) -> Result<MuseumResetOutcome,CoreError> {
        let (affected_records,durability)=self.meta_transact(|s| {
            let mut count=0;
            for r in &mut s.records { if r.museum_hidden {r.museum_hidden=false; count+=1;} }
            Ok(count)
        })?;
        Ok(MuseumResetOutcome {affected_records,durability})
    }
}
