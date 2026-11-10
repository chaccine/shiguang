#![allow(dead_code)]
pub use super::unit05_support::*;
use shiguang_core::{json::Json, RecordRow, Snapshot, State, Store};
pub const TODAY: &str = "2026-11-10";
pub fn formal(s: &mut Store) -> String {
    let id = draft(s, "合成正文");
    s.commit(&id, 0).unwrap();
    id
}
pub fn state(s: &Store) -> State {
    State::from_json(&s.state_json()).unwrap()
}
pub fn rows(v: &Json) -> &[Json] {
    v.get("records").unwrap().as_arr().unwrap()
}
pub fn edit_row(v: &mut Json, index: usize, f: impl FnOnce(&mut Json)) {
    let mut r = rows(v).to_vec();
    f(&mut r[index]);
    set(v, "records", Json::Arr(r));
}
pub fn downgrade(mut v: Json, version: i64) -> Json {
    if let Json::Obj(f) = &mut v {
        f.retain(|(k, _)| {
            !["tags", "tagDictRevision", "tagAliases", "tagTombstones"].contains(&k.as_str())
        });
    }
    let mut r = rows(&v).to_vec();
    for row in &mut r {
        if let Json::Obj(f) = row {
            f.retain(|(k, _)| {
                !["favorite", "favoriteRevision", "tagIds", "tagRevision"].contains(&k.as_str())
            });
        }
    }
    set(&mut v, "records", Json::Arr(r));
    set(&mut v, "schemaVersion", Json::Num(version));
    v
}
pub fn synthetic_rows(n: usize) -> Vec<RecordRow> {
    (1..=n)
        .map(|i| RecordRow {
            record_id: format!("rec-{i:06}"),
            created_at: format!("2020-01-01T00:{:02}:{:02}Z", i / 60 % 60, i % 60),
            content_revision: 1,
            formal: Some(Snapshot {
                title: format!("合成{i}"),
                body: "合成\n正文".repeat(50),
                event_date: format!("{:04}-{:02}-{:02}", 2000 + i % 30, 1 + i % 12, 1 + i % 28),
                event_time: (i % 3 != 0).then(|| format!("{:02}:{:02}", i % 24, i % 60)),
                ..Default::default()
            }),
            ..Default::default()
        })
        .collect()
}
pub fn with_rows(s: &Store, r: &[RecordRow]) -> State {
    let mut v = s.state_json();
    set(&mut v, "seq", Json::Num(100000));
    set(
        &mut v,
        "records",
        Json::Arr(r.iter().map(RecordRow::to_json).collect()),
    );
    State::from_json(&v).unwrap()
}
