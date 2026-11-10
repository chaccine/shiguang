mod unit04_support;
use shiguang_core::{json::Json, RecordStatus, Store};
use std::fs;
use unit04_support::*;

#[test]
fn trash_and_restore_preserve_both_snapshots_revisions_and_survive_restart() {
    let t = TempRoot::new("trash-restore");
    let mut s = Store::open(t.path()).unwrap();
    let id = formal(&mut s);
    s.save_draft(&id, None, Some("合成修改"), None, None)
        .unwrap();
    let original = s.row(&id).unwrap().clone();
    let trashed = s.trash_record(&id).unwrap();
    assert_eq!(trashed.status, RecordStatus::Trashed);
    assert!(trashed.trashed_at.is_some());
    assert_eq!(trashed.formal, original.formal);
    assert_eq!(trashed.draft, original.draft);
    assert!(s.list_formal().is_empty());
    assert!(s.list_drafts().is_empty());
    drop(s);
    let mut s = Store::open(t.path()).unwrap();
    assert_eq!(s.list_trash().unwrap()[0].record_id, id);
    let restored = s.restore_record(&id).unwrap();
    assert_eq!(restored.status, RecordStatus::Active);
    assert_eq!(restored.trashed_at, None);
    assert_eq!(restored.formal, original.formal);
    assert_eq!(restored.draft, original.draft);
    assert_eq!(restored.content_revision, original.content_revision);
    assert_eq!(restored.base_revision, original.base_revision);
    drop(s);
    let s = Store::open(t.path()).unwrap();
    assert_eq!(s.list_formal().len(), 1);
    assert_eq!(s.list_drafts().len(), 1);
    assert!(s.list_trash().unwrap().is_empty());
}
#[test]
fn only_formal_records_can_be_trashed_and_only_trashed_can_be_purged() {
    let t = TempRoot::new("trash-preconditions");
    let mut s = Store::open(t.path()).unwrap();
    let id = draft(&mut s);
    let bytes = t.bytes();
    assert!(s.trash_record(&id).is_err());
    assert_eq!(t.bytes(), bytes);
    assert!(s.purge_record(&id).is_err());
    assert_eq!(t.bytes(), bytes);
    s.commit(&id, 0).unwrap();
    let bytes = t.bytes();
    assert!(s.purge_record(&id).is_err());
    assert_eq!(t.bytes(), bytes);
    assert!(s.list_trash().unwrap().is_empty());
}
#[test]
fn trash_list_orders_by_trashed_at_descending() {
    let t = TempRoot::new("trash-order");
    let mut s = Store::open(t.path()).unwrap();
    let a = formal(&mut s);
    let b = formal(&mut s);
    s.trash_record(&a).unwrap();
    s.trash_record(&b).unwrap();
    let mut value = s.state_json();
    if let Json::Obj(fields) = &mut value {
        if let Some((_, Json::Arr(rows))) = fields.iter_mut().find(|(k, _)| k == "records") {
            for row in rows {
                let date = if row.get("recordId").and_then(Json::as_str) == Some(&a) {
                    "2099-01-01T00:00:00Z"
                } else {
                    "2000-01-01T00:00:00Z"
                };
                set(row, "trashedAt", Json::str(date));
            }
        }
    }
    fs::write(t.path().join("state.json"), value.pretty()).unwrap();
    let s = Store::open(t.path()).unwrap();
    assert_eq!(
        s.list_trash()
            .unwrap()
            .iter()
            .map(|r| r.record_id.as_str())
            .collect::<Vec<_>>(),
        vec![a.as_str(), b.as_str()]
    );
}
fn write_protected(operation: &str) {
    let t = TempRoot::new(operation);
    let mut s = Store::open(t.path()).unwrap();
    let id = formal(&mut s);
    s.save_draft(&id, None, Some("合成草稿"), None, None)
        .unwrap();
    let p = s
        .attach_photo_bytes(&id, "s.png", &png(), "合成说明", None)
        .unwrap();
    s.trash_record(&id).unwrap();
    let before = tree(t.path());
    let memory = s.state_json();
    let error = match operation {
        "save" => s
            .save_draft(&id, None, Some("不能写"), None, None)
            .unwrap_err(),
        "attach" => s
            .attach_photo_bytes(&id, "new.png", b"synthetic-new", "", None)
            .unwrap_err(),
        "commit" => s.commit(&id, 1).unwrap_err(),
        "create" => s.create_draft(Some(&id), "", "", "", None).unwrap_err(),
        "remove" => s.remove_draft_photo(&id, &p.photo_use_id).unwrap_err(),
        "discard" => s.discard_draft(&id).unwrap_err(),
        _ => unreachable!(),
    };
    assert_eq!(error.code, "RECORD_TRASHED");
    assert_eq!(tree(t.path()), before);
    assert_eq!(s.state_json(), memory);
}
#[test]
fn trashed_save_is_write_protected() {
    write_protected("save");
}
#[test]
fn trashed_attach_is_write_protected() {
    write_protected("attach");
}
#[test]
fn trashed_commit_is_write_protected() {
    write_protected("commit");
}
#[test]
fn trashed_create_edit_is_write_protected() {
    write_protected("create");
}
#[test]
fn trashed_remove_photo_is_write_protected() {
    write_protected("remove");
}
#[test]
fn trashed_discard_is_write_protected() {
    write_protected("discard");
}
#[test]
fn manual_purge_creates_content_free_marker_and_quarantines_original() {
    let t = TempRoot::new("purge");
    let mut s = Store::open(t.path()).unwrap();
    let id = draft(&mut s);
    let image = png();
    let p = s
        .attach_photo_bytes(&id, "s.png", &image, "合成隐私说明", None)
        .unwrap();
    s.commit(&id, 0).unwrap();
    s.trash_record(&id).unwrap();
    let original = s.asset_path(&p.asset_id).unwrap();
    let out = s.purge_record(&id).unwrap();
    assert_eq!(out.deletion_markers.len(), 1);
    assert_eq!(out.quarantined.len(), 1);
    let marker = &out.deletion_markers[0];
    assert_eq!(marker.record_id, id);
    assert_eq!(marker.last_content_revision, 1);
    assert!(!marker.deleted_at.is_empty());
    assert!(!original.exists());
    let target = moved(t.path(), &out.quarantined[0].moved_to);
    assert!(target.starts_with(t.path().join("media-quarantine")));
    assert_eq!(fs::read(&target).unwrap(), image);
    assert_eq!(
        shiguang_core::sha256::hex_digest(&fs::read(&target).unwrap()),
        p.sha256
    );
    assert_eq!(s.row(&id).unwrap_err().code, "RECORD_DELETED");
    let state = s.state_json();
    let markers = state.get("deletionMarkers").and_then(Json::as_arr).unwrap();
    let Json::Obj(fields) = &markers[0] else {
        panic!("marker object");
    };
    let mut keys: Vec<_> = fields.iter().map(|(k, _)| k.as_str()).collect();
    keys.sort();
    // Unit-0.6 起删除标记多一个 createdAt（跨备份防复活的身份匹配用）；仍不含任何正文/标题/说明。
    assert_eq!(keys, vec!["createdAt", "deletedAt", "lastContentRevision", "recordId"]);
    let disk = String::from_utf8(t.bytes()).unwrap();
    for personal in ["合成标题", "合成正文", "合成隐私说明"] {
        assert!(!disk.contains(personal));
    }
    drop(s);
    let mut s = Store::open(t.path()).unwrap();
    assert_eq!(s.row(&id).unwrap_err().code, "RECORD_DELETED");
    assert_ne!(draft(&mut s), id);
    assert!(target.exists());
}
#[test]
fn empty_trash_only_deletes_trashed_rows_and_never_auto_purges() {
    let t = TempRoot::new("empty-trash");
    let mut s = Store::open(t.path()).unwrap();
    let active = formal(&mut s);
    let pending = draft(&mut s);
    let a = formal(&mut s);
    let b = formal(&mut s);
    s.trash_record(&a).unwrap();
    s.trash_record(&b).unwrap();
    drop(s);
    let mut s = Store::open(t.path()).unwrap();
    assert_eq!(s.list_trash().unwrap().len(), 2);
    let out = s.empty_trash().unwrap();
    assert_eq!(out.deletion_markers.len(), 2);
    assert!(s.list_trash().unwrap().is_empty());
    for id in [a, b] {
        assert_eq!(s.row(&id).unwrap_err().code, "RECORD_DELETED");
    }
    assert!(s.row(&active).unwrap().formal.is_some());
    assert!(s.row(&pending).unwrap().draft.is_some());
    assert!(s.empty_trash().unwrap().deletion_markers.is_empty());
}
#[test]
fn purge_keeps_original_while_any_formal_draft_or_trash_reference_remains() {
    for kind in ["formal", "draft", "trash"] {
        let t = TempRoot::new(&format!("shared-{kind}"));
        let mut s = Store::open(t.path()).unwrap();
        let a = draft(&mut s);
        let b = draft(&mut s);
        let image = png();
        let p = s
            .attach_photo_bytes(&a, "s.png", &image, "a", None)
            .unwrap();
        s.attach_photo_bytes(&b, "s.png", &image, "b", None)
            .unwrap();
        s.commit(&a, 0).unwrap();
        if kind != "draft" {
            s.commit(&b, 0).unwrap();
        }
        if kind == "trash" {
            s.trash_record(&b).unwrap();
        }
        s.trash_record(&a).unwrap();
        assert!(s.purge_record(&a).unwrap().quarantined.is_empty());
        assert_eq!(fs::read(s.asset_path(&p.asset_id).unwrap()).unwrap(), image);
    }
}
