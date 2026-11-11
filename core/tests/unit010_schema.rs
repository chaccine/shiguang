//! Task A: frozen v3 compatibility and v4 content semantics (synthetic only).
mod unit05_support;
use shiguang_core::{
    backup,
    json::{self, Json},
    DraftPatch, KdfParams, Mood, Snapshot, Store, CURRENT_SCHEMA_VERSION,
};
use std::{
    fs,
    path::{Path, PathBuf},
};
use unit05_support::*;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/v3")
        .join(name)
}
fn copy_v3(root: &Path) {
    fs::create_dir_all(root.join("media")).unwrap();
    fs::copy(fixture("state.json"), root.join("state.json")).unwrap();
    for e in fs::read_dir(fixture("media")).unwrap() {
        let e = e.unwrap();
        fs::copy(e.path(), root.join("media").join(e.file_name())).unwrap();
    }
}
fn old_value() -> Json {
    json::parse(&fs::read_to_string(fixture("state.json")).unwrap()).unwrap()
}
fn remove(v: &mut Json, keys: &[&str]) {
    let Json::Obj(f) = v else { panic!() };
    f.retain(|(k, _)| !keys.contains(&k.as_str()));
}
fn strip_v4(mut v: Json) -> Json {
    remove(&mut v, &["settings"]);
    let Json::Obj(top) = &mut v else { panic!() };
    for (k, value) in top.iter_mut() {
        if k == "records" {
            let Json::Arr(rows) = value else { panic!() };
            for row in rows {
                let Json::Obj(fields) = row else { panic!() };
                for (k, s) in fields {
                    if (k == "draft" || k == "formal") && *s != Json::Null {
                        remove(s, &["location", "mood", "coverPhotoUseId"]);
                    }
                }
            }
        }
        if k == "conflictCopies" {
            let Json::Arr(copies) = value else { panic!() };
            for copy in copies {
                let Json::Obj(fields) = copy else { panic!() };
                for (k, s) in fields {
                    if k == "snapshot" {
                        remove(s, &["location", "mood", "coverPhotoUseId"]);
                    }
                }
            }
        }
    }
    set(&mut v, "schemaVersion", Json::Num(3));
    // Object field order is irrelevant for compatibility assertions.
    canonical(v)
}
fn canonical(v: Json) -> Json {
    match v {
        Json::Obj(f) => {
            let mut f: Vec<_> = f.into_iter().map(|(k, v)| (k, canonical(v))).collect();
            f.sort_by(|a, b| a.0.cmp(&b.0));
            Json::Obj(f)
        }
        Json::Arr(a) => Json::Arr(a.into_iter().map(canonical).collect()),
        v => v,
    }
}
fn defaults(s: &Store) {
    assert_eq!(s.state_json().get("schemaVersion"), Some(&Json::Num(4)));
    assert_eq!(
        s.state_json().get("settings").unwrap().get("theme"),
        Some(&Json::str("system"))
    );
    for r in s.state_json().get("records").unwrap().as_arr().unwrap() {
        for slot in ["formal", "draft"] {
            let snap = r.get(slot).unwrap();
            if *snap == Json::Null {
                continue;
            }
            let snap = Snapshot::from_json(snap).unwrap();
            assert_eq!(snap.location, "");
            assert_eq!(snap.mood, None);
            assert_eq!(snap.cover(), snap.photos.first());
            assert!(snap.photos.iter().all(|p| p.caption == "合成说明"));
        }
    }
}
fn lossless(s: &Store) {
    defaults(s);
    assert_eq!(strip_v4(s.state_json()), canonical(old_value()));
}
#[test]
fn frozen_v3_state_migrates_losslessly_once_and_keeps_exact_original() {
    assert_eq!(CURRENT_SCHEMA_VERSION, 4);
    let t = Temp::new("u010-migrate");
    copy_v3(&t.0);
    let original = fs::read(t.0.join("state.json")).unwrap();
    let s = Store::open_exclusive(&t.0).unwrap();
    lossless(&s);
    let backups: Vec<_> = fs::read_dir(t.0.join("backups"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(fs::read(&backups[0]).unwrap(), original);
    let disk = fs::read(t.0.join("state.json")).unwrap();
    drop(s);
    let s = Store::open_exclusive(&t.0).unwrap();
    lossless(&s);
    assert_eq!(fs::read(t.0.join("state.json")).unwrap(), disk);
    assert_eq!(fs::read_dir(t.0.join("backups")).unwrap().count(), 1);
}
#[test]
fn frozen_v3_plain_and_production_encrypted_backups_restore_without_loss() {
    for name in ["plain.sgbak", "encrypted.sgbak"] {
        let t = Temp::new("u010-restore-v3");
        let mut s = Store::open_exclusive(&t.0).unwrap();
        if name == "plain.sgbak" {
            s.restore_backup_overwrite(&fixture(name)).unwrap();
        } else {
            s.restore_backup_overwrite_with_password(&fixture(name), "synthetic-fixture-pass")
                .unwrap();
        }
        lossless(&s);
        let report = s.reconcile_media().unwrap();
        assert!(
            report.missing.is_empty() && report.corrupt.is_empty() && report.quarantined.is_empty()
        );
        for e in fs::read_dir(fixture("media")).unwrap() {
            let e = e.unwrap();
            assert_eq!(
                fs::read(e.path()).unwrap(),
                fs::read(t.0.join("media").join(e.file_name())).unwrap()
            );
        }
    }
}
#[test]
fn frozen_v3_wrong_passphrase_is_rejected_without_any_live_changes() {
    let t = Temp::new("u010-wrong");
    let mut s = seeded(&t.0, "合成目标数据");
    let before = live_tree(&t.0);
    let e = s
        .restore_backup_overwrite_with_password(&fixture("encrypted.sgbak"), "synthetic-wrong-pass")
        .unwrap_err();
    assert_eq!(e.code, "BACKUP_PASSWORD_WRONG");
    assert_eq!(live_tree(&t.0), before);
}
#[test]
fn v3_merge_into_v4_preserves_drafts_trash_tags_favorites_and_is_idempotent() {
    let t = Temp::new("u010-merge-v3");
    let mut s = Store::open_exclusive(&t.0).unwrap();
    let p = s.merge_backup(&fixture("plain.sgbak")).unwrap().plan;
    assert_eq!(p.added, 4);
    defaults(&s);
    let mut expected = old_value();
    // Merge keeps the destination seed and advances its own dictionary revision.
    set(&mut expected, "seed", Json::str(s.seed()));
    set(&mut expected, "tagDictRevision", Json::Num(1));
    assert_eq!(strip_v4(s.state_json()), canonical(expected));
    let before = fs::read(t.0.join("state.json")).unwrap();
    assert_eq!(
        s.merge_backup(&fixture("plain.sgbak")).unwrap().plan.added,
        0
    );
    assert_eq!(fs::read(t.0.join("state.json")).unwrap(), before);
    let again = Temp::new("u010-merge-enc");
    let mut d = Store::open_exclusive(&again.0).unwrap();
    d.merge_backup_with_password(&fixture("encrypted.sgbak"), "synthetic-fixture-pass")
        .unwrap();
    defaults(&d);
}
fn two_photos(s: &mut Store) -> (String, String, String) {
    let id = draft(s, "合成正文");
    let a = photo(s, &id, "u010-a");
    let b = photo(s, &id, "u010-b");
    s.commit(&id, 0).unwrap();
    (id, a.photo_use_id, b.photo_use_id)
}
#[test]
fn g01_all_new_fields_isolate_publish_atomically_and_discard_preserves_formal() {
    let t = Temp::new("u010-g01");
    let mut s = Store::open(&t.0).unwrap();
    let (id, a, b) = two_photos(&mut s);
    let old = s.formal(&id).unwrap().clone();
    s.set_draft_photo_caption(&id, &a, "<b>纯文本</b>\n第二行")
        .unwrap();
    s.set_draft_cover(&id, &b).unwrap();
    s.reorder_draft_photos(&id, &[b.clone(), a.clone()])
        .unwrap();
    s.save_draft_patch(
        &id,
        &DraftPatch {
            location: Some("<script>原样地点 & 😀\n</script>".into()),
            mood: Some(Some(Mood::Moved)),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(s.formal(&id), Some(&old));
    assert_eq!(s.row(&id).unwrap().base_revision, 1);
    let draft = s.row(&id).unwrap().draft.clone().unwrap();
    s.discard_draft(&id).unwrap();
    assert_eq!(s.formal(&id), Some(&old));
    // Repeat from a fresh edit slot and publish the identical complete snapshot.
    s.set_draft_photo_caption(&id, &a, &draft.photos[1].caption)
        .unwrap();
    s.set_draft_cover(&id, &b).unwrap();
    s.reorder_draft_photos(&id, &[b.clone(), a.clone()])
        .unwrap();
    s.save_draft_patch(
        &id,
        &DraftPatch {
            location: Some(draft.location.clone()),
            mood: Some(draft.mood),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(s.commit(&id, 1).unwrap().content_revision, 2);
    assert_eq!(s.formal(&id), Some(&draft));
    drop(s);
    let s = Store::open(&t.0).unwrap();
    assert_eq!(s.formal(&id), Some(&draft));
}
#[test]
fn cover_reorder_and_removal_fallback_keep_originals_and_formal_untouched() {
    let t = Temp::new("u010-cover");
    let mut s = Store::open(&t.0).unwrap();
    let (id, a, b) = two_photos(&mut s);
    assert_eq!(s.formal(&id).unwrap().cover_photo_use_id.as_ref(), Some(&a));
    s.reorder_draft_photos(&id, &[b.clone(), a.clone()])
        .unwrap(); // default cover is also stable
    assert_eq!(
        s.row(&id)
            .unwrap()
            .draft
            .as_ref()
            .unwrap()
            .cover_photo_use_id
            .as_ref(),
        Some(&a)
    );
    s.set_draft_cover(&id, &b).unwrap();
    s.reorder_draft_photos(&id, &[a.clone(), b.clone()])
        .unwrap();
    s.remove_draft_photo(&id, &b).unwrap();
    assert_eq!(
        s.row(&id)
            .unwrap()
            .draft
            .as_ref()
            .unwrap()
            .cover_photo_use_id
            .as_ref(),
        Some(&a)
    );
    s.remove_draft_photo(&id, &a).unwrap();
    assert_eq!(
        s.row(&id)
            .unwrap()
            .draft
            .as_ref()
            .unwrap()
            .cover_photo_use_id,
        None
    );
    assert_eq!(s.formal(&id).unwrap().photos.len(), 2);
    assert_eq!(s.assets_on_disk().unwrap().len(), 2);
    let disk = fs::read(t.0.join("state.json")).unwrap();
    assert_eq!(
        s.set_draft_cover(&id, "foreign-photo").unwrap_err().code,
        "COVER_PHOTO_INVALID"
    );
    assert_eq!(
        s.reorder_draft_photos(&id, &[a.clone(), a])
            .unwrap_err()
            .code,
        "PHOTO_ORDER_INVALID"
    );
    assert_eq!(fs::read(t.0.join("state.json")).unwrap(), disk);
}
#[test]
fn location_counts_unicode_scalars_without_stripping_and_mood_rejects_unknown_values() {
    let t = Temp::new("u010-details");
    let mut s = Store::open(&t.0).unwrap();
    let id = draft(&mut s, "合成");
    let location = "😀".repeat(200);
    s.save_draft_patch(
        &id,
        &DraftPatch {
            location: Some(location.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        s.row(&id).unwrap().draft.as_ref().unwrap().location,
        location
    );
    let before = s.state_json();
    assert_eq!(
        s.save_draft_patch(
            &id,
            &DraftPatch {
                location: Some("😀".repeat(201)),
                ..Default::default()
            }
        )
        .unwrap_err()
        .code,
        "LOCATION_TOO_LONG"
    );
    assert_eq!(s.state_json(), before);
    for name in ["开心", "平静", "感动", "想念", "疲惫", "难过"] {
        assert_eq!(Mood::parse(name).unwrap().as_str(), name);
    }
    for name in ["", "angry", "未知", " 开心 "] {
        assert_eq!(Mood::parse(name).unwrap_err().code, "MOOD_INVALID");
    }
    let snap = s.row(&id).unwrap().draft.as_ref().unwrap();
    let mut value = snap.to_json();
    set(&mut value, "mood", Json::str("未知"));
    assert!(Snapshot::from_json(&value).is_err());
    set(&mut value, "mood", Json::Null);
    assert!(Snapshot::from_json(&value).is_ok());
}
#[test]
fn v4_plain_and_encrypted_roundtrip_all_new_fields_and_both_snapshot_slots() {
    let a = Temp::new("u010-roundtrip");
    let mut s = Store::open_exclusive(a.0.join("source")).unwrap();
    let (id, p, q) = two_photos(&mut s);
    s.set_draft_photo_caption(&id, &p, "合成正式说明\n<script>纯文本</script>")
        .unwrap();
    s.set_draft_cover(&id, &q).unwrap();
    s.reorder_draft_photos(&id, &[q, p.clone()]).unwrap();
    s.save_draft_patch(
        &id,
        &DraftPatch {
            location: Some("合成地点".into()),
            mood: Some(Some(Mood::Happy)),
            ..Default::default()
        },
    )
    .unwrap();
    s.commit(&id, 1).unwrap();
    s.set_draft_photo_caption(&id, &p, "尚未发布的说明")
        .unwrap();
    s.save_draft_patch(
        &id,
        &DraftPatch {
            location: Some("草稿地点".into()),
            mood: Some(None),
            ..Default::default()
        },
    )
    .unwrap();
    for enc in [false, true] {
        let file = a.0.join(if enc { "enc.sgbak" } else { "plain.sgbak" });
        let report = if enc {
            s.export_backup_encrypted(&file, "0.1.10", "synthetic-v4-pass", KdfParams::fast())
                .unwrap()
        } else {
            s.export_backup(&file, "0.1.10").unwrap()
        };
        assert_eq!(report.manifest.schema_version, 4);
        let mut d = Store::open_exclusive(a.0.join(if enc { "enc" } else { "plain" })).unwrap();
        if enc {
            d.restore_backup_overwrite_with_password(&file, "synthetic-v4-pass")
                .unwrap();
        } else {
            d.restore_backup_overwrite(&file).unwrap();
        }
        assert_eq!(d.state_json(), s.state_json());
    }
}
#[test]
fn merge_compares_every_new_content_field_keeps_both_versions_and_reimports_idempotently() {
    for axis in 0..5 {
        let t = Temp::new("u010-merge-details");
        let mut s = Store::open_exclusive(t.0.join("src")).unwrap();
        let (id, a, b) = two_photos(&mut s);
        let old = s.formal(&id).unwrap().clone();
        let file = t.0.join("base");
        s.export_backup(&file, "synthetic").unwrap();
        let mut d = Store::open_exclusive(t.0.join("dest")).unwrap();
        d.restore_backup_overwrite(&file).unwrap();
        match axis {
            0 => {
                s.set_draft_photo_caption(&id, &a, "仅说明不同").unwrap();
            }
            1 => {
                s.set_draft_cover(&id, &b).unwrap();
            }
            2 => {
                s.reorder_draft_photos(&id, &[b, a]).unwrap();
            }
            3 => {
                s.save_draft_patch(
                    &id,
                    &DraftPatch {
                        location: Some("仅地点不同".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
            }
            _ => {
                s.save_draft_patch(
                    &id,
                    &DraftPatch {
                        mood: Some(Some(Mood::Sad)),
                        ..Default::default()
                    },
                )
                .unwrap();
            }
        }
        s.commit(&id, 1).unwrap();
        let file = t.0.join("changed");
        s.export_backup(&file, "synthetic").unwrap();
        assert_eq!(
            d.merge_backup(&file).unwrap().plan.updated,
            1,
            "axis {axis}"
        );
        assert_eq!(d.formal(&id), s.formal(&id));
        assert!(
            d.list_conflict_copies()
                .unwrap()
                .iter()
                .any(|c| c.snapshot == old),
            "axis {axis}"
        );
        let disk = fs::read(d.root().join("state.json")).unwrap();
        d.merge_backup(&file).unwrap();
        assert_eq!(fs::read(d.root().join("state.json")).unwrap(), disk);
    }
}
#[test]
fn future_v5_and_malformed_v4_fields_are_refused_without_modifying_file() {
    let t = Temp::new("u010-invalid");
    let mut s = Store::open(&t.0).unwrap();
    let id = draft(&mut s, "合成");
    let base = s.state_json();
    drop(s);
    for key in ["schemaVersion", "coverPhotoUseId", "location", "mood"] {
        let mut value = base.clone();
        if key == "schemaVersion" {
            set(&mut value, key, Json::Num(5));
        } else {
            let mut rows = value.get("records").unwrap().as_arr().unwrap().to_vec();
            let mut snap = rows[0].get("draft").unwrap().clone();
            set(
                &mut snap,
                key,
                Json::str(if key == "location" {
                    "x".repeat(201)
                } else {
                    "unknown".into()
                }),
            );
            set(&mut rows[0], "draft", snap);
            set(&mut value, "records", Json::Arr(rows));
        }
        let bytes = value.pretty().into_bytes();
        fs::write(t.0.join("state.json"), &bytes).unwrap();
        let e = Store::open(&t.0).err().unwrap();
        assert_eq!(
            e.code,
            if key == "schemaVersion" {
                "SCHEMA_TOO_NEW"
            } else {
                "STATE_CORRUPT"
            },
            "{key} {id}"
        );
        assert_eq!(fs::read(t.0.join("state.json")).unwrap(), bytes);
    }
    assert_eq!(
        backup::verify_backup(&fixture("plain.sgbak"))
            .unwrap()
            .schema_version,
        3
    );
}

#[test]
fn v3_import_into_nonempty_v4_store_keeps_local_new_fields_and_pending_draft() {
    for encrypted in [false, true] {
        let t = Temp::new("u010-old-into-v4");
        let mut s = Store::open_exclusive(&t.0).unwrap();
        let (id, a, b) = two_photos(&mut s);
        s.set_draft_photo_caption(&id, &a, "本机正式说明").unwrap();
        s.set_draft_cover(&id, &b).unwrap();
        s.reorder_draft_photos(&id, &[b.clone(), a.clone()])
            .unwrap();
        s.save_draft_patch(
            &id,
            &DraftPatch {
                location: Some("本机地点".into()),
                mood: Some(Some(Mood::Calm)),
                ..Default::default()
            },
        )
        .unwrap();
        s.commit(&id, 1).unwrap();
        s.save_draft_patch(
            &id,
            &DraftPatch {
                location: Some("本机尚未提交地点".into()),
                mood: Some(Some(Mood::Tired)),
                ..Default::default()
            },
        )
        .unwrap();
        let before = s.row(&id).unwrap().to_json();
        let report = if encrypted {
            s.merge_backup_with_password(&fixture("encrypted.sgbak"), "synthetic-fixture-pass")
                .unwrap()
        } else {
            s.merge_backup(&fixture("plain.sgbak")).unwrap()
        };
        assert_eq!(report.plan.added, 4);
        assert_eq!(s.row(&id).unwrap().to_json(), before);
        assert_eq!(s.list_formal().len(), 3);
        assert_eq!(s.list_drafts().len(), 3);
    }
}

#[test]
fn photo_id_collision_remaps_manual_cover_in_both_slots_and_conflict_snapshot() {
    let t = Temp::new("u010-cover-remap");
    let mut s = Store::open(&t.0).unwrap();
    let (id, a, b) = two_photos(&mut s);
    s.set_draft_cover(&id, &b).unwrap();
    s.resolve_conflict(&id, shiguang_core::ConflictChoice::KeepFormal)
        .unwrap();
    s.set_draft_cover(&id, &b).unwrap();
    let local = shiguang_core::State::from_json(&s.state_json()).unwrap();
    let mut incoming = s.state_json();
    let mut rows = incoming.get("records").unwrap().as_arr().unwrap().to_vec();
    set(
        &mut rows[0],
        "createdAt",
        Json::str("synthetic-other-device"),
    );
    set(&mut incoming, "records", Json::Arr(rows));
    let incoming = shiguang_core::State::from_json(&incoming).unwrap();
    let (merged, plan) = shiguang_core::merge_states(&local, &incoming).unwrap();
    assert_eq!(plan.added, 1);
    let value = merged.to_json(s.seed());
    let rows = value.get("records").unwrap().as_arr().unwrap();
    let imported = rows
        .iter()
        .find(|r| r.get("recordId").unwrap().as_str() != Some(&id))
        .unwrap();
    let formal = Snapshot::from_json(imported.get("formal").unwrap()).unwrap();
    let draft = Snapshot::from_json(imported.get("draft").unwrap()).unwrap();
    assert_ne!(formal.photos[0].photo_use_id, a);
    assert_ne!(draft.cover_photo_use_id.as_deref(), Some(b.as_str()));
    assert_eq!(formal.cover(), formal.photos.first());
    assert_eq!(draft.cover(), draft.photos.get(1));
    let imported_id = imported.get("recordId").unwrap().as_str().unwrap();
    let copies = value.get("conflictCopies").unwrap().as_arr().unwrap();
    let copy = copies
        .iter()
        .find(|c| c.get("recordId").unwrap().as_str() == Some(imported_id))
        .unwrap();
    let snapshot = Snapshot::from_json(copy.get("snapshot").unwrap()).unwrap();
    assert_eq!(snapshot.cover(), snapshot.photos.get(1));
    let (again, _) = shiguang_core::merge_states(&merged, &incoming).unwrap();
    assert_eq!(again.to_json(s.seed()), value);
}

#[test]
fn v3_conflict_snapshot_migrates_without_losing_caption_order_or_ownership() {
    let t = Temp::new("u010-migrate-conflict");
    copy_v3(&t.0);
    let mut legacy = old_value();
    let row = &legacy.get("records").unwrap().as_arr().unwrap()[0];
    let old_snapshot = row.get("formal").unwrap().clone();
    let conflict = Json::obj(vec![
        ("conflictId", Json::str("conflict-000001")),
        ("recordId", row.get("recordId").unwrap().clone()),
        ("baseRevision", Json::Num(1)),
        ("snapshot", old_snapshot.clone()),
        ("createdAt", Json::str("synthetic-conflict")),
        ("reason", Json::str("synthetic-v3-conflict")),
    ]);
    set(&mut legacy, "conflictCopies", Json::Arr(vec![conflict]));
    fs::write(t.0.join("state.json"), legacy.pretty()).unwrap();
    let store = Store::open(&t.0).unwrap();
    let copies = store.list_conflict_copies().unwrap();
    let snapshot = &copies[0].snapshot;
    assert_eq!(snapshot.cover(), snapshot.photos.first());
    assert_eq!(snapshot.location, "");
    assert_eq!(snapshot.mood, None);
    assert_eq!(strip_v4(store.state_json()), canonical(legacy));
}

#[test]
fn equal_revision_differing_new_fields_keep_local_and_exact_incoming_conflict() {
    for axis in 0..5 {
        let t = Temp::new("u010-equal-content");
        let mut store = Store::open(&t.0).unwrap();
        let (id, a, b) = two_photos(&mut store);
        let local = shiguang_core::State::from_json(&store.state_json()).unwrap();
        match axis {
            0 => {
                store
                    .set_draft_photo_caption(&id, &a, "合成分歧说明")
                    .unwrap();
            }
            1 => {
                store.set_draft_cover(&id, &b).unwrap();
            }
            2 => {
                store.reorder_draft_photos(&id, &[b, a]).unwrap();
            }
            3 => {
                store
                    .save_draft_patch(
                        &id,
                        &DraftPatch {
                            location: Some("合成分歧地点".into()),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            }
            _ => {
                store
                    .save_draft_patch(
                        &id,
                        &DraftPatch {
                            mood: Some(Some(Mood::Missing)),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            }
        }
        let changed = store.row(&id).unwrap().draft.as_ref().unwrap().clone();
        let mut incoming = store.state_json();
        let mut rows = incoming.get("records").unwrap().as_arr().unwrap().to_vec();
        set(&mut rows[0], "formal", changed.to_json());
        set(&mut rows[0], "draft", Json::Null);
        set(&mut incoming, "records", Json::Arr(rows));
        let incoming = shiguang_core::State::from_json(&incoming).unwrap();
        let (merged, plan) = shiguang_core::merge_states(&local, &incoming).unwrap();
        assert_eq!(plan.conflicts, 1, "axis {axis}");
        let value = merged.to_json(store.seed());
        assert_eq!(
            value.get("records"),
            local.to_json(store.seed()).get("records")
        );
        let copies = value.get("conflictCopies").unwrap().as_arr().unwrap();
        assert_eq!(
            Snapshot::from_json(copies[0].get("snapshot").unwrap()).unwrap(),
            changed
        );
        let (again, _) = shiguang_core::merge_states(&merged, &incoming).unwrap();
        assert_eq!(again.to_json(store.seed()), value);
    }
}

#[test]
fn reorder_of_repeated_identical_photo_uses_is_differing_content() {
    let t = Temp::new("u010-repeated-order");
    let mut store = Store::open(&t.0).unwrap();
    let id = draft(&mut store, "合成同图多次引用");
    let a = photo(&mut store, &id, "same-original");
    let b = photo(&mut store, &id, "same-original");
    let c = photo(&mut store, &id, "same-original");
    assert_eq!(a.asset_id, b.asset_id);
    store.set_draft_cover(&id, &c.photo_use_id).unwrap();
    store.commit(&id, 0).unwrap();
    let local = shiguang_core::State::from_json(&store.state_json()).unwrap();
    let old = store.formal(&id).unwrap().clone();
    store
        .reorder_draft_photos(&id, &[b.photo_use_id, a.photo_use_id, c.photo_use_id])
        .unwrap();
    store.commit(&id, 1).unwrap();
    let incoming = shiguang_core::State::from_json(&store.state_json()).unwrap();
    let (merged, plan) = shiguang_core::merge_states(&local, &incoming).unwrap();
    assert_eq!(plan.updated, 1);
    let value = merged.to_json(store.seed());
    let row = &value.get("records").unwrap().as_arr().unwrap()[0];
    assert_eq!(
        row.get("formal"),
        Some(&store.formal(&id).unwrap().to_json())
    );
    assert_eq!(row.get("contentRevision"), Some(&Json::Num(2)));
    let copies = value.get("conflictCopies").unwrap().as_arr().unwrap();
    assert_eq!(
        Snapshot::from_json(copies[0].get("snapshot").unwrap()).unwrap(),
        old
    );
    let (again, _) = shiguang_core::merge_states(&merged, &incoming).unwrap();
    assert_eq!(again.to_json(store.seed()), value);
}
