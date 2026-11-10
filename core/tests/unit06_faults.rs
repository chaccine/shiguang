#![cfg(feature = "fault-injection")]
mod unit05_support;
use shiguang_core::{
    backup::decrypt_backup,
    fault::{self, FaultPoint},
    KdfParams, Store,
};
use std::fs;
use unit05_support::*;
const PASSWORD: &str = "synthetic-fault-secret";
fn merge_fault(point: FaultPoint, crash: bool) {
    let a = Temp::new("mf-a");
    let b = Temp::new("mf-b");
    let f = Temp::new("mf-f");
    let s = seeded(&a.0, "incoming");
    let mut t = seeded(&b.0, "local");
    let before = live_tree(&b.0);
    let path = f.0.join("x");
    s.export_backup(&path, "1").unwrap();
    fault::set(point);
    assert!(t.merge_backup(&path).is_err());
    fault::clear();
    if crash {
        assert!(b.0.join(".merge-journal.json").exists());
        drop(t);
        Store::open_exclusive(&b.0).unwrap();
    }
    assert_eq!(before, live_tree(&b.0));
    for p in tree(&b.0).keys() {
        let n = p.to_string_lossy();
        assert!(!n.contains(".tmp-") && !n.contains(".merge-"));
    }
}
#[test]
fn merge_stage() {
    merge_fault(FaultPoint::MergeStage, false)
}
#[test]
fn merge_media() {
    merge_fault(FaultPoint::MergeMediaWrite, false)
}
#[test]
fn merge_state() {
    merge_fault(FaultPoint::MergeStateWrite, false)
}
#[test]
fn crash_after_merge_media() {
    merge_fault(FaultPoint::CrashAfterMergeMedia, true)
}
#[test]
fn encrypt_chunk_cleans_every_plaintext_and_partial() {
    let a = Temp::new("ef-a");
    let f = Temp::new("ef-f");
    let s = seeded(&a.0, "source");
    let before = tree(&a.0);
    fault::set(FaultPoint::EncryptChunk);
    assert!(s
        .export_backup_encrypted(&f.0.join("enc"), "1", PASSWORD, KdfParams::fast())
        .is_err());
    fault::clear();
    assert_eq!(tree(&a.0), before);
    assert!(tree(&f.0).is_empty());
}
#[test]
fn decrypt_chunk_cleans_partial() {
    let a = Temp::new("df-a");
    let f = Temp::new("df-f");
    let s = seeded(&a.0, "source");
    let path = f.0.join("enc");
    s.export_backup_encrypted(&path, "1", PASSWORD, KdfParams::fast())
        .unwrap();
    fault::set(FaultPoint::DecryptChunk);
    assert!(decrypt_backup(&path, &f.0.join("plain"), PASSWORD).is_err());
    fault::clear();
    assert!(!f.0.join("plain").exists());
    assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
}
#[test]
fn kth_media_and_later_crypto_chunks_rollback_owned_files_only() {
    let a = Temp::new("kth-a");
    let b = Temp::new("kth-b");
    let f = Temp::new("kth-f");
    let mut s = seeded(&a.0, "first");
    let id = draft(&mut s, "second");
    photo(&mut s, &id, "second");
    s.commit(&id, 0).unwrap();
    let path = f.0.join("plain");
    s.export_backup(&path, "1").unwrap();
    let mut t = Store::open_exclusive(&b.0).unwrap();
    let before = live_tree(&b.0);
    fault::set_after(FaultPoint::MergeMediaWrite, 2);
    assert!(t.merge_backup(&path).is_err());
    fault::clear();
    assert_eq!(live_tree(&b.0), before);
    let id = draft(&mut s, "large");
    s.attach_photo_bytes(
        &id,
        "large.bin",
        &vec![42; 2 * 1024 * 1024 + 99],
        "synthetic",
        None,
    )
    .unwrap();
    s.commit(&id, 0).unwrap();
    let before = tree(&a.0);
    fault::set_after(FaultPoint::EncryptChunk, 2);
    assert!(s
        .export_backup_encrypted(&f.0.join("enc"), "1", PASSWORD, KdfParams::fast())
        .is_err());
    fault::clear();
    assert_eq!(tree(&a.0), before);
    s.export_backup_encrypted(&f.0.join("enc"), "1", PASSWORD, KdfParams::fast())
        .unwrap();
    fault::set_after(FaultPoint::DecryptChunk, 2);
    assert!(decrypt_backup(&f.0.join("enc"), &f.0.join("out"), PASSWORD).is_err());
    fault::clear();
    assert!(!f.0.join("out").exists());
}
#[test]
fn crash_after_commit_reopens_complete_new_state_and_clears_journal() {
    for exclusive in [false, true] {
        let a = Temp::new("commit-a");
        let b = Temp::new("commit-b");
        let f = Temp::new("commit-f");
        let s = seeded(&a.0, "source");
        let mut t = Store::open_exclusive(&b.0).unwrap();
        let path = f.0.join("x");
        s.export_backup(&path, "1").unwrap();
        fault::set(FaultPoint::MergeAfterCommit);
        assert!(t.merge_backup(&path).is_err());
        fault::clear();
        drop(t);
        let t = if exclusive {
            Store::open_exclusive(&b.0)
        } else {
            Store::open(&b.0)
        }
        .unwrap();
        assert_eq!(t.list_formal().len(), 1);
        assert!(!b.0.join(".merge-journal.json").exists());
        let original = t.all_photos()[0].clone();
        assert!(t.asset_path(&original.asset_id).unwrap().exists());
    }
}
#[test]
fn encrypted_export_self_verification_failure_cleans_both_directories() {
    let a = Temp::new("selfcheck-a");
    let f = Temp::new("selfcheck-f");
    let s = seeded(&a.0, "content");
    let before = tree(&a.0);
    fault::set(FaultPoint::DecryptChunk);
    assert!(s
        .export_backup_encrypted(&f.0.join("enc"), "1", PASSWORD, KdfParams::fast())
        .is_err());
    fault::clear();
    assert_eq!(tree(&a.0), before);
    assert!(tree(&f.0).is_empty());
}
