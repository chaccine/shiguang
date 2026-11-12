#![cfg(feature = "fault-injection")]
mod unit05_support;
use shiguang_core::{
    fault::{self, FaultPoint},
    Store,
};
use std::{fs, path::Path};
use unit05_support::*;

#[test]
fn v3_migration_interrupted_at_each_safe_write_stage_leaves_original_reopenable() {
    let old = fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/v3/state.json"))
        .unwrap();
    for (point, visit) in [
        (FaultPoint::MigrationBackup, 1),
        (FaultPoint::MigrationWrite, 1),
        (FaultPoint::TempCreate, 2),
        (FaultPoint::TempWrite, 2),
        (FaultPoint::TempSync, 2),
        (FaultPoint::Replace, 2),
    ] {
        let t = Temp::new("u010-migration-fault");
        fs::write(t.0.join("state.json"), &old).unwrap();
        fault::set_after(point, visit);
        assert!(Store::open(&t.0).is_err(), "{point:?}");
        fault::clear();
        assert_eq!(fs::read(t.0.join("state.json")).unwrap(), old, "{point:?}");
        let reopened = Store::open(&t.0).unwrap();
        assert_eq!(reopened.list_formal().len(), 2);
        assert_eq!(reopened.list_drafts().len(), 2);
        clean(&t.0);
    }
}

#[test]
fn lock_and_theme_write_failures_never_grant_success_or_lose_existing_content() {
    for point in [
        FaultPoint::TempWrite,
        FaultPoint::TempSync,
        FaultPoint::Replace,
    ] {
        for op in 0..6 {
            let t = Temp::new("u010-lock-fault");
            let mut s = Store::open(&t.0).unwrap();
            let id = draft(&mut s, "合成草稿");
            if op != 0 {
                s.set_app_lock("482615").unwrap();
            }
            let memory = s.state_json();
            let disk = fs::read(t.0.join("state.json")).unwrap();
            fault::set(point);
            let result = match op {
                0 => s.set_app_lock("482615"),
                1 => s.change_app_lock("482615", "123456"),
                2 => s.disable_app_lock("482615"),
                3 => s.verify_app_lock("482615"),
                4 => s.verify_app_lock("wrong-synthetic"),
                _ => s.set_theme(shiguang_core::ThemePreference::Dark),
            };
            assert!(result.is_err(), "{point:?} op {op}");
            fault::clear();
            assert_eq!(s.state_json(), memory);
            assert_eq!(fs::read(t.0.join("state.json")).unwrap(), disk);
            drop(s);
            let s = Store::open(&t.0).unwrap();
            assert_eq!(s.state_json(), memory);
            assert_eq!(s.row(&id).unwrap().draft.as_ref().unwrap().body, "合成草稿");
        }
    }
}

#[test]
fn interrupted_commit_retains_v4_draft_and_old_formal_until_atomic_publication() {
    use shiguang_core::{DraftPatch, Mood};
    for point in [
        FaultPoint::TempCreate,
        FaultPoint::TempWrite,
        FaultPoint::TempSync,
        FaultPoint::Replace,
    ] {
        let t = Temp::new("u010-content-commit-fault");
        let mut store = Store::open(&t.0).unwrap();
        let id = draft(&mut store, "合成正式内容");
        let a = photo(&mut store, &id, "synthetic-a");
        let b = photo(&mut store, &id, "synthetic-b");
        store.commit(&id, 0).unwrap();
        let formal = store.formal(&id).unwrap().clone();
        store
            .set_draft_photo_caption(&id, &a.photo_use_id, "合成待提交说明")
            .unwrap();
        store.set_draft_cover(&id, &b.photo_use_id).unwrap();
        store
            .reorder_draft_photos(&id, &[b.photo_use_id, a.photo_use_id])
            .unwrap();
        store
            .save_draft_patch(
                &id,
                &DraftPatch {
                    location: Some("合成待提交地点".into()),
                    mood: Some(Some(Mood::Calm)),
                    ..Default::default()
                },
            )
            .unwrap();
        let draft = store.row(&id).unwrap().draft.clone().unwrap();
        let before = store.state_json();
        let bytes = fs::read(t.0.join("state.json")).unwrap();
        fault::set(point);
        assert!(store.commit(&id, 1).is_err());
        fault::clear();
        assert_eq!(store.state_json(), before);
        assert_eq!(fs::read(t.0.join("state.json")).unwrap(), bytes);
        drop(store);
        let mut store = Store::open(&t.0).unwrap();
        assert_eq!(store.formal(&id), Some(&formal));
        assert_eq!(store.row(&id).unwrap().draft.as_ref(), Some(&draft));
        store.commit(&id, 1).unwrap();
        assert_eq!(store.formal(&id), Some(&draft));
        assert!(store.row(&id).unwrap().draft.is_none());
        clean(&t.0);
    }
}
