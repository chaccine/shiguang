mod unit05_support;
mod unit07_support;
use shiguang_core::{ConflictChoice, Store};
use std::fs;
use unit07_support::*;
#[test]
fn metadata_cas_does_not_publish_or_overwrite_drafts() {
    let t = Temp::new("u07-meta");
    let mut s = Store::open(&t.0).unwrap();
    let id = formal(&mut s);
    s.save_draft(&id, None, Some("新版合成正文"), None, None)
        .unwrap();
    let before = s.row(&id).unwrap().clone();
    let tag = s.create_tag("合成标签").unwrap();
    let m = s.set_favorite(&id, true, Some(0)).unwrap();
    assert_eq!(m.favorite_revision, 1);
    s.set_record_tags(&id, &[tag.tag_id.clone(), tag.tag_id.clone()], Some(0))
        .unwrap();
    let r = s.row(&id).unwrap();
    assert_eq!(r.formal, before.formal);
    assert_eq!(r.draft, before.draft);
    assert_eq!(r.content_revision, before.content_revision);
    assert_eq!(r.committed_at, before.committed_at);
    let disk = fs::read(t.0.join("state.json")).unwrap();
    for e in [
        s.set_favorite(&id, false, Some(0)).unwrap_err(),
        s.set_record_tags(&id, &[], Some(0)).unwrap_err(),
    ] {
        assert_eq!(e.code, "META_REVISION_CONFLICT");
    }
    assert_eq!(fs::read(t.0.join("state.json")).unwrap(), disk);
    s.set_favorite(&id, true, Some(1)).unwrap();
    s.set_record_tags(&id, std::slice::from_ref(&tag.tag_id), Some(1))
        .unwrap();
    assert_eq!(fs::read(t.0.join("state.json")).unwrap(), disk);
    s.commit(&id, 1).unwrap();
    let r = s.row(&id).unwrap();
    assert!(r.favorite);
    assert_eq!(r.tag_ids, vec![tag.tag_id]);
    assert_eq!(r.formal.as_ref().unwrap().body, "新版合成正文");
    s.save_draft(&id, None, Some("冲突草稿"), None, None)
        .unwrap();
    s.resolve_conflict(&id, ConflictChoice::KeepFormal).unwrap();
    let c = s.list_conflict_copies().unwrap()[0].conflict_id.clone();
    s.restore_conflict_copy(&c).unwrap();
    assert!(s.row(&id).unwrap().favorite);
    assert_eq!(s.row(&id).unwrap().tag_revision, 1);
}
#[test]
fn formal_only_trash_restore_purge_and_missing() {
    let t = Temp::new("u07-formal");
    let mut s = Store::open(&t.0).unwrap();
    let id = draft(&mut s, "草稿");
    assert_eq!(
        s.set_favorite(&id, true, None).unwrap_err().code,
        "RECORD_NOT_FORMAL"
    );
    assert!(s.set_record_tags(&id, &[], Some(0)).is_ok());
    s.commit(&id, 0).unwrap();
    s.set_favorite(&id, true, None).unwrap();
    let tag = s.create_tag("保留").unwrap();
    s.set_record_tags(&id, &[tag.tag_id], None).unwrap();
    s.trash_record(&id).unwrap();
    assert_eq!(
        s.set_favorite(&id, false, None).unwrap_err().code,
        "RECORD_TRASHED"
    );
    assert_eq!(
        s.set_record_tags(&id, &[], None).unwrap_err().code,
        "RECORD_TRASHED"
    );
    s.restore_record(&id).unwrap();
    assert!(s.row(&id).unwrap().favorite);
    assert_eq!(s.row(&id).unwrap().tag_revision, 1);
    assert_eq!(
        s.set_record_tags(&id, &["missing".into()], None)
            .unwrap_err()
            .code,
        "TAG_NOT_FOUND"
    );
    assert!(s.set_favorite("missing", true, None).is_err());
    s.trash_record(&id).unwrap();
    s.purge_record(&id).unwrap();
    assert_eq!(
        s.set_favorite(&id, true, None).unwrap_err().code,
        "RECORD_DELETED"
    );
    assert_eq!(s.list_tags()[0].active_count, 0);
}
#[test]
fn stale_store_cas_and_content_commit_keep_latest_independent_metadata() {
    let t = Temp::new("u07-stale");
    let mut a = Store::open(&t.0).unwrap();
    let id = formal(&mut a);
    a.save_draft(&id, None, Some("本地草稿"), None, None)
        .unwrap();
    let mut b = Store::open(&t.0).unwrap();
    let tag = b.create_tag("最新标签").unwrap();
    b.set_favorite(&id, true, Some(0)).unwrap();
    b.set_record_tags(&id, std::slice::from_ref(&tag.tag_id), Some(0))
        .unwrap();
    let memory = a.state_json();
    let disk = fs::read(t.0.join("state.json")).unwrap();
    assert_eq!(
        a.set_favorite(&id, false, Some(0)).unwrap_err().code,
        "META_REVISION_CONFLICT"
    );
    assert_eq!(a.state_json(), memory);
    assert_eq!(fs::read(t.0.join("state.json")).unwrap(), disk);
    a.commit(&id, 1).unwrap();
    let r = a.row(&id).unwrap();
    assert!(r.favorite);
    assert_eq!(r.tag_ids, vec![tag.tag_id]);
    assert_eq!(r.formal.as_ref().unwrap().body, "本地草稿");
}

#[test]
fn draft_tag_creation_detach_cas_commit_and_discard() {
    let t = Temp::new("u08-draft-tags");
    let mut s = Store::open(&t.0).unwrap();
    let id = draft(&mut s, "合成编辑器正文");
    let tag = s.create_tag("写作中创建").unwrap();
    s.set_record_tags(&id, &[tag.tag_id.clone()], Some(0))
        .unwrap();
    assert_eq!(
        s.set_record_tags(&id, &[], Some(0)).unwrap_err().code,
        "META_REVISION_CONFLICT"
    );
    s.set_record_tags(&id, &[], Some(1)).unwrap();
    s.set_record_tags(&id, &[tag.tag_id.clone()], Some(2))
        .unwrap();
    s.commit(&id, 0).unwrap();
    assert_eq!(s.row(&id).unwrap().tag_ids, vec![tag.tag_id.clone()]);
    let unpublished = draft(&mut s, "将丢弃");
    s.set_record_tags(&unpublished, &[tag.tag_id], Some(0))
        .unwrap();
    s.discard_draft(&unpublished).unwrap();
    assert!(s.row(&unpublished).is_err());
    assert_eq!(s.list_tags()[0].active_count, 1);
}
