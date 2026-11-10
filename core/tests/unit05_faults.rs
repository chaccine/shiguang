#![cfg(feature = "fault-injection")]
mod unit05_support;
use shiguang_core::{
    fault::{self, FaultPoint},
    Store,
};
use std::fs;
use unit05_support::*;
fn export_fault(point: FaultPoint) {
    let a = Temp::new("export-fault");
    let f = Temp::new("export-fault-file");
    let s = seeded(&a.0, "source");
    let before = tree(&a.0);
    let dest = f.0.join("x.sgbak");
    fault::set(point);
    assert!(s.export_backup(&dest, "1").is_err());
    fault::clear();
    assert!(!dest.exists());
    clean(&f.0);
    assert_eq!(tree(&a.0), before);
}
#[test]
fn backup_write_cleans_partial_and_preserves_source() {
    export_fault(FaultPoint::BackupWrite);
}
#[test]
fn backup_finalize_cleans_partial_and_preserves_source() {
    export_fault(FaultPoint::BackupFinalize);
}
fn restore_fault(point: FaultPoint, stage: &str, code: &str) {
    let a = Temp::new("restore-fault-a");
    let b = Temp::new("restore-fault-b");
    let f = Temp::new("restore-fault-file");
    let s = seeded(&a.0, "source");
    let mut t = seeded(&b.0, "target");
    let before = live_tree(&b.0);
    let mem = t.state_json();
    let dest = f.0.join("x.sgbak");
    s.export_backup(&dest, "1").unwrap();
    fault::set(point);
    let e = t.restore_backup_overwrite(&dest).unwrap_err();
    fault::clear();
    assert_eq!(e.code, code);
    assert_eq!(e.stage, Some(stage));
    assert_eq!(live_tree(&b.0), before);
    assert_eq!(t.state_json(), mem);
    clean(&b.0);
    for e in fs::read_dir(b.0.join("backups")).into_iter().flatten() {
        let dir = e.unwrap().path();
        assert!(dir.join("SAFETY.json").exists());
        for (p, v) in before
            .iter()
            .filter(|(p, _)| p.starts_with("media") || p.as_os_str() == "state.json")
        {
            assert_eq!(&fs::read(dir.join(p)).unwrap(), v);
        }
    }
    drop(t);
    assert_eq!(Store::open(&b.0).unwrap().state_json(), mem);
}
#[test]
fn stage_failure_preserves_target() {
    restore_fault(FaultPoint::RestoreStage, "stage", "RESTORE_FAILED");
}
#[test]
fn safety_failure_cleans_incomplete_copy() {
    restore_fault(
        FaultPoint::RestoreSafety,
        "safety",
        "RESTORE_SAFETY_BACKUP_FAILED",
    );
}
#[test]
fn media_switch_failure_rolls_back() {
    restore_fault(FaultPoint::RestoreSwitchMedia, "switch", "RESTORE_FAILED");
}
#[test]
fn state_switch_failure_rolls_back() {
    restore_fault(FaultPoint::RestoreSwitchState, "switch", "RESTORE_FAILED");
}
fn crash(point: FaultPoint, committed: bool, exclusive: bool) {
    let a = Temp::new("crash-a");
    let b = Temp::new("crash-b");
    let f = Temp::new("crash-file");
    let s = seeded(&a.0, "source");
    let mut t = seeded(&b.0, "target");
    let before = live_tree(&b.0);
    let expected = if committed {
        s.state_json()
    } else {
        t.state_json()
    };
    let dest = f.0.join("x.sgbak");
    s.export_backup(&dest, "1").unwrap();
    fault::set(point);
    assert!(t.restore_backup_overwrite(&dest).is_err());
    fault::clear();
    assert!(b.0.join(".restore-journal.json").exists());
    drop(t);
    let reopened = if exclusive {
        Store::open_exclusive(&b.0)
    } else {
        Store::open(&b.0)
    }
    .unwrap();
    assert_eq!(reopened.state_json(), expected);
    if !committed {
        assert_eq!(live_tree(&b.0), before);
    } else {
        for (p, v) in tree(&a.0)
            .into_iter()
            .filter(|(p, _)| p.starts_with("media"))
        {
            assert_eq!(fs::read(b.0.join(p)).unwrap(), v);
        }
    }
    clean(&b.0);
    drop(reopened);
    assert_eq!(Store::open(&b.0).unwrap().state_json(), expected);
}
#[test]
fn after_commit_reopen_exclusive_finishes_new_state() {
    crash(FaultPoint::RestoreAfterCommit, true, true);
}
#[test]
fn after_commit_plain_open_finishes_new_state() {
    crash(FaultPoint::RestoreAfterCommit, true, false);
}
#[test]
fn crash_after_media_swap_reopen_exclusive_restores_old() {
    crash(FaultPoint::CrashAfterMediaSwap, false, true);
}
#[test]
fn crash_after_media_swap_plain_open_restores_old() {
    crash(FaultPoint::CrashAfterMediaSwap, false, false);
}

