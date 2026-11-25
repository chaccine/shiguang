//! Read-only calendar projections. All dates, including today, are supplied by callers.
use crate::{
    json::{self, Json},
    time, CoreError, PhotoUse, RecordRow, RecordStatus, State, Store,
};
use std::{cmp::Ordering, collections::BTreeMap};
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Order {
    #[default]
    Desc,
    Asc,
}
#[derive(Clone, Debug, Default)]
pub struct TimelineFilter {
    pub from: Option<String>,
    pub to: Option<String>,
    pub favorite_only: bool,
    pub tag_ids: Vec<String>,
    pub has_photo: Option<bool>,
    pub order: Order,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelineItem {
    pub record_id: String,
    pub event_date: String,
    pub event_time: Option<String>,
    pub title: String,
    pub excerpt: String,
    pub cover: Option<PhotoUse>,
    pub location: String,
    pub mood: Option<crate::Mood>,
    pub photo_count: usize,
    pub favorite: bool,
    pub favorite_revision: u32,
    pub tag_ids: Vec<String>,
    pub tag_revision: u32,
    pub created_at: String,
    pub is_future: bool,
}
#[derive(Clone, Debug)]
pub struct TimelinePage {
    pub items: Vec<TimelineItem>,
    pub next_cursor: Option<String>,
    pub total: usize,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelineMonth {
    pub year: i64,
    pub month: u32,
    pub count: usize,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CalendarDay {
    pub date: String,
    pub count: usize,
    pub photo_count: usize,
    pub has_favorite: bool,
}
#[derive(Clone, Debug)]
pub struct OnThisDayYear {
    pub year: i64,
    pub items: Vec<TimelineItem>,
}
fn opt(v: &Option<String>) -> Json {
    v.as_ref().map(Json::str).unwrap_or(Json::Null)
}
impl TimelineItem {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("recordId", Json::str(&self.record_id)),
            ("eventDate", Json::str(&self.event_date)),
            ("eventTime", opt(&self.event_time)),
            ("title", Json::str(&self.title)),
            ("excerpt", Json::str(&self.excerpt)),
            (
                "cover",
                self.cover
                    .as_ref()
                    .map(PhotoUse::to_json)
                    .unwrap_or(Json::Null),
            ),
            ("photoCount", Json::Num(self.photo_count as i64)),
            ("location", Json::str(&self.location)),
            (
                "mood",
                self.mood
                    .map(|m| Json::str(m.as_str()))
                    .unwrap_or(Json::Null),
            ),
            ("favorite", Json::Bool(self.favorite)),
            ("favoriteRevision", Json::Num(self.favorite_revision as i64)),
            (
                "tagIds",
                Json::Arr(self.tag_ids.iter().map(Json::str).collect()),
            ),
            ("tagRevision", Json::Num(self.tag_revision as i64)),
            ("createdAt", Json::str(&self.created_at)),
            ("isFuture", Json::Bool(self.is_future)),
        ])
    }
}
impl TimelinePage {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            (
                "items",
                Json::Arr(self.items.iter().map(TimelineItem::to_json).collect()),
            ),
            ("nextCursor", opt(&self.next_cursor)),
            ("total", Json::Num(self.total as i64)),
        ])
    }
}
impl TimelineMonth {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("year", Json::Num(self.year)),
            ("month", Json::Num(self.month as i64)),
            ("count", Json::Num(self.count as i64)),
        ])
    }
}
impl CalendarDay {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("date", Json::str(&self.date)),
            ("count", Json::Num(self.count as i64)),
            ("photoCount", Json::Num(self.photo_count as i64)),
            ("hasFavorite", Json::Bool(self.has_favorite)),
        ])
    }
}
impl OnThisDayYear {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("year", Json::Num(self.year)),
            (
                "items",
                Json::Arr(self.items.iter().map(TimelineItem::to_json).collect()),
            ),
        ])
    }
}
pub(crate) fn date(v: &str) -> Result<(), CoreError> {
    if !time::is_valid_date(v) {
        Err(CoreError::new(
            "INVALID_EVENT_DATE",
            "日期无效，请使用真实的 YYYY-MM-DD 日期",
        ))
    } else {
        Ok(())
    }
}
fn validate_filter(f: &TimelineFilter) -> Result<(), CoreError> {
    for d in [&f.from, &f.to].into_iter().flatten() {
        date(d)?;
    }
    if f.from
        .as_ref()
        .zip(f.to.as_ref())
        .is_some_and(|(a, b)| a > b)
    {
        return Err(CoreError::new(
            "INVALID_EVENT_DATE",
            "开始日期不能晚于结束日期",
        ));
    }
    Ok(())
}
fn matches(r: &RecordRow, f: &TimelineFilter) -> bool {
    let Some(s) = &r.formal else {
        return false;
    };
    r.status == RecordStatus::Active
        && f.from.as_ref().is_none_or(|d| s.event_date >= *d)
        && f.to.as_ref().is_none_or(|d| s.event_date <= *d)
        && (!f.favorite_only || r.favorite)
        && (f.tag_ids.is_empty() || f.tag_ids.iter().any(|t| r.tag_ids.contains(t)))
        && f.has_photo.is_none_or(|p| p != s.photos.is_empty())
}
pub(crate) type Key<'a> = (&'a str, Option<&'a str>, &'a str, &'a str);
pub(crate) fn key(r: &RecordRow) -> Key<'_> {
    let s = r.formal.as_ref().expect("filtered formal");
    (
        &s.event_date,
        s.event_time.as_deref(),
        &r.created_at,
        &r.record_id,
    )
}
pub(crate) fn compare(a: Key<'_>, b: Key<'_>, order: Order) -> Ordering {
    let direction = |c: Ordering| if order == Order::Asc { c } else { c.reverse() };
    direction(a.0.cmp(b.0))
        .then_with(|| b.1.is_some().cmp(&a.1.is_some()))
        .then_with(|| direction(a.1.cmp(&b.1)))
        .then_with(|| direction(a.2.cmp(b.2)))
        .then_with(|| direction(a.3.cmp(b.3)))
}
pub(crate) fn sorted<'a>(s: &'a State, f: &TimelineFilter) -> Vec<&'a RecordRow> {
    let mut rows: Vec<_> = s.records.iter().filter(|r| matches(r, f)).collect();
    rows.sort_unstable_by(|a, b| compare(key(a), key(b), f.order));
    rows
}
pub(crate) fn item(r: &RecordRow, today: &str) -> TimelineItem {
    let s = r.formal.as_ref().expect("filtered formal");
    TimelineItem {
        record_id: r.record_id.clone(),
        event_date: s.event_date.clone(),
        event_time: s.event_time.clone(),
        title: s.title.clone(),
        excerpt: s
            .body
            .chars()
            .take(80)
            .filter(|c| !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
            .collect(),
        cover: s.cover().cloned(),
        location: s.location.clone(),
        mood: s.mood,
        photo_count: s.photos.len(),
        favorite: r.favorite,
        favorite_revision: r.favorite_revision,
        tag_ids: r.tag_ids.clone(),
        tag_revision: r.tag_revision,
        created_at: r.created_at.clone(),
        is_future: s.event_date.as_str() > today,
    }
}
pub(crate) fn encode(r: &RecordRow, order: Order) -> String {
    let k = key(r);
    crate::sha256::hex(
        Json::Arr(vec![
            Json::str("sg7"),
            Json::str(k.0),
            k.1.map(Json::str).unwrap_or(Json::Null),
            Json::str(k.2),
            Json::str(k.3),
            Json::str(if order == Order::Asc { "asc" } else { "desc" }),
        ])
        .dump()
        .as_bytes(),
    )
}
pub(crate) struct Cursor {
    date: String,
    time: Option<String>,
    created: String,
    id: String,
}
impl Cursor {
    pub(crate) fn key(&self) -> Key<'_> {
        (&self.date, self.time.as_deref(), &self.created, &self.id)
    }
}
pub(crate) fn decode(raw: &str, order: Order) -> Result<Cursor, CoreError> {
    let bad = || CoreError::new("INVALID_CURSOR", "分页位置无效，请刷新列表后重试");
    if raw.len() > 16384
        || !raw.len().is_multiple_of(2)
        || !raw.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(bad());
    }
    let bytes = (0..raw.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).map_err(|_| bad()))
        .collect::<Result<Vec<_>, _>>()?;
    let v = json::parse(std::str::from_utf8(&bytes).map_err(|_| bad())?).map_err(|_| bad())?;
    let a = v.as_arr().filter(|a| a.len() == 6).ok_or_else(bad)?;
    let field = |i: usize| a[i].as_str().map(str::to_owned).ok_or_else(bad);
    if field(0)? != "sg7" || field(5)? != if order == Order::Asc { "asc" } else { "desc" } {
        return Err(bad());
    }
    let c = Cursor {
        date: field(1)?,
        time: match &a[2] {
            Json::Null => None,
            Json::Str(v) if time::is_valid_time(v) => Some(v.clone()),
            _ => return Err(bad()),
        },
        created: field(3)?,
        id: field(4)?,
    };
    if !time::is_valid_date(&c.date) || c.id.is_empty() {
        return Err(bad());
    }
    Ok(c)
}
/// Keyset pagination compares the complete B02 key, even if the cursor's record was deleted.
pub fn timeline_page(
    s: &State,
    f: &TimelineFilter,
    cursor: Option<String>,
    limit: usize,
    today: &str,
) -> Result<TimelinePage, CoreError> {
    validate_filter(f)?;
    page_rows(sorted(s, f), f.order, cursor, limit, today)
}

