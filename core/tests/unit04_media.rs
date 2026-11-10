mod unit04_support;
use shiguang_core::{PhotoStatus, Store};
use std::fs;
use unit04_support::*;

#[test]
fn reconciliation_requires_exclusive_instance_and_does_not_touch_files() {
    let t = TempRoot::new("media-not-exclusive");
    let mut s = Store::open(t.path()).unwrap();
    draft(&mut s);
    fs::write(t.path().join("media/orphan.png"), png()).unwrap();
    let before = tree(t.path());
    assert_eq!(s.reconcile_media().unwrap_err().code, "STORE_NOT_EXCLUSIVE");
    assert_eq!(tree(t.path()), before);
}
#[test]
fn orphan_and_partial_originals_move_to_quarantine_with_identical_sha() {
    let t = TempRoot::new("media-orphan");
    let mut s = Store::open_exclusive(t.path()).unwrap();
    draft(&mut s);
    let image = png();
    fs::write(t.path().join("media/ast-orphan.png"), &image).unwrap();
    fs::write(t.path().join("media/.tmp-half"), b"synthetic partial").unwrap();
    fs::write(t.path().join("previews/orphan.preview.png"), &image).unwrap();
    let state = t.bytes();
    let report = s.reconcile_media().unwrap();
    assert_eq!(report.quarantined.len(), 2);
    assert!(!report.checked_at.is_empty());
    assert!(report.missing.is_empty());
    assert!(report.corrupt.is_empty());
    for item in &report.quarantined {
        let name = std::path::Path::new(&item.file).file_name().unwrap();
        let expected: &[u8] = if name == ".tmp-half" {
            b"synthetic partial"
        } else {
            &image
        };
        let target = moved(t.path(), &item.moved_to);
        assert!(target.starts_with(t.path().join("media-quarantine")));
        assert_eq!(
            shiguang_core::sha256::hex_digest(&fs::read(&target).unwrap()),
            shiguang_core::sha256::hex_digest(expected)
        );
        assert!(!t.path().join("media").join(name).exists());
    }
    assert_eq!(t.bytes(), state);
    assert!(t.path().join("previews/orphan.preview.png").exists());
    assert!(s.reconcile_media().unwrap().quarantined.is_empty());
    drop(s);
    let mut s = Store::open_exclusive(t.path()).unwrap();
    assert!(s.reconcile_media().unwrap().quarantined.is_empty());
    for item in report.quarantined {
        assert!(moved(t.path(), &item.moved_to).exists());
    }
}
fn damaged(kind: &str) {
    let t = TempRoot::new(kind);
    let mut s = Store::open_exclusive(t.path()).unwrap();
    let id = draft(&mut s);
    let image = png();
    let p = s
        .attach_photo_bytes(&id, "s.png", &image, "合成说明", None)
        .unwrap();
    s.commit(&id, 0).unwrap();
    let path = s.asset_path(&p.asset_id).unwrap();
    match kind {
        "missing" => fs::remove_file(path).unwrap(),
        "size" => fs::write(path, b"synthetic truncated").unwrap(),
        "hash" => {
            let mut changed = image;
            changed[0] ^= 1;
            fs::write(path, changed).unwrap();
        }
        _ => unreachable!(),
    }
    let before = t.bytes();
    let report = s.reconcile_media().unwrap();
    let issues = if kind == "missing" {
        assert!(report.corrupt.is_empty());
        &report.missing
    } else {
        assert!(report.missing.is_empty());
        &report.corrupt
    };
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].record_id, id);
    assert_eq!(issues[0].photo_use_id, p.photo_use_id);
    assert_eq!(issues[0].asset_id, p.asset_id);
    assert!(report.quarantined.is_empty());
    assert_eq!(t.bytes(), before);
    assert_eq!(
        s.photo_status(&p.asset_id).unwrap(),
        if kind == "missing" {
            PhotoStatus::Missing
        } else {
            PhotoStatus::Corrupt
        }
    );
}
#[test]
fn referenced_missing_original_is_reported_without_record_mutation() {
    damaged("missing");
}
#[test]
fn referenced_wrong_size_is_reported_as_corrupt() {
    damaged("size");
}
#[test]
fn referenced_same_size_wrong_sha_is_reported_as_corrupt() {
    damaged("hash");
}
#[test]
fn references_in_formal_draft_and_trash_are_never_quarantined() {
    let t = TempRoot::new("media-live-references");
    let mut s = Store::open_exclusive(t.path()).unwrap();
    let mut assets = Vec::new();
    for (index, kind) in ["formal", "draft", "trash"].iter().enumerate() {
        let id = draft(&mut s);
        let image = shiguang_core::preview::preview_bytes(&format!("synthetic-{index}"));
        let p = s
            .attach_photo_bytes(&id, "s.png", &image, "", None)
            .unwrap();
        if *kind != "draft" {
            s.commit(&id, 0).unwrap();
        }
        if *kind == "trash" {
            s.trash_record(&id).unwrap();
        }
        assets.push(p.asset_id);
    }
    let report = s.reconcile_media().unwrap();
    assert!(report.quarantined.is_empty());
    assert!(report.missing.is_empty());
    assert!(report.corrupt.is_empty());
    for id in assets {
        assert!(s.asset_path(&id).unwrap().exists());
        assert_eq!(s.photo_status(&id).unwrap(), PhotoStatus::Available);
    }
}