#[test]
fn identical_state_switch_failure_still_rolls_back_media() {
    let a = Temp::new("identical-a");
    let b = Temp::new("identical-b");
    let f = Temp::new("identical-file");
    let s = seeded(&a.0, "same");
    let mut t = seeded(&b.0, "same");
    // Exact same state bytes, but B has a damaged original and an orphan. A must
    // not be considered committed merely because the old JSON equals staged JSON.
    fs::write(
        b.0.join("state.json"),
        fs::read(a.0.join("state.json")).unwrap(),
    )
    .unwrap();
    let path = t
        .asset_path(&t.list_formal()[0].formal.as_ref().unwrap().photos[0].asset_id)
        .unwrap();
    fs::write(path, b"synthetic damaged").unwrap();
    fs::write(b.0.join("media/orphan.bin"), b"synthetic orphan").unwrap();
    let before = live_tree(&b.0);
    let dest = f.0.join("same.sgbak");
    s.export_backup(&dest, "1").unwrap();
    fault::set(FaultPoint::RestoreSwitchState);
    assert!(t.restore_backup_overwrite(&dest).is_err());
    fault::clear();
    assert_eq!(live_tree(&b.0), before);
    clean(&b.0);
}

#[test]
fn crash_between_media_renames_recovers_old_and_cleans_temps_afterwards() {
    let a = Temp::new("between-a");
    let b = Temp::new("between-b");
    let f = Temp::new("between-file");
    let s = seeded(&a.0, "source");
    let mut t = seeded(&b.0, "target");
    let before = live_tree(&b.0);
    let dest = f.0.join("x.sgbak");
    s.export_backup(&dest, "1").unwrap();
    fault::set(FaultPoint::CrashAfterMediaSwap);
    assert!(t.restore_backup_overwrite(&dest).is_err());
    fault::clear();
    drop(t);
    let j =
        shiguang_core::json::parse(&fs::read_to_string(b.0.join(".restore-journal.json")).unwrap())
            .unwrap();
    let stage = j.get("staging").unwrap().as_str().unwrap();
    // Recreate the earlier crash window: old/media was renamed, but new media
    // has not yet been installed. Opening must recover before creating media/.
    fs::rename(b.0.join("media"), b.0.join(stage).join("media")).unwrap();
    fs::write(b.0.join(".tmp-interrupted-state"), b"synthetic half write").unwrap();
    let reopened = Store::open(&b.0).unwrap();
    assert_eq!(live_tree(&b.0), before);
    clean(&b.0);
    drop(reopened);
}
#[test]
fn committed_cleanup_is_idempotent_after_old_archive_and_staging_removal() {
    let a = Temp::new("cleanup-a");
    let b = Temp::new("cleanup-b");
    let f = Temp::new("cleanup-file");
    let s = seeded(&a.0, "source");
    let mut t = seeded(&b.0, "target");
    let dest = f.0.join("x.sgbak");
    s.export_backup(&dest, "1").unwrap();
    fault::set(FaultPoint::RestoreAfterCommit);
    assert!(t.restore_backup_overwrite(&dest).is_err());
    fault::clear();
    drop(t);
    let j =
        shiguang_core::json::parse(&fs::read_to_string(b.0.join(".restore-journal.json")).unwrap())
            .unwrap();
    let path = |k| b.0.join(j.get(k).unwrap().as_str().unwrap());
    fs::rename(path("old"), path("safety").join("replaced")).unwrap();
    fs::remove_dir_all(path("staging")).unwrap();
    let reopened = Store::open(&b.0).unwrap();
    assert_eq!(reopened.state_json(), s.state_json());
    assert!(path("safety").join("replaced/media").exists());
    clean(&b.0);
}
#[test]
fn identical_state_crash_before_commit_restores_exact_old_media() {
    let a = Temp::new("identical-crash-a");
    let b = Temp::new("identical-crash-b");
    let f = Temp::new("identical-crash-file");
    let s = seeded(&a.0, "same");
    let mut t = seeded(&b.0, "same");
    fs::write(
        b.0.join("state.json"),
        fs::read(a.0.join("state.json")).unwrap(),
    )
    .unwrap();
    fs::write(b.0.join("media/orphan.bin"), b"synthetic orphan").unwrap();
    let before = live_tree(&b.0);
    let dest = f.0.join("x.sgbak");
    s.export_backup(&dest, "1").unwrap();
    fault::set(FaultPoint::CrashAfterMediaSwap);
    assert!(t.restore_backup_overwrite(&dest).is_err());
    fault::clear();
    drop(t);
    let reopened = Store::open(&b.0).unwrap();
    assert_eq!(live_tree(&b.0), before);
    assert_eq!(reopened.state_json(), s.state_json());
    clean(&b.0);
}

#[test]
fn portable_locks_support_export_restore_without_nested_write_lock() {
    shiguang_core::lock::force_unsupported(true);
    let a = Temp::new("portable-a");
    let b = Temp::new("portable-b");
    let f = Temp::new("portable-file");
    let s = seeded(&a.0, "portable synthetic");
    let dest = f.0.join("x.sgbak");
    s.export_backup(&dest, "1").unwrap();
    let mut t = Store::open_exclusive(&b.0).unwrap();
    t.restore_backup_overwrite(&dest).unwrap();
    assert_eq!(t.state_json(), s.state_json());
    drop(t);
    drop(s);
    shiguang_core::lock::force_unsupported(false);
}