/// Reuses the complete M02 key without cloning State or materializing all cards.
pub(crate) fn page_rows(
    rows: Vec<&RecordRow>,
    order: Order,
    cursor: Option<String>,
    limit: usize,
    today: &str,
) -> Result<TimelinePage, CoreError> {
    date(today)?;
    if !(1..=500).contains(&limit) {
        return Err(CoreError::new("INVALID_LIMIT", "每页条数请设置为 1–500"));
    }
    let c = cursor.as_deref().map(|c| decode(c, order)).transpose()?;
    let total = rows.len();
    let mut remaining = rows.into_iter().filter(|r| {
        c.as_ref()
            .is_none_or(|c| compare(key(r), c.key(), order) == Ordering::Greater)
    });
    let selected: Vec<_> = remaining.by_ref().take(limit).collect();
    let more = remaining.next().is_some();
    let next_cursor = if more {
        selected.last().map(|r| encode(r, order))
    } else {
        None
    };
    Ok(TimelinePage {
        items: selected.into_iter().map(|r| item(r, today)).collect(),
        next_cursor,
        total,
    })
}
pub fn timeline_months(s: &State, f: &TimelineFilter) -> Result<Vec<TimelineMonth>, CoreError> {
    validate_filter(f)?;
    let mut months = BTreeMap::<(i64, u32), usize>::new();
    for r in s.records.iter().filter(|r| matches(r, f)) {
        let d = &r.formal.as_ref().expect("formal").event_date;
        date(d)?;
        *months
            .entry((
                d[..4].parse().expect("date year"),
                d[5..7].parse().expect("date month"),
            ))
            .or_default() += 1;
    }
    let mut v: Vec<_> = months
        .into_iter()
        .map(|((year, month), count)| TimelineMonth { year, month, count })
        .collect();
    if f.order == Order::Desc {
        v.reverse();
    }
    Ok(v)
}
pub fn calendar_month(
    s: &State,
    year: i64,
    month: u32,
    filter: Option<&TimelineFilter>,
) -> Result<Vec<CalendarDay>, CoreError> {
    if !(0..=9999).contains(&year) || !(1..=12).contains(&month) {
        return Err(CoreError::new(
            "INVALID_EVENT_DATE",
            "年月无效，请检查年份和月份",
        ));
    }
    let default = TimelineFilter::default();
    let f = filter.unwrap_or(&default);
    validate_filter(f)?;
    let prefix = format!("{year:04}-{month:02}-");
    let mut days = BTreeMap::<String, CalendarDay>::new();
    for r in s.records.iter().filter(|r| matches(r, f)) {
        let snap = r.formal.as_ref().expect("formal");
        if snap.event_date.starts_with(&prefix) {
            let d = days
                .entry(snap.event_date.clone())
                .or_insert_with(|| CalendarDay {
                    date: snap.event_date.clone(),
                    count: 0,
                    photo_count: 0,
                    has_favorite: false,
                });
            d.count += 1;
            d.photo_count += snap.photos.len();
            d.has_favorite |= r.favorite;
        }
    }
    Ok(days.into_values().collect())
}
pub fn day_entries(
    s: &State,
    day: &str,
    order: Order,
    today: &str,
) -> Result<Vec<TimelineItem>, CoreError> {
    date(day)?;
    date(today)?;
    let f = TimelineFilter {
        from: Some(day.into()),
        to: Some(day.into()),
        order,
        ..Default::default()
    };
    Ok(sorted(s, &f).into_iter().map(|r| item(r, today)).collect())
}
/// Leap day matches February 29 exactly; it never shifts to February 28.
pub fn on_this_day(
    s: &State,
    month: u32,
    day: u32,
    today: &str,
) -> Result<Vec<OnThisDayYear>, CoreError> {
    let mut years = BTreeMap::<i64, Vec<TimelineItem>>::new();
    for r in crate::museum::reunion_rows(s, month, day, today)? {
        let d = &r.formal.as_ref().expect("formal").event_date;
        let y = d[..4].parse().expect("validated year");
        years.entry(y).or_default().push(item(r, today));
    }
    Ok(years
        .into_iter()
        .rev()
        .map(|(year, items)| OnThisDayYear { year, items })
        .collect())
}
impl Store {
    pub fn timeline_page(
        &self,
        f: &TimelineFilter,
        c: Option<String>,
        limit: usize,
        today: &str,
    ) -> Result<TimelinePage, CoreError> {
        timeline_page(&self.state, f, c, limit, today)
    }
    pub fn timeline_months(&self, f: &TimelineFilter) -> Result<Vec<TimelineMonth>, CoreError> {
        timeline_months(&self.state, f)
    }
    pub fn calendar_month(
        &self,
        year: i64,
        month: u32,
        f: Option<&TimelineFilter>,
    ) -> Result<Vec<CalendarDay>, CoreError> {
        calendar_month(&self.state, year, month, f)
    }
    pub fn day_entries(
        &self,
        date: &str,
        order: Order,
        today: &str,
    ) -> Result<Vec<TimelineItem>, CoreError> {
        day_entries(&self.state, date, order, today)
    }
    pub fn on_this_day(
        &self,
        month: u32,
        day: u32,
        today: &str,
    ) -> Result<Vec<OnThisDayYear>, CoreError> {
        on_this_day(&self.state, month, day, today)
    }
}
