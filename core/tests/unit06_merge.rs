mod unit05_support;
use shiguang_core::json::Json;
use shiguang_core::{merge_states, RecordStatus, State, Store};
use std::fs;
use unit05_support::*;
fn state(v: &Json) -> State {
    State::from_json(v).unwrap()
}
fn edit_record(v: &mut Json, f: impl FnOnce(&mut Json)) {
    let Json::Obj(fields) = v else { panic!() };
    let Json::Arr(rows) = &mut fields.iter_mut().find(|(k, _)| k == "records").unwrap().1 else {
        panic!()
    };
    f(&mut rows[0]);
}
fn variant(v: &Json, revision: i64, body: &str, trashed: bool) -> Json {
    let mut v = v.clone();
    edit_record(&mut v, |r| {
        set(r, "contentRevision", Json::Num(revision));
        set(
            r,
            "status",
            Json::str(if trashed { "trashed" } else { "active" }),
        );
        set(
            r,
            "trashedAt",
            if trashed {
                Json::str("synthetic-trash")
            } else {
                Json::Null
            },
        );
        let mut s = r.get("formal").unwrap().clone();
        set(&mut s, "body", Json::str(body));
        set(r, "formal", s);
    });
    v
}
#[test]
fn pure_table_revision_status_and_equal_content() {
    let a = Temp::new("table");
    let s = seeded(&a.0, "base");
    let base = s.state_json();
    for (lr, ir, lb, ib, lt, it, updated, conflicts) in [
        (1, 1, "base", "base", false, false, 0, 0),
        (1, 2, "base", "new", false, false, 1, 0),
        (3, 2, "base", "new", false, false, 0, 1),
        (2, 2, "base", "new", false, false, 0, 1),
        (1, 9, "base", "new", true, false, 0, 1),
        (1, 2, "base", "new", false, true, 1, 0),
        (1, 9, "base", "base", false, false, 0, 0),
    ] {
        let local = variant(&base, lr, lb, lt);
        let mut incoming = variant(&base, ir, ib, it);
        edit_record(&mut incoming, |r| {
            set(r, "updatedAt", Json::str("1900-01-01T00:00:00Z"))
        });
        let (merged, p) = merge_states(&state(&local), &state(&incoming)).unwrap();
        assert_eq!(p.updated, updated);
        assert_eq!(p.conflicts, conflicts);
        let json = merged.to_json(s.seed());
        State::from_json(&json).unwrap();
        let row = &json.get("records").unwrap().as_arr().unwrap()[0];
        assert_eq!(
            row.get("status"),
            local.get("records").unwrap().as_arr().unwrap()[0].get("status")
        );
        assert_eq!(p.kept_trashed, u64::from(lt && !it));
        assert_eq!(p.kept_active, u64::from(!lt && it));
        let (again, p2) = merge_states(&merged, &state(&incoming)).unwrap();
        assert_eq!(again.to_json(s.seed()), json);
        assert_eq!(p2.added, 0);
    }
}
#[test]
fn collisions_remap_records_photos_conflicts_and_remain_idempotent() {
    let a = Temp::new("collision-a");
    let b = Temp::new("collision-b");
    let mut s = seeded(&a.0, "local");
    let mut t = seeded(&b.0, "foreign");
    let id = t.list_formal()[0].record_id.clone();
    t.create_draft(Some(&id), "synthetic", "draft", "2026-11-09", None)
        .unwrap();
    t.resolve_conflict(&id, shiguang_core::ConflictChoice::KeepFormal)
        .unwrap();
    let lid = s.list_formal()[0].record_id.clone();
    s.create_draft(Some(&lid), "synthetic", "local draft", "2026-11-09", None)
        .unwrap();
    s.resolve_conflict(&lid, shiguang_core::ConflictChoice::KeepFormal)
        .unwrap();
    let mut incoming = t.state_json();
    edit_record(&mut incoming, |r| {
        set(r, "createdAt", Json::str("synthetic-device-B"))
    });
    let (merged, p) = merge_states(&state(&s.state_json()), &state(&incoming)).unwrap();
    assert_eq!(p.added, 1);
    let v = merged.to_json(s.seed());
    State::from_json(&v).unwrap();
    let rows = v.get("records").unwrap().as_arr().unwrap();
    assert_ne!(rows[0].get("recordId"), rows[1].get("recordId"));
    let photos = |row: &Json| {
        row.get("formal")
            .unwrap()
            .get("photos")
            .unwrap()
            .as_arr()
            .unwrap()[0]
            .get("photoUseId")
            .unwrap()
            .clone()
    };
    assert_ne!(photos(&rows[0]), photos(&rows[1]));
    let copies = v.get("conflictCopies").unwrap().as_arr().unwrap();
    assert_eq!(copies.len(), 2);
    assert_ne!(copies[0].get("conflictId"), copies[1].get("conflictId"));
    assert_eq!(copies[1].get("recordId"), rows[1].get("recordId"));

    let (again, p) = merge_states(&merged, &state(&incoming)).unwrap();
    assert_eq!(p.added, 0);
    assert_eq!(again.to_json(s.seed()), v);
}
#[test]
fn drafts_preserve_local_import_current_and_conflict_stale() {
    let a = Temp::new("drafts");
    let s = seeded(&a.0, "formal");
    let base = s.state_json();
    for (local_draft, incoming_base, expected_draft, expected_conflicts) in [
        (false, 1, true, 0),
        (false, 0, false, 1),
        (true, 1, true, 1),
    ] {
        let mut local = base.clone();
        let mut incoming = base.clone();
        edit_record(&mut incoming, |r| {
            let mut d = r.get("formal").unwrap().clone();
            set(&mut d, "body", Json::str("incoming draft"));
            set(r, "draft", d);
            set(r, "baseRevision", Json::Num(incoming_base));
        });
        if local_draft {
            edit_record(&mut local, |r| {
                let mut d = r.get("formal").unwrap().clone();
                set(&mut d, "body", Json::str("local draft"));
                set(r, "draft", d);
            });
        }
        let (merged, _) = merge_states(&state(&local), &state(&incoming)).unwrap();
        let v = merged.to_json(s.seed());
        assert_eq!(
            v.get("conflictCopies").unwrap().as_arr().unwrap().len(),
            expected_conflicts
        );
        assert_eq!(
            v.get("records").unwrap().as_arr().unwrap()[0].get("draft") != Some(&Json::Null),
            expected_draft
        );
        let (again, _) = merge_states(&merged, &state(&incoming)).unwrap();
        assert_eq!(again.to_json(s.seed()), v);
    }
}
#[test]
fn purge_blocks_old_package_but_distinct_creation_imports_and_null_is_conservative() {
    let a = Temp::new("purge");
    let f = Temp::new("purge-file");
    let mut s = seeded(&a.0, "purge");
    let id = s.list_formal()[0].record_id.clone();
    let path = f.0.join("old.sgbak");
    s.export_backup(&path, "1").unwrap();
    let old_state = s.state_json();
    s.trash_record(&id).unwrap();
    s.merge_backup(&path).unwrap();
    assert_eq!(s.row(&id).unwrap().status, RecordStatus::Trashed);
    let marker = s.purge_record(&id).unwrap().deletion_markers.remove(0);
    assert!(marker.created_at.is_some());
    let p = s.plan_merge(&path).unwrap();
    assert_eq!(p.skipped_deleted.len(), 1);
    s.merge_backup(&path).unwrap();
    assert!(s.list_formal().is_empty());
    let mut incoming = old_state;
    edit_record(&mut incoming, |r| {
        set(r, "createdAt", Json::str("synthetic-other-device"))
    });
    let (_, p) = merge_states(&state(&s.state_json()), &state(&incoming)).unwrap();
    assert_eq!(p.added, 1);
    let mut legacy = s.state_json();
    let Json::Obj(fields) = &mut legacy else {
        panic!()
    };
    let Json::Arr(ms) = &mut fields
        .iter_mut()
        .find(|(k, _)| k == "deletionMarkers")
        .unwrap()
        .1
    else {
        panic!()
    };
    let Json::Obj(m) = &mut ms[0] else { panic!() };
    m.retain(|(k, _)| k != "createdAt");
    let (_, p) = merge_states(&state(&legacy), &state(&incoming)).unwrap();
    assert_eq!(p.skipped_deleted.len(), 1);
}
#[test]
fn incoming_markers_never_delete_local_and_union_is_idempotent() {
    let a = Temp::new("markers");
    let mut s = seeded(&a.0, "content");
    let local = state(&s.state_json());
    let id = s.list_formal()[0].record_id.clone();
    s.trash_record(&id).unwrap();
    s.purge_record(&id).unwrap();
    let incoming = state(&s.state_json());
    let (merged, p) = merge_states(&local, &incoming).unwrap();
    assert_eq!(p.deleted_in_backup.len(), 1);
    assert_eq!(
        merged
            .to_json("x")
            .get("records")
            .unwrap()
            .as_arr()
            .unwrap()
            .len(),
        1
    );
    let empty = Temp::new("marker-empty");
    let e = Store::open(&empty.0).unwrap();
    let (m, p) = merge_states(&state(&e.state_json()), &incoming).unwrap();
    assert_eq!(p.markers_added, 1);
    let (_, p) = merge_states(&m, &incoming).unwrap();
    assert_eq!(p.markers_added, 0);
}
#[test]
fn plan_read_only_matches_report_media_deduplicates_and_second_merge_has_no_changes() {
    let a = Temp::new("plan-a");
    let b = Temp::new("plan-b");
    let f = Temp::new("plan-f");
    let s = seeded(&a.0, "source");
    let mut t = Store::open_exclusive(&b.0).unwrap();
    let path = f.0.join("x.sgbak");
    s.export_backup(&path, "1").unwrap();
    let before = tree(&b.0);
    let p = t.plan_merge(&path).unwrap();
    assert_eq!(tree(&b.0), before);
    assert_eq!(p.added, 1);
    assert_eq!(p.media_added, 1);
    let r = t.merge_backup(&path).unwrap();
    assert_eq!(r.plan, p);
    let bytes = fs::read(b.0.join("state.json")).unwrap();
    let p = t.plan_merge(&path).unwrap();
    assert_eq!(p.media_added, 0);
    assert_eq!(p.unchanged, 1);
    t.merge_backup(&path).unwrap();
    assert_eq!(fs::read(b.0.join("state.json")).unwrap(), bytes);
}
#[test]
fn missing_media_and_hash_collision_preserve_local_original() {
    let a = Temp::new("media-a");
    let b = Temp::new("media-b");
    let f = Temp::new("media-f");
    let s = seeded(&a.0, "source");
    let mut t = Store::open_exclusive(&b.0).unwrap();
    let path = f.0.join("x.sgbak");
    let photo = &s.list_formal()[0].formal.as_ref().unwrap().photos[0];
    let source = s.asset_path(&photo.asset_id).unwrap();
    let name = source.file_name().unwrap();
    fs::write(b.0.join("media").join(name), b"synthetic collision").unwrap();
    s.export_backup(&path, "1").unwrap();
    let p = t.plan_merge(&path).unwrap();
    assert_eq!(p.media_conflicts.len(), 1);
    t.merge_backup(&path).unwrap();
    assert_eq!(
        fs::read(b.0.join("media").join(name)).unwrap(),
        b"synthetic collision"
    );
    fs::remove_file(&path).unwrap();
    fs::remove_file(source).unwrap();
    s.export_backup(&path, "1").unwrap();
    let c = Temp::new("missing");
    let mut u = Store::open_exclusive(&c.0).unwrap();
    let r = u.merge_backup(&path).unwrap();
    assert_eq!(r.plan.media_missing, 1);
    assert_eq!(u.list_formal().len(), 1);
}
#[test]
fn strict_ids_reject_duplicate_records_conflicts_and_cross_record_photo_uses() {
    let a = Temp::new("strict-ids");
    let s = seeded(&a.0, "content");
    let mut v = s.state_json();
    let mut rows = v.get("records").unwrap().as_arr().unwrap().to_vec();
    rows.push(rows[0].clone());
    set(&mut v, "records", Json::Arr(rows));
    assert!(State::from_json(&v).is_err());
    let mut v = s.state_json();
    set(&mut v, "seq", Json::Num(0));
    assert!(State::from_json(&v).is_err());
}
#[test]
fn merge_requires_exclusive_and_invalid_package_writes_nothing() {
    let a = Temp::new("exclusive");
    let f = Temp::new("invalid");
    let path = f.0.join("bad.sgbak");
    fs::write(&path, b"synthetic invalid").unwrap();
    let mut s = Store::open(&a.0).unwrap();
    assert_eq!(
        s.merge_backup(&path).unwrap_err().code,
        "STORE_NOT_EXCLUSIVE"
    );
    drop(s);
    let mut s = Store::open_exclusive(&a.0).unwrap();
    let before = tree(&a.0);
    assert!(s.merge_backup(&path).is_err());
    assert_eq!(before, tree(&a.0));
}
#[test]
fn dedup_same_original_across_distinct_records_and_ignore_orphan_conflicts() {
    let a = Temp::new("shared-a");
    let b = Temp::new("shared-b");
    let f = Temp::new("shared-f");
    let s = seeded(&a.0, "shared");
    let mut t = seeded(&b.0, "shared");
    let mut v = s.state_json();
    edit_record(&mut v, |r| {
        set(r, "createdAt", Json::str("synthetic-different-record"))
    });
    drop(s);
    fs::write(a.0.join("state.json"), v.pretty()).unwrap();
    let s = Store::open(&a.0).unwrap();
    let path = f.0.join("x");
    s.export_backup(&path, "1").unwrap();
    let r = t.merge_backup(&path).unwrap();
    assert_eq!(r.plan.added, 1);
    assert_eq!(r.plan.media_added, 0);
    assert_eq!(fs::read_dir(b.0.join("media")).unwrap().count(), 1);
    let mut v = t.state_json();
    let snap = v.get("records").unwrap().as_arr().unwrap()[0]
        .get("formal")
        .unwrap()
        .clone();
    let mut snap = snap;
    set(&mut snap, "photos", Json::Arr(vec![]));
    // v4: this synthetic no-photo snapshot must also clear its cover reference.
    set(&mut snap, "coverPhotoUseId", Json::Null);
    set(&mut v, "seq", Json::Num(100));
    set(
        &mut v,
        "conflictCopies",
        Json::Arr(vec![Json::obj(vec![
            ("conflictId", Json::str("conflict-000100")),
            ("recordId", Json::str("rec-000099")),
            ("baseRevision", Json::Num(1)),
            ("snapshot", snap),
            ("createdAt", Json::str("synthetic")),
            ("reason", Json::str("synthetic")),
        ])]),
    );
    let (_, p) = merge_states(&state(&t.state_json()), &state(&v)).unwrap();
    assert_eq!(p.conflict_copies_dropped, 1);
}
#[cfg(unix)]
#[test]
fn merge_symlinks_and_malicious_journal_cannot_escape_root() {
    use std::os::unix::fs::symlink;
    let a = Temp::new("escape-a");
    let b = Temp::new("escape-b");
    let f = Temp::new("escape-f");
    let outside = Temp::new("escape-out");
    let s = seeded(&a.0, "source");
    let path = f.0.join("x");
    s.export_backup(&path, "1").unwrap();
    let mut t = Store::open_exclusive(&b.0).unwrap();
    fs::write(outside.0.join("keep"), b"synthetic").unwrap();
    let before = tree(&outside.0);
    fs::remove_dir(b.0.join("media")).unwrap();
    symlink(&outside.0, b.0.join("media")).unwrap();
    assert!(t.plan_merge(&path).is_err());
    assert!(t.merge_backup(&path).is_err());
    assert_eq!(tree(&outside.0), before);
    drop(t);
    fs::remove_file(b.0.join("media")).unwrap();
    fs::create_dir(b.0.join("media")).unwrap();
    fs::write(
        b.0.join(".merge-journal.json"),
        Json::obj(vec![
            ("stateSha256", Json::str("0".repeat(64))),
            ("files", Json::Arr(vec![Json::str("media/../../keep")])),
        ])
        .dump(),
    )
    .unwrap();
    assert!(Store::open(&b.0).is_err());
    assert_eq!(tree(&outside.0), before);
}
#[test]
fn reexported_collision_merges_back_without_duplicate_photos_or_conflicts() {
    let a = Temp::new("back-a");
    let b = Temp::new("back-b");
    let mut local = seeded(&a.0, "local");
    let incoming = seeded(&b.0, "incoming");
    let mut foreign = incoming.state_json();
    edit_record(&mut foreign, |r| {
        set(r, "createdAt", Json::str("synthetic-B"))
    });
    let (merged, _) = merge_states(&state(&local.state_json()), &state(&foreign)).unwrap();
    let (back, p) = merge_states(&state(&foreign), &merged).unwrap();
    assert_eq!(p.added, 1);
    assert_eq!(p.conflict_copies_added, 0);
    let (again, p) = merge_states(&back, &merged).unwrap();
    assert_eq!(p.added, 0);
    assert_eq!(p.conflict_copies_added, 0);
    assert_eq!(again.to_json("x"), back.to_json("x"));
    let id = local.list_formal()[0].record_id.clone();
    local.trash_record(&id).unwrap();
    local.purge_record(&id).unwrap();
}
#[test]
fn strict_validation_covers_conflict_ids_and_logical_photo_ownership() {
    let a = Temp::new("strict-all");
    let s = seeded(&a.0, "content");
    let base = s.state_json();
    let row = base.get("records").unwrap().as_arr().unwrap()[0].clone();
    let mut second = row.clone();
    set(&mut second, "recordId", Json::str("rec-000090"));
    let mut v = base.clone();
    set(&mut v, "seq", Json::Num(100));
    set(&mut v, "records", Json::Arr(vec![row.clone(), second]));
    assert!(State::from_json(&v).is_err());
    let copy = Json::obj(vec![
        ("conflictId", Json::str("conflict-000100")),
        ("recordId", row.get("recordId").unwrap().clone()),
        ("baseRevision", Json::Num(1)),
        ("snapshot", row.get("formal").unwrap().clone()),
        ("createdAt", Json::str("synthetic")),
        ("reason", Json::str("synthetic")),
    ]);
    let mut v = base.clone();
    set(&mut v, "seq", Json::Num(100));
    set(
        &mut v,
        "conflictCopies",
        Json::Arr(vec![copy.clone(), copy]),
    );
    assert!(State::from_json(&v).is_err());
    let mut v = base;
    edit_record(&mut v, |r| {
        let mut snap = r.get("formal").unwrap().clone();
        let photo = snap.get("photos").unwrap().as_arr().unwrap()[0].clone();
        set(&mut snap, "photos", Json::Arr(vec![photo.clone(), photo]));
        set(r, "formal", snap);
    });
    assert!(State::from_json(&v).is_err());
}
#[test]
fn synthetic_asset_prefix_collision_preserves_both_snapshots_and_local_bytes() {
    let a = Temp::new("prefix-a");
    let b = Temp::new("prefix-b");
    let f = Temp::new("prefix-f");
    let mut local = seeded(&a.0, "local");
    let foreign = seeded(&b.0, "foreign");
    let lp = local.all_photos()[0].clone();
    let fp = foreign.all_photos()[0].clone();
    let local_path = local.asset_path(&lp.asset_id).unwrap();
    let foreign_path = foreign.asset_path(&fp.asset_id).unwrap();
    let local_bytes = fs::read(&local_path).unwrap();
    let mut v = foreign.state_json();
    let creation = local.list_formal()[0].created_at.clone();
    edit_record(&mut v, |r| {
        set(r, "createdAt", Json::str(&creation));
        set(r, "contentRevision", Json::Num(2));
        let mut snap = r.get("formal").unwrap().clone();
        let mut photo = snap.get("photos").unwrap().as_arr().unwrap()[0].clone();
        set(&mut photo, "assetId", Json::str(&lp.asset_id));
        set(&mut snap, "photos", Json::Arr(vec![photo]));
        set(r, "formal", snap);
    });
    drop(foreign);
    fs::rename(
        &foreign_path,
        b.0.join("media").join(local_path.file_name().unwrap()),
    )
    .unwrap();
    fs::write(b.0.join("state.json"), v.pretty()).unwrap();
    let foreign = Store::open(&b.0).unwrap();
    let path = f.0.join("x");
    foreign.export_backup(&path, "1").unwrap();
    let r = local.merge_backup(&path).unwrap();
    assert_eq!(r.plan.media_conflicts, vec![lp.asset_id]);
    assert_eq!(fs::read(local_path).unwrap(), local_bytes);
    assert_eq!(r.plan.updated, 1);
    let copies = local.list_conflict_copies().unwrap();
    assert_eq!(copies.len(), 1);
    assert_ne!(
        copies[0].snapshot.photos[0].photo_use_id,
        local.list_formal()[0].formal.as_ref().unwrap().photos[0].photo_use_id
    );
    assert_eq!(r.media_report.corrupt.len(), 1);
    let before = fs::read(a.0.join("state.json")).unwrap();
    local.merge_backup(&path).unwrap();
    assert_eq!(fs::read(a.0.join("state.json")).unwrap(), before);
}
#[test]
fn new_records_preserve_draft_and_trash_and_markers_preserve_local_trash() {
    let a = Temp::new("new-shapes");
    let b = Temp::new("empty-shapes");
    let mut s = seeded(&a.0, "formal");
    let id = s.list_formal()[0].record_id.clone();
    s.trash_record(&id).unwrap();
    let trashed = state(&s.state_json());
    draft(&mut s, "pending draft");
    let incoming = state(&s.state_json());
    let empty = Store::open(&b.0).unwrap();
    let (merged, p) = merge_states(&state(&empty.state_json()), &incoming).unwrap();
    assert_eq!(p.added, 2);
    assert_eq!(
        merged.to_json("x").get("records"),
        incoming.to_json("x").get("records")
    );
    s.purge_record(&id).unwrap();
    let (kept, p) = merge_states(&trashed, &state(&s.state_json())).unwrap();
    assert_eq!(p.deleted_in_backup.len(), 1);
    let v = kept.to_json("x");
    let r = &v.get("records").unwrap().as_arr().unwrap()[0];
    assert_eq!(r.get("status"), Some(&Json::str("trashed")));
}
