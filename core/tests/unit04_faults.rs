#![cfg(feature = "fault-injection")]
mod unit04_support;
use shiguang_core::{
    fault::{self, FaultPoint},
    json::Json,
    Store,
};
use std::fs;
use unit04_support::*;
fn migration_failure(name: &str, point: FaultPoint, code: &str, stage: &str, backup_count: usize) {
    fault::clear();
    let t = TempRoot::new(name);
    let before = legacy(&t);
    fault::set(point);
    let result = Store::open(t.path());
    fault::clear();
    let e = result.err().expect("injected migration must fail");
    assert_eq!(e.code, code);
    assert_eq!(e.stage, Some(stage));
    assert_eq!(t.bytes(), before);
    let copies = backups(&t);
    assert_eq!(copies.len(), backup_count);
    for copy in &copies {
        assert_eq!(fs::read(copy).unwrap(), before);
    }
    for (path, _) in tree(t.path()) {
        assert!(!path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".tmp-"));
    }
    let s = Store::open(t.path()).unwrap();
    assert_eq!(s.state_json().get("schemaVersion"), Some(&Json::Num(2)));
    for copy in copies {
        assert_eq!(fs::read(copy).unwrap(), before);
    }
    assert!(!backups(&t).is_empty());
}
#[test]
fn migration_backup_failure_preserves_original_and_leaves_no_backup() {
    migration_failure(
        "backup-fault",
        FaultPoint::MigrationBackup,
        "MIGRATION_BACKUP_FAILED",
        "migration_backup",
        0,
    );
}
#[test]
fn migration_write_failure_preserves_original_and_completed_backup() {
    migration_failure(
        "migration-write-fault",
        FaultPoint::MigrationWrite,
        "MIGRATION_FAILED",
        "migration_write",
        1,
    );
}
#[test]
fn after_media_write_failure_leaves_orphan_that_restart_quarantines() {
    fault::clear();
    let t = TempRoot::new("after-media-write");
    let mut s = Store::open(t.path()).unwrap();
    let id = draft(&mut s);
    let state = t.bytes();
    let memory = s.state_json();
    let image = png();
    fault::set(FaultPoint::AfterMediaWrite);
    let result = s.attach_photo_bytes(&id, "s.png", &image, "合成说明", None);
    fault::clear();
    assert!(
        result.is_err(),
        "AfterMediaWrite must interrupt before state persistence"
    );
    assert_eq!(t.bytes(), state);
    assert_eq!(s.state_json(), memory);
    assert!(s
        .row(&id)
        .unwrap()
        .draft
        .as_ref()
        .unwrap()
        .photos
        .is_empty());
    let files: Vec<_> = fs::read_dir(t.path().join("media"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1);
    assert_eq!(fs::read(&files[0]).unwrap(), image);
    drop(s);
    let mut s = Store::open_exclusive(t.path()).unwrap();
    let report = s.reconcile_media().unwrap();
    assert_eq!(report.quarantined.len(), 1);
    assert!(report.missing.is_empty());
    assert!(report.corrupt.is_empty());
    assert_eq!(t.bytes(), state);
    let target = moved(t.path(), &report.quarantined[0].moved_to);
    assert_eq!(fs::read(target).unwrap(), image);
    assert!(!files[0].exists());
}
