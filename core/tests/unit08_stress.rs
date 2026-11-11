//! Recreate: SHIGUANG_STRESS_SIZE=5000 cargo test --locked -p shiguang_core --test unit08_stress -- --nocapture
mod unit05_support;
mod unit07_support;
use shiguang_core::{json::Json, query::TimelineFilter, Store};
use std::{fs, time::Instant};
use unit07_support::*;

#[test]
fn synthetic_stress_open_query_export_restore() {
    let count = std::env::var("SHIGUANG_STRESS_SIZE")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(200usize);
    assert!((100..=50000).contains(&count));
    let tmp = Temp::new("u08-stress");
    let restore = Temp::new("u08-stress-restore");
    let files = Temp::new("u08-stress-files");
    let mut seed = Store::open(&tmp.0).unwrap();
    let id = draft(&mut seed, "合成照片种子");
    let mut photos = Vec::new();
    for index in 0..32 {
        let source = files.0.join(format!("synthetic-{index}.png"));
        fs::write(
            &source,
            shiguang_core::preview::preview_bytes(&format!("stress-synthetic-{index}")),
        )
        .unwrap();
        photos.push(seed.attach_photo(&id, &source, "合成照片", None).unwrap());
    }
    let mut rows = synthetic_rows(count);
    for (index, row) in rows.iter_mut().enumerate() {
        let mut p = photos[index % photos.len()].clone();
        p.photo_use_id = format!("pu-{:06}", index + 10000);
        row.formal.as_mut().unwrap().photos.push(p);
    }
    let state = with_rows(&seed, &rows);
    let snapshot = state.to_json(seed.seed()).dump();
    drop(seed);
    fs::write(tmp.0.join("state.json"), &snapshot).unwrap();
    let start = Instant::now();
    let s = Store::open(&tmp.0).unwrap();
    let open_ms = start.elapsed().as_secs_f64() * 1000.;
    let filter = TimelineFilter::default();
    let start = Instant::now();
    let first = s.timeline_page(&filter, None, 50, TODAY).unwrap();
    let first_ms = start.elapsed().as_secs_f64() * 1000.;
    let mut cursor = first.next_cursor;
    for _ in 0..((count / 50).min(10) - 2) {
        cursor = s
            .timeline_page(&filter, cursor, 50, TODAY)
            .unwrap()
            .next_cursor;
    }
    let start = Instant::now();
    let later = s.timeline_page(&filter, cursor, 50, TODAY).unwrap();
    let later_ms = start.elapsed().as_secs_f64() * 1000.;
    assert_eq!(later.items.len(), 50);
    let backup = files.0.join("synthetic.sgbak");
    let start = Instant::now();
    s.export_backup(&backup, "0.1.9").unwrap();
    let export_ms = start.elapsed().as_secs_f64() * 1000.;
    let mut target = Store::open_exclusive(&restore.0).unwrap();
    let start = Instant::now();
    target.restore_backup_overwrite(&backup).unwrap();
    let restore_ms = start.elapsed().as_secs_f64() * 1000.;
    assert_eq!(target.list_formal().len(), count);
    assert_eq!(target.all_photos().len(), count);
    let report = Json::obj(vec![
        ("records", Json::Num(count as i64)),
        ("photoUses", Json::Num(count as i64)),
        ("uniqueSyntheticPhotos", Json::Num(32)),
        ("stateBytes", Json::Num(snapshot.len() as i64)),
        (
            "backupBytes",
            Json::Num(fs::metadata(&backup).unwrap().len() as i64),
        ),
        (
            "timingsMs",
            Json::obj(vec![
                ("open", Json::str(format!("{open_ms:.3}"))),
                ("timelineFirst", Json::str(format!("{first_ms:.3}"))),
                ("timelineLater", Json::str(format!("{later_ms:.3}"))),
                ("backupExport", Json::str(format!("{export_ms:.3}"))),
                ("backupRestore", Json::str(format!("{restore_ms:.3}"))),
            ]),
        ),
    ])
    .dump();
    println!("{report}");
    if let Ok(out) = std::env::var("SHIGUANG_STRESS_OUT") {
        fs::write(out, format!("{report}\n")).unwrap();
    }
}
