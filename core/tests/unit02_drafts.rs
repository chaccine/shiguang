use shiguang_core::{json::Json, Store};
use std::fs;
use std::path::{Path, PathBuf};

struct Temp(PathBuf);
impl Temp {
    fn new(name: &str) -> Self {
        let p = std::env::temp_dir().join(format!("shiguang-u02-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        Self(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn new_row(store: &mut Store) -> String {
    store
        .create_draft(None, "合成标题", "合成正文", "2026-11-09", None)
        .unwrap()
        .record_id
}
fn assert_unchanged(store: &Store, before: &str, disk: &[u8]) {
    assert_eq!(store.state_json().dump(), before);
    assert_eq!(fs::read(store.root().join("state.json")).unwrap(), disk);
    assert_eq!(
        Store::open(store.root()).unwrap().state_json().dump(),
        before
    );
}

#[test]
fn list_drafts_orders_updates_and_ties_and_includes_formal_edits() {
    let tmp = Temp::new("list");
    let mut s = Store::open(tmp.path()).unwrap();
    let a = new_row(&mut s);
    let b = new_row(&mut s);
    let c = new_row(&mut s);
    let d = new_row(&mut s);
    s.commit(&c, 0).unwrap();
    s.commit(&d, 0).unwrap();
    s.create_draft(Some(&c), "", "", "", None).unwrap();
    let mut rows = vec![
        s.row(&a).unwrap().clone(),
        s.row(&b).unwrap().clone(),
        s.row(&c).unwrap().clone(),
        s.row(&d).unwrap().clone(),
    ];
    rows[0].updated_at = "2099-01-01T00:00:00Z".into();
    rows[1].updated_at = "2000-01-01T00:00:00Z".into();
    rows[2].updated_at = "2000-01-01T00:00:00Z".into();
    let state = Json::obj(vec![
        ("version", Json::Num(1)),
        ("seq", Json::Num(4)),
        ("seed", Json::str("20261109")),
        (
            "records",
            Json::Arr(rows.iter().map(|r| r.to_json()).collect()),
        ),
    ]);
    fs::write(tmp.path().join("state.json"), state.pretty()).unwrap();
    let s = Store::open(tmp.path()).unwrap();
    assert_eq!(
        s.list_drafts()
            .iter()
            .map(|r| r.record_id.as_str())
            .collect::<Vec<_>>(),
        vec![a.as_str(), c.as_str(), b.as_str()]
    );
    assert_eq!(s.list_formal().len(), 2);
}

#[test]
fn bytes_and_path_share_assets_but_not_photo_uses() {
    let tmp = Temp::new("bytes");
    let mut s = Store::open(tmp.path()).unwrap();
    let id = new_row(&mut s);
    let bytes = b"\x89PNGsynthetic";
    let first = s
        .attach_photo_bytes(&id, "synthetic.bin", bytes, "第一张", None)
        .unwrap();
    let path = tmp.path().join("synthetic.png");
    fs::write(&path, bytes).unwrap();
    let second = s.attach_photo(&id, &path, "第二张", None).unwrap();
    assert_eq!(first.media_type, "image/png");
    assert_eq!(first.asset_id, second.asset_id);
    assert_eq!(first.sha256, shiguang_core::sha256::hex_digest(bytes));
    assert_eq!(first.bytes, bytes.len() as u64);
    assert_ne!(first.photo_use_id, second.photo_use_id);
    assert_ne!(first.caption, second.caption);
    assert_eq!(
        fs::read(s.asset_path(&first.asset_id).unwrap()).unwrap(),
        bytes
    );
    assert_eq!(
        Store::open(tmp.path())
            .unwrap()
            .row(&id)
            .unwrap()
            .draft
            .as_ref()
            .unwrap()
            .photos
            .len(),
        2
    );
}

#[test]
fn invalid_byte_requests_leave_memory_state_and_media_unchanged() {
    let tmp = Temp::new("invalid");
    let mut s = Store::open(tmp.path()).unwrap();
    let id = new_row(&mut s);
    let before = s.state_json().dump();
    let disk = fs::read(tmp.path().join("state.json")).unwrap();
    let durability = s.last_durability().clone();
    for name in [
        "", ".", "..", "../a.png", "a/b.png", "a\\b.png", "C:a.png", "/a.png", "a\0.png",
    ] {
        assert_eq!(
            s.attach_photo_bytes(&id, name, b"synthetic", "", None)
                .unwrap_err()
                .code,
            "INVALID_ASSET_NAME"
        );
        assert_unchanged(&s, &before, &disk);
    }
    assert_eq!(
        s.attach_photo_bytes(&id, "a.png", b"", "", None)
            .unwrap_err()
            .code,
        "EMPTY_ASSET"
    );
    assert_eq!(
        s.attach_photo_bytes(&id, "a.png", &vec![0; 25 * 1024 * 1024 + 1], "", None)
            .unwrap_err()
            .code,
        "ASSET_TOO_LARGE"
    );
    assert_eq!(
        s.attach_photo_bytes("missing", "a.png", b"synthetic", "", None)
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
    assert_unchanged(&s, &before, &disk);
    assert_eq!(s.last_durability(), &durability);
    assert_eq!(fs::read_dir(tmp.path().join("media")).unwrap().count(), 0);
}

#[test]
fn exactly_25_mib_is_accepted_and_explicit_type_is_kept() {
    let tmp = Temp::new("limit");
    let mut s = Store::open(tmp.path()).unwrap();
    let id = new_row(&mut s);
    let p = s
        .attach_photo_bytes(
            &id,
            "synthetic.dat",
            &vec![42; 25 * 1024 * 1024],
            "",
            Some("image/jpeg"),
        )
        .unwrap();
    assert_eq!(p.bytes, 25 * 1024 * 1024);
    assert_eq!(p.media_type, "image/jpeg");
    assert_eq!(
        s.asset_path(&p.asset_id).unwrap().extension().unwrap(),
        "jpg"
    );
}

#[test]
fn remove_only_draft_use_preserves_formal_shared_and_orphan_assets() {
    let tmp = Temp::new("remove");
    let mut s = Store::open(tmp.path()).unwrap();
    let a = new_row(&mut s);
    let b = new_row(&mut s);
    let p = s
        .attach_photo_bytes(&a, "s.png", b"synthetic", "a", None)
        .unwrap();
    s.attach_photo_bytes(&b, "s.png", b"synthetic", "b", None)
        .unwrap();
    s.commit(&a, 0).unwrap();
    s.create_draft(Some(&a), "", "", "", None).unwrap();
    let formal = s.row(&a).unwrap().formal.clone();
    let row = s.remove_draft_photo(&a, &p.photo_use_id).unwrap();
    assert!(row.draft.unwrap().photos.is_empty());
    assert_eq!(row.formal, formal);
    assert_eq!(s.row(&b).unwrap().draft.as_ref().unwrap().photos.len(), 1);
    s.discard_draft(&b).unwrap();
    assert_eq!(
        fs::read(s.asset_path(&p.asset_id).unwrap()).unwrap(),
        b"synthetic"
    );
    assert_eq!(
        Store::open(tmp.path()).unwrap().row(&a).unwrap().formal,
        formal
    );
}

#[test]
fn missing_use_and_no_draft_leave_state_unchanged() {
    let tmp = Temp::new("missing-use");
    let mut s = Store::open(tmp.path()).unwrap();
    let id = new_row(&mut s);
    for committed in [false, true] {
        if committed {
            s.commit(&id, 0).unwrap();
        }
        let before = s.state_json().dump();
        let disk = fs::read(tmp.path().join("state.json")).unwrap();
        assert_eq!(
            s.remove_draft_photo(&id, "missing").unwrap_err().code,
            "PHOTO_USE_NOT_FOUND"
        );
        assert_unchanged(&s, &before, &disk);
    }
}

#[test]
fn discard_pure_draft_removes_row_and_formal_draft_keeps_formal() {
    let tmp = Temp::new("discard");
    let mut s = Store::open(tmp.path()).unwrap();
    let a = new_row(&mut s);
    let b = new_row(&mut s);
    let p = s
        .attach_photo_bytes(&a, "s.png", b"synthetic", "", None)
        .unwrap();
    assert!(s.discard_draft(&a).unwrap().is_none());
    assert!(s.row(&a).is_err());
    s.commit(&b, 0).unwrap();
    let formal = s.row(&b).unwrap().formal.clone();
    s.save_draft(&b, None, Some("修改"), None, None).unwrap();
    let row = s.discard_draft(&b).unwrap().unwrap();
    assert!(row.draft.is_none());
    assert_eq!(row.formal, formal);
    assert_eq!(row.content_revision, 1);
    assert_eq!(row.base_revision, 1);
    assert!(s.list_drafts().is_empty());
    assert!(s.asset_path(&p.asset_id).unwrap().exists());
    let before = s.state_json().dump();
    let disk = fs::read(tmp.path().join("state.json")).unwrap();
    assert_eq!(s.discard_draft("missing").unwrap_err().code, "NOT_FOUND");
    assert_unchanged(&s, &before, &disk);
}

#[test]
fn corrupt_state_blocks_all_new_mutations() {
    let tmp = Temp::new("corrupt");
    let mut s = Store::open(tmp.path()).unwrap();
    let id = new_row(&mut s);
    let before = s.state_json().dump();
    fs::write(tmp.path().join("state.json"), b"{broken").unwrap();
    assert_eq!(
        s.attach_photo_bytes(&id, "s.png", b"synthetic", "", None)
            .unwrap_err()
            .code,
        "STATE_CORRUPT"
    );
    assert_eq!(
        s.remove_draft_photo(&id, "missing").unwrap_err().code,
        "STATE_CORRUPT"
    );
    assert_eq!(s.discard_draft(&id).unwrap_err().code, "STATE_CORRUPT");
    assert_eq!(s.state_json().dump(), before);
    assert_eq!(fs::read(tmp.path().join("state.json")).unwrap(), b"{broken");
    assert_eq!(fs::read_dir(tmp.path().join("media")).unwrap().count(), 0);
}

#[cfg(feature = "fault-injection")]
#[test]
fn new_mutations_persist_failure_keep_state_and_existing_assets() {
    use shiguang_core::fault::{self, FaultPoint};
    let tmp = Temp::new("fault");
    let mut s = Store::open(tmp.path()).unwrap();
    let id = new_row(&mut s);
    let p = s
        .attach_photo_bytes(&id, "s.png", b"synthetic", "", None)
        .unwrap();
    let before = s.state_json().dump();
    let disk = fs::read(tmp.path().join("state.json")).unwrap();
    let durability = s.last_durability().clone();
    for point in [
        FaultPoint::TempCreate,
        FaultPoint::TempWrite,
        FaultPoint::TempSync,
        FaultPoint::Replace,
    ] {
        fault::set(point);
        assert!(s
            .attach_photo_bytes(&id, "s.png", b"synthetic", "second", None)
            .is_err());
        assert!(s.remove_draft_photo(&id, &p.photo_use_id).is_err());
        assert!(s.discard_draft(&id).is_err());
        fault::clear();
        assert_unchanged(&s, &before, &disk);
        assert_eq!(s.last_durability(), &durability);
        assert_eq!(
            fs::read(s.asset_path(&p.asset_id).unwrap()).unwrap(),
            b"synthetic"
        );
        assert_eq!(
            fs::read_dir(tmp.path())
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with(".tmp-"))
                .count(),
            0
        );
    }
}

#[cfg(feature = "fault-injection")]
#[test]
fn new_mutations_expose_uncertain_after_replace() {
    use shiguang_core::fault::{self, FaultPoint};
    let tmp = Temp::new("uncertain");
    let mut s = Store::open(tmp.path()).unwrap();
    let id = new_row(&mut s);
    fault::set(FaultPoint::ParentSync);
    let p = s
        .attach_photo_bytes(&id, "s.png", b"synthetic", "", None)
        .unwrap();
    assert_eq!(s.last_durability().as_str(), "uncertain");
    s.remove_draft_photo(&id, &p.photo_use_id).unwrap();
    assert_eq!(s.last_durability().as_str(), "uncertain");
    s.discard_draft(&id).unwrap();
    assert_eq!(s.last_durability().as_str(), "uncertain");
    fault::clear();
    assert!(Store::open(tmp.path()).unwrap().list_drafts().is_empty());
    assert!(s.asset_path(&p.asset_id).unwrap().exists());
}

#[test]
fn attach_to_formal_materializes_draft_without_changing_formal_or_base() {
    let tmp = Temp::new("formal-attach");
    let mut s = Store::open(tmp.path()).unwrap();
    let id = new_row(&mut s);
    s.commit(&id, 0).unwrap();
    let formal = s.row(&id).unwrap().formal.clone();
    s.attach_photo_bytes(&id, "synthetic.jpg", b"synthetic-photo", "合成", None)
        .unwrap();
    let row = s.row(&id).unwrap();
    assert_eq!(row.formal, formal);
    assert_eq!(row.content_revision, 1);
    assert_eq!(row.base_revision, 1);
    assert_eq!(row.draft.as_ref().unwrap().photos.len(), 1);
    assert_eq!(
        row.draft.as_ref().unwrap().photos[0].media_type,
        "image/jpeg"
    );
    assert_eq!(s.commit(&id, 1).unwrap().content_revision, 2);
}

#[test]
fn conflicting_existing_asset_never_changes_state_or_original_bytes() {
    let tmp = Temp::new("asset-conflict");
    let mut s = Store::open(tmp.path()).unwrap();
    let id = new_row(&mut s);
    let p = s
        .attach_photo_bytes(&id, "s.png", b"synthetic", "", None)
        .unwrap();
    let path = s.asset_path(&p.asset_id).unwrap();
    fs::write(&path, b"synthetic-tampered").unwrap();
    let before = s.state_json().dump();
    let disk = fs::read(tmp.path().join("state.json")).unwrap();
    assert_eq!(
        s.attach_photo_bytes(&id, "s.png", b"synthetic", "second", None)
            .unwrap_err()
            .code,
        "ASSET_CONFLICT"
    );
    assert_unchanged(&s, &before, &disk);
    assert_eq!(fs::read(&path).unwrap(), b"synthetic-tampered");
}
