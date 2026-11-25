//! One-time native writer for the v5 compatibility oracle. See V5_ORACLE.md.
use shiguang_core::{ConflictChoice, DraftPatch, KdfParams, Mood, Store, ThemePreference};
use std::{env, fs, path::PathBuf};

fn main() {
    let [work, tea, window]: [PathBuf; 3] = env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .collect::<Vec<_>>()
        .try_into()
        .expect("expected NEW_DIRECTORY TEA.png WINDOW.png");
    assert_eq!(shiguang_core::CURRENT_SCHEMA_VERSION, 5);
    fs::create_dir(&work).expect("use a fresh output directory");
    env::set_var("SHIGUANG_SEED", "synthetic-v5-oracle");
    env::set_var("SHIGUANG_CLOCK", "2026-11-24T09:30:00Z");
    let mut store = Store::open_exclusive(work.join("source")).unwrap();
    store.set_theme(ThemePreference::Dark).unwrap();
    let tag = store.create_tag("合成·样片").unwrap();
    let primary = store
        .create_draft_with_fields(
            None,
            &DraftPatch {
                title: Some("合成展台".into()),
                body: Some(" \t合成正文 e\u{301} 🪁\r\n第二行\u{3000} ".into()),
                event_date: Some("2024-02-29".into()),
                event_time: Some(Some("07:05".into())),
                location: Some("合成展厅".into()),
                mood: Some(Some(Mood::Calm)),
            },
        )
        .unwrap()
        .record_id;
    let a = store
        .attach_photo(&primary, &tea, "茶色条纹", None)
        .unwrap();
    let b = store
        .attach_photo(&primary, &window, "窗边\n第二张是封面", None)
        .unwrap();
    store.set_draft_cover(&primary, &b.photo_use_id).unwrap();
    store.commit(&primary, 0).unwrap();
    store.set_favorite(&primary, true, Some(0)).unwrap();
    store
        .set_record_tags(&primary, &[tag.tag_id], Some(0))
        .unwrap();
    store
        .save_draft_patch(
            &primary,
            &DraftPatch {
                body: Some("  草稿 👩‍🚀\r\n未发布 e\u{301}\t ".into()),
                location: Some("合成走廊".into()),
                mood: Some(Some(Mood::Moved)),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .set_draft_photo_caption(&primary, &a.photo_use_id, "仅在草稿中的茶")
        .unwrap();
    store.set_draft_cover(&primary, &a.photo_use_id).unwrap();
    store
        .reorder_draft_photos(&primary, &[b.photo_use_id, a.photo_use_id])
        .unwrap();

    let shared = store
        .create_draft(None, "合成共享", "另一条正式正文", "2024-03-01", None)
        .unwrap()
        .record_id;
    let shared_use = store
        .attach_photo(&shared, &tea, "另一条记录的茶", None)
        .unwrap();
    store.commit(&shared, 0).unwrap();
    store.set_museum_hidden(&shared, true).unwrap();
    store
        .save_draft(&shared, None, Some("可恢复的合成副本"), None, None)
        .unwrap();
    store
        .set_draft_photo_caption(&shared, &shared_use.photo_use_id, "副本中的茶")
        .unwrap();
    store
        .resolve_conflict(&shared, ConflictChoice::KeepFormal)
        .unwrap();

    let trash = store
        .create_draft(None, "合成回收", "", "2024-03-02", None)
        .unwrap()
        .record_id;
    store
        .attach_photo(&trash, &window, "回收站中的窗", None)
        .unwrap();
    store.commit(&trash, 0).unwrap();
    store.trash_record(&trash).unwrap();

    let out = work.join("v5");
    fs::create_dir_all(out.join("media")).unwrap();
    fs::copy(store.root().join("state.json"), out.join("state.json")).unwrap();
    for entry in fs::read_dir(store.root().join("media")).unwrap() {
        let entry = entry.unwrap();
        fs::copy(entry.path(), out.join("media").join(entry.file_name())).unwrap();
    }
    store
        .export_backup(&out.join("plain.sgbak"), "0.1.12")
        .unwrap();
    store
        .export_backup_encrypted(
            &out.join("encrypted.sgbak"),
            "0.1.12",
            "synthetic-fixture-pass",
            KdfParams::default(),
        )
        .unwrap();
}
