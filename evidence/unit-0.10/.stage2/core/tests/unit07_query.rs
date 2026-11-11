mod unit05_support;
mod unit07_support;
use shiguang_core::{query::*, PhotoUse, RecordStatus, Store};
use std::{collections::BTreeSet, time::Instant};
use unit07_support::*;
fn ids(items: &[TimelineItem]) -> Vec<String> {
    items.iter().map(|i| i.record_id.clone()).collect()
}
#[test]
fn b02_all_ties_time_groups_and_directions() {
    let t = Temp::new("u07-order");
    let s = Store::open(&t.0).unwrap();
    let mut r = synthetic_rows(7);
    for row in &mut r {
        let f = row.formal.as_mut().unwrap();
        f.event_date = "2026-11-09".into();
        f.event_time = None;
        row.created_at = "same".into();
    }
    r[0].formal.as_mut().unwrap().event_date = "2026-11-08".into();
    r[1].formal.as_mut().unwrap().event_date = "2026-11-11".into();
    for (i, time) in [(2, "09:00"), (3, "10:00"), (4, "10:00")] {
        r[i].formal.as_mut().unwrap().event_time = Some(time.into());
    }
    r[3].created_at = "early".into();
    let state = with_rows(&s, &r);
    for (order, want) in [
        (Order::Desc, vec![2, 5, 4, 3, 7, 6, 1]),
        (Order::Asc, vec![1, 3, 4, 5, 6, 7, 2]),
    ] {
        let page = timeline_page(
            &state,
            &TimelineFilter {
                order,
                ..Default::default()
            },
            None,
            500,
            TODAY,
        )
        .unwrap();
        assert_eq!(
            ids(&page.items),
            want.into_iter()
                .map(|n| format!("rec-{n:06}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(page.items.iter().filter(|i| i.is_future).count(), 1);
        let expected: String = "合成\n正文"
            .repeat(50)
            .chars()
            .take(80)
            .filter(|c| *c != '\n')
            .collect();
        assert_eq!(page.items[0].excerpt, expected);
        assert!(!page.items[0].excerpt.contains('\n'));
    }
}
#[test]
fn paging_3000_is_complete_fast_and_insertions_do_not_repeat() {
    let t = Temp::new("u07-pages");
    let s = Store::open(&t.0).unwrap();
    let r = synthetic_rows(3000);
    let state = with_rows(&s, &r);
    let start = Instant::now();
    for order in [Order::Asc, Order::Desc] {
        let f = TimelineFilter {
            order,
            ..Default::default()
        };
        let expected = dayless_all(&state, &f);
        let mut got = Vec::new();
        let mut cursor = None;
        loop {
            let p = timeline_page(&state, &f, cursor, 50, TODAY).unwrap();
            assert_eq!(p.total, 3000);
            got.extend(ids(&p.items));
            cursor = p.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(got, expected);
        assert_eq!(got.iter().collect::<BTreeSet<_>>().len(), 3000);
        let first = timeline_page(&state, &f, None, 50, TODAY).unwrap();
        let seen = ids(&first.items);
        let mut more = r.clone();
        let mut new = more
            .iter()
            .find(|row| row.record_id == seen[0])
            .unwrap()
            .clone();
        // Insert before the cursor; offset pagination would repeat a boundary item.
        new.created_at = if order == Order::Asc { "0000" } else { "zzzz" }.into();
        new.record_id = "rec-009999".into();
        more.push(new);
        // A cursor remains valid after the last returned record itself disappears.
        more.retain(|row| Some(&row.record_id) != seen.last());
        let changed = with_rows(&s, &more);
        let next = timeline_page(&changed, &f, first.next_cursor, 500, TODAY).unwrap();
        assert!(ids(&next.items).iter().all(|id| !seen.contains(id)));
        assert_eq!(ids(&next.items), expected[50..550]);
    }
    assert!(
        start.elapsed().as_secs() < 5,
        "debug paging should finish in a few seconds"
    );
    for limit in [0, 501] {
        assert!(timeline_page(&state, &TimelineFilter::default(), None, limit, TODAY).is_err());
    }
    assert!(timeline_page(
        &state,
        &TimelineFilter::default(),
        Some("bad".into()),
        50,
        TODAY
    )
    .is_err());
}
fn dayless_all(s: &shiguang_core::State, f: &TimelineFilter) -> Vec<String> {
    // Independent full-list path; never relies on cursor pagination.
    let months = timeline_months(s, f).unwrap();
    let mut all = Vec::new();
    for m in months {
        let days = calendar_month(s, m.year, m.month, Some(f)).unwrap();
        let mut days = days;
        if f.order == Order::Desc {
            days.reverse();
        }
        for d in days {
            all.extend(ids(&day_entries(s, &d.date, f.order, TODAY).unwrap()));
        }
    }
    all
}
#[test]
fn filters_formal_projection_calendar_and_date_move() {
    let t = Temp::new("u07-filter");
    let mut s = Store::open(&t.0).unwrap();
    let a = s.create_tag("A").unwrap();
    let b = s.create_tag("B").unwrap();
    let mut r = synthetic_rows(6);
    for row in &mut r {
        row.formal.as_mut().unwrap().event_date = "2026-11-09".into();
        row.favorite = true;
        row.tag_ids = vec![a.tag_id.clone()];
    }
    r[1].tag_ids = vec![b.tag_id.clone()];
    r[2].favorite = false;
    r[3].status = RecordStatus::Trashed;
    r[3].trashed_at = Some("synthetic".into());
    r[4].formal = None;
    r[5].formal.as_mut().unwrap().event_date = "9999-12-31".into();
    r[0].formal.as_mut().unwrap().photos = vec![PhotoUse {
        photo_use_id: "pu-009999".into(),
        asset_id: "ast-synthetic".into(),
        sha256: "0".repeat(64),
        ..Default::default()
    }];
    r[0].formal.as_mut().unwrap().cover_photo_use_id = Some("pu-009999".into());
    r[0].draft = Some(shiguang_core::Snapshot {
        title: "草稿不可见".into(),
        ..Default::default()
    });
    let state = with_rows(&s, &r);
    let f = TimelineFilter {
        favorite_only: true,
        tag_ids: vec![a.tag_id, b.tag_id],
        from: Some("2026-11-09".into()),
        to: Some("2026-11-09".into()),
        has_photo: Some(true),
        ..Default::default()
    };
    let p = timeline_page(&state, &f, None, 50, TODAY).unwrap();
    assert_eq!(p.total, 1);
    assert_eq!(p.items[0].title, "合成1");
    assert_eq!(p.items[0].photo_count, 1);
    assert!(p.items[0].cover.is_some());
    let mut f = f;
    f.has_photo = None;
    assert_eq!(timeline_page(&state, &f, None, 50, TODAY).unwrap().total, 2);
    let days = calendar_month(&state, 2026, 11, None).unwrap();
    assert_eq!(days[0].count, 3);
    assert_eq!(days[0].photo_count, 1);
    assert!(days[0].has_favorite);
    assert_eq!(
        day_entries(&state, "2026-11-09", Order::Desc, TODAY)
            .unwrap()
            .len(),
        3
    );
    assert!(calendar_month(&state, 1900, 1, None).unwrap().is_empty());
    assert_eq!(calendar_month(&state, 9999, 12, None).unwrap()[0].count, 1);
    assert!(calendar_month(&state, 2026, 13, None).is_err());
    for date in ["bad", "2026-02-29"] {
        assert!(day_entries(&state, date, Order::Desc, TODAY).is_err());
    }
    let id = formal(&mut s);
    s.save_draft(&id, None, None, Some("2027-01-01"), None)
        .unwrap();
    assert_eq!(
        s.day_entries("2026-11-09", Order::Desc, TODAY)
            .unwrap()
            .len(),
        1
    );
    s.commit(&id, 1).unwrap();
    assert!(s
        .day_entries("2026-11-09", Order::Desc, TODAY)
        .unwrap()
        .is_empty());
    assert_eq!(s.calendar_month(2027, 1, None).unwrap()[0].count, 1);
}
#[test]
fn on_this_day_past_only_and_leap_day_exact() {
    let t = Temp::new("u07-anniversary");
    let s = Store::open(&t.0).unwrap();
    let mut r = synthetic_rows(5);
    for (row, date) in r.iter_mut().zip([
        "2020-02-29",
        "2024-02-29",
        "2024-02-28",
        "2028-02-29",
        "2032-02-29",
    ]) {
        row.formal.as_mut().unwrap().event_date = date.into();
    }
    let state = with_rows(&s, &r);
    let years = on_this_day(&state, 2, 29, "2028-02-29").unwrap();
    assert_eq!(
        years.iter().map(|y| y.year).collect::<Vec<_>>(),
        vec![2024, 2020]
    );
    assert_eq!(years[0].items.len(), 1);
    assert!(on_this_day(&state, 2, 30, TODAY).is_err());
}
#[test]
fn entire_day_is_unbounded_queries_are_read_only_and_false_photo_filter() {
    let t = Temp::new("u07-day-all");
    let mut s = Store::open(&t.0).unwrap();
    formal(&mut s);
    let disk = tree(&t.0);
    let memory = s.state_json();
    let mut rows = synthetic_rows(700);
    for r in &mut rows {
        r.formal.as_mut().unwrap().event_date = "2026-11-09".into();
    }
    let state = with_rows(&s, &rows);
    assert_eq!(
        day_entries(&state, "2026-11-09", Order::Desc, TODAY)
            .unwrap()
            .len(),
        700
    );
    let f = TimelineFilter {
        has_photo: Some(false),
        ..Default::default()
    };
    assert_eq!(
        timeline_page(&state, &f, None, 500, TODAY).unwrap().total,
        700
    );
    s.timeline_page(&f, None, 10, TODAY).unwrap();
    s.timeline_months(&f).unwrap();
    s.calendar_month(2026, 11, Some(&f)).unwrap();
    s.day_entries("2026-11-09", Order::Asc, TODAY).unwrap();
    s.on_this_day(11, 9, TODAY).unwrap();
    assert_eq!(s.state_json(), memory);
    assert_eq!(tree(&t.0), disk);
}
