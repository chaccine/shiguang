mod unit04_support;
use shiguang_core::{ConflictChoice, Store};
use std::fs;
use unit04_support::*;
fn stale_pair(t: &TempRoot) -> (Store, Store, String) {
    let mut local = Store::open(t.path()).unwrap();
    let id = draft(&mut local);
    let mut other = Store::open(t.path()).unwrap();
    other
        .save_draft(&id, None, Some("合成新正式版"), None, None)
        .unwrap();
    other.commit(&id, 0).unwrap();
    (local, other, id)
}
#[test]
fn keep_mine_rebases_without_auto_commit_then_user_can_commit() {
    let t = TempRoot::new("keep-mine");
    let (mut local, _, id) = stale_pair(&t);
    assert_eq!(local.commit(&id, 0).unwrap_err().code, "REVISION_CONFLICT");
    let row = local
        .resolve_conflict(&id, ConflictChoice::KeepMine)
        .unwrap();
    assert_eq!(row.base_revision, 1);
    assert_eq!(row.content_revision, 1);
    assert_eq!(row.formal.as_ref().unwrap().body, "合成新正式版");
    assert_eq!(row.draft.as_ref().unwrap().body, "合成正文");
    drop(local);
    let mut s = Store::open(t.path()).unwrap();
    assert_eq!(s.row(&id).unwrap().content_revision, 1);
    assert_eq!(s.commit(&id, 1).unwrap().content_revision, 2);
    assert_eq!(s.formal(&id).unwrap().body, "合成正文");
}
#[test]
fn keep_formal_saves_recoverable_copy_and_restore_uses_current_revision() {
    let t = TempRoot::new("keep-formal");
    let (mut local, _, id) = stale_pair(&t);
    assert_eq!(local.commit(&id, 0).unwrap_err().code, "REVISION_CONFLICT");
    let row = local
        .resolve_conflict(&id, ConflictChoice::KeepFormal)
        .unwrap();
    assert!(row.draft.is_none());
    assert_eq!(row.formal.as_ref().unwrap().body, "合成新正式版");
    assert_eq!(row.content_revision, 1);
    let copies = local.list_conflict_copies().unwrap();
    assert_eq!(copies.len(), 1);
    let c = copies[0].clone();
    assert_eq!(c.record_id, id);
    assert_eq!(c.base_revision, 0);
    assert_eq!(c.snapshot.body, "合成正文");
    assert!(!c.created_at.is_empty());
    assert!(!c.reason.is_empty());
    drop(local);
    let mut s = Store::open(t.path()).unwrap();
    assert_eq!(s.list_conflict_copies().unwrap(), copies);
    s.save_draft(&id, None, Some("合成再次更新"), None, None)
        .unwrap();
    s.commit(&id, 1).unwrap();
    let restored = s.restore_conflict_copy(&c.conflict_id).unwrap();
    assert_eq!(restored.draft.unwrap(), c.snapshot);
    assert_eq!(restored.base_revision, 2);
    assert_eq!(restored.content_revision, 2);
    assert_eq!(restored.formal.unwrap().body, "合成再次更新");
}
#[test]
fn occupied_disk_draft_preserves_local_copy_durably_without_overwriting_slot() {
    let t = TempRoot::new("occupied-conflict");
    let (mut local, mut other, id) = stale_pair(&t);
    other
        .save_draft(&id, None, Some("合成磁盘草稿"), None, None)
        .unwrap();
    assert_eq!(local.commit(&id, 0).unwrap_err().code, "REVISION_CONFLICT");
    // commit 冲突本身不写盘（Unit-0.1 断言）；显式保存冲突副本后才持久化。
    local.save_conflict_copy(&id).unwrap();
    drop(local);
    drop(other);
    let s = Store::open(t.path()).unwrap();
    assert_eq!(
        s.row(&id).unwrap().draft.as_ref().unwrap().body,
        "合成磁盘草稿"
    );
    assert_eq!(s.formal(&id).unwrap().body, "合成新正式版");
    let copies = s.list_conflict_copies().unwrap();
    assert!(copies
        .iter()
        .any(|c| c.record_id == id && c.base_revision == 0 && c.snapshot.body == "合成正文"));
    let state = s.state_json();
    assert!(!state
        .get("conflictCopies")
        .and_then(shiguang_core::json::Json::as_arr)
        .unwrap()
        .is_empty());
}
#[test]
fn restoring_copy_to_occupied_slot_rejects_without_any_change() {
    let t = TempRoot::new("restore-occupied");
    let (mut local, _, id) = stale_pair(&t);
    assert_eq!(local.commit(&id, 0).unwrap_err().code, "REVISION_CONFLICT");
    local
        .resolve_conflict(&id, ConflictChoice::KeepFormal)
        .unwrap();
    let c = local.list_conflict_copies().unwrap().remove(0);
    local
        .save_draft(&id, None, Some("合成占位草稿"), None, None)
        .unwrap();
    let before = t.bytes();
    let memory = local.state_json();
    assert!(local.restore_conflict_copy(&c.conflict_id).is_err());
    assert_eq!(t.bytes(), before);
    assert_eq!(local.state_json(), memory);
    assert!(local.list_conflict_copies().unwrap().contains(&c));
}
#[test]
fn conflict_copy_only_photo_reference_survives_purge_and_reconcile() {
    let t = TempRoot::new("conflict-photo");
    let mut s = Store::open_exclusive(t.path()).unwrap();
    let id = formal(&mut s);
    let p = s
        .attach_photo_bytes(&id, "s.png", &png(), "合成副本照片", None)
        .unwrap();
    s.resolve_conflict(&id, ConflictChoice::KeepFormal).unwrap();
    assert!(s.row(&id).unwrap().draft.is_none());
    assert_eq!(s.list_conflict_copies().unwrap()[0].snapshot.photos[0], p);
    let other_id = draft(&mut s);
    s.attach_photo_bytes(&other_id, "s.png", &png(), "共享", None)
        .unwrap();
    s.commit(&other_id, 0).unwrap();
    s.trash_record(&other_id).unwrap();
    assert!(s.purge_record(&other_id).unwrap().quarantined.is_empty());
    assert!(s.reconcile_media().unwrap().quarantined.is_empty());
    assert!(s.asset_path(&p.asset_id).unwrap().exists());
    assert_eq!(fs::read(s.asset_path(&p.asset_id).unwrap()).unwrap(), png());
}
