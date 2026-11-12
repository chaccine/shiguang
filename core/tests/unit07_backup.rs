mod unit05_support;
mod unit07_support;
use shiguang_core::{
    backup::verify_backup,
    json::{self, Json},
    merge_states, sha256, State, Store,
};
use std::fs;
use unit07_support::*;
fn merged(a: &Json, b: &Json) -> (State, shiguang_core::MergePlan) {
    merge_states(&State::from_json(a).unwrap(), &State::from_json(b).unwrap()).unwrap()
}
fn no_meta_changes(p: &shiguang_core::MergePlan) {
    assert_eq!(
        (
            p.tags_added,
            p.tags_remapped,
            p.tags_skipped_deleted,
            p.tags_deleted_in_backup,
            p.favorites_updated,
            p.tag_links_updated
        ),
        (0, 0, 0, 0, 0, 0)
    );
}
#[test]
fn v3_roundtrip_tags_favorites_aliases_tombs_and_counts() {
    let a = Temp::new("u07-backup-a");
    let b = Temp::new("u07-backup-b");
    let mut s = seeded(&a.0, "合成");
    let id = s.list_formal()[0].record_id.clone();
    let x = s.create_tag("X").unwrap();
    let y = s.create_tag("Y").unwrap();
    let z = s.create_tag("Z").unwrap();
    s.set_record_tags(&id, std::slice::from_ref(&x.tag_id), None)
        .unwrap();
    s.set_favorite(&id, true, None).unwrap();
    s.merge_tags(&x.tag_id, &y.tag_id).unwrap();
    s.delete_tag(&z.tag_id).unwrap();
    let path = b.0.join("v3.sgbak");
    let report = s.export_backup(&path, "synthetic").unwrap();
    assert_eq!(report.manifest.schema_version, 4);
    assert_eq!(report.manifest.counts.tags, 1);
    assert_eq!(report.manifest.counts.favorites, 1);
    let mut dest = Store::open_exclusive(b.0.join("dest")).unwrap();
    dest.restore_backup_overwrite(&path).unwrap();
    assert_eq!(dest.state_json(), s.state_json());
}
#[test]
fn actual_v2_package_without_new_fields_verifies_restores_and_merges() {
    let a = Temp::new("u07-old-a");
    let b = Temp::new("u07-old-b");
    let s = seeded(&a.0, "old synthetic");
    let path = b.0.join("v2");
    s.export_backup(&path, "old").unwrap();
    let (mut manifest, mut payloads) = unpack(&fs::read(&path).unwrap());
    let entries = manifest.get("entries").unwrap().as_arr().unwrap();
    let index = entries
        .iter()
        .position(|e| e.get("path").unwrap().as_str() == Some("state.json"))
        .unwrap();
    let v = json::parse(std::str::from_utf8(&payloads[index]).unwrap()).unwrap();
    payloads[index] = downgrade(v, 2).pretty().into_bytes();
    edit_entries(&mut manifest, |e| {
        set(
            &mut e[index],
            "size",
            Json::Num(payloads[index].len() as i64),
        );
        set(
            &mut e[index],
            "sha256",
            Json::str(sha256::hex_digest(&payloads[index])),
        );
    });
    set(&mut manifest, "schemaVersion", Json::Num(2));
    let mut c = manifest.get("counts").unwrap().clone();
    if let Json::Obj(f) = &mut c {
        f.retain(|(k, _)| k != "tags" && k != "favorites");
    }
    set(&mut manifest, "counts", c);
    fs::write(&path, pack(&manifest, &payloads)).unwrap();
    assert_eq!(verify_backup(&path).unwrap().counts.tags, 0);
    let mut d = Store::open_exclusive(b.0.join("restore")).unwrap();
    d.restore_backup_overwrite(&path).unwrap();
    assert_eq!(d.state_json().get("schemaVersion"), Some(&Json::Num(4)));
    let mut e = Store::open_exclusive(b.0.join("merge")).unwrap();
    assert_eq!(e.merge_backup(&path).unwrap().plan.added, 1);
}
#[test]
fn dictionary_cross_device_collisions_and_reimport_idempotence() {
    let a = Temp::new("u07-map-a");
    let b = Temp::new("u07-map-b");
    let mut l = Store::open(&a.0).unwrap();
    let mut i = Store::open(&b.0).unwrap();
    let local = l.create_tag("Shared").unwrap();
    let other = i.create_tag("Different").unwrap();
    let same = i.create_tag("shared").unwrap();
    let id = formal(&mut i);
    i.set_record_tags(&id, &[other.tag_id.clone(), same.tag_id], None)
        .unwrap();
    let mut incoming = i.state_json();
    let mut tags = incoming.get("tags").unwrap().as_arr().unwrap().to_vec();
    set(&mut tags[0], "createdAt", Json::str("synthetic-device-B"));
    set(&mut incoming, "tags", Json::Arr(tags));
    let (m, p) = merged(&l.state_json(), &incoming);
    assert_eq!(p.tags_added, 1);
    let v = m.to_json("synthetic");
    let r = &rows(&v)[0];
    let links = r.get("tagIds").unwrap().as_arr().unwrap();
    assert!(links.contains(&Json::str(local.tag_id)));
    let imported = v
        .get("tags")
        .unwrap()
        .as_arr()
        .unwrap()
        .iter()
        .find(|t| t.get("name") == Some(&Json::str("Different")))
        .unwrap();
    assert_ne!(imported.get("tagId"), Some(&Json::str(other.tag_id)));
    assert!(links.contains(imported.get("tagId").unwrap()));
    let (again, p) = merge_states(&m, &State::from_json(&incoming).unwrap()).unwrap();
    no_meta_changes(&p);
    assert_eq!(again.to_json("synthetic"), v);
}
#[test]
fn local_deletion_merge_alias_and_deleted_record_never_resurrect() {
    let t = Temp::new("u07-no-revive");
    let mut s = Store::open(&t.0).unwrap();
    let id = formal(&mut s);
    let a = s.create_tag("A").unwrap();
    let b = s.create_tag("B").unwrap();
    s.set_record_tags(&id, std::slice::from_ref(&a.tag_id), None)
        .unwrap();
    let old = s.state_json();
    s.merge_tags(&a.tag_id, &b.tag_id).unwrap();
    let (m, p) = merged(&s.state_json(), &old);
    assert_eq!(p.tags_remapped, 1);
    assert_eq!(
        rows(&m.to_json("x"))[0].get("tagIds"),
        Some(&Json::Arr(vec![Json::str(&b.tag_id)]))
    );
    s.delete_tag(&b.tag_id).unwrap();
    let (m, p) = merged(&s.state_json(), &old);
    assert_eq!(p.tags_skipped_deleted, 2);
    assert!(m
        .to_json("x")
        .get("tags")
        .unwrap()
        .as_arr()
        .unwrap()
        .is_empty());
    assert!(rows(&m.to_json("x"))[0]
        .get("tagIds")
        .unwrap()
        .as_arr()
        .unwrap()
        .is_empty());
    let mut new_record = old.clone();
    edit_row(&mut new_record, 0, |r| {
        set(r, "createdAt", Json::str("foreign-record"))
    });
    let (m, _) = merged(&s.state_json(), &new_record);
    assert!(rows(&m.to_json("x"))[1]
        .get("tagIds")
        .unwrap()
        .as_arr()
        .unwrap()
        .is_empty());
    s.trash_record(&id).unwrap();
    s.purge_record(&id).unwrap();
    let (m, p) = merged(&s.state_json(), &old);
    assert_eq!(p.skipped_deleted.len(), 1);
    assert!(rows(&m.to_json("x")).is_empty());
}
#[test]
fn independent_revision_winners_equal_local_wins_and_marker_union() {
    let t = Temp::new("u07-revs");
    let mut s = Store::open(&t.0).unwrap();
    let id = formal(&mut s);
    let a = s.create_tag("A").unwrap();
    s.set_record_tags(&id, std::slice::from_ref(&a.tag_id), None)
        .unwrap();
    let base = s.state_json();
    for (rev, favorite, want_f, want_tags) in [
        (0, true, false, true),
        (0, false, false, true),
        (1, true, true, true),
        (2, true, true, false),
    ] {
        let mut v = base.clone();
        edit_row(&mut v, 0, |r| {
            set(r, "favorite", Json::Bool(favorite));
            set(r, "favoriteRevision", Json::Num(rev));
            set(r, "tagIds", Json::Arr(vec![]));
            set(r, "tagRevision", Json::Num(rev));
        });
        let (m, _) = merged(&base, &v);
        let v = m.to_json("x");
        assert_eq!(rows(&v)[0].get("favorite"), Some(&Json::Bool(want_f)));
        assert_eq!(
            !rows(&v)[0]
                .get("tagIds")
                .unwrap()
                .as_arr()
                .unwrap()
                .is_empty(),
            want_tags
        );
    }
    s.delete_tag(&a.tag_id).unwrap();
    let incoming = s.state_json();
    let (m, p) = merged(&base, &incoming);
    assert_eq!(p.tags_deleted_in_backup, 1);
    assert_eq!(
        m.to_json("x").get("tags").unwrap().as_arr().unwrap().len(),
        1
    );
    let (_, p) = merge_states(&m, &State::from_json(&incoming).unwrap()).unwrap();
    no_meta_changes(&p);
}
#[test]
fn remapped_identity_survives_merge_delete_and_history_reexport() {
    let a = Temp::new("u07-origin-a");
    let b = Temp::new("u07-origin-b");
    let mut l = Store::open(&a.0).unwrap();
    let mut i = Store::open(&b.0).unwrap();
    let local = l.create_tag("Local").unwrap();
    let foreign = i.create_tag("Foreign").unwrap();
    let id = formal(&mut i);
    i.set_record_tags(&id, std::slice::from_ref(&foreign.tag_id), None)
        .unwrap();
    let mut old = i.state_json();
    let mut tags = old.get("tags").unwrap().as_arr().unwrap().to_vec();
    set(&mut tags[0], "createdAt", Json::str("foreign-creation"));
    set(&mut old, "tags", Json::Arr(tags));
    let (m, _) = merged(&l.state_json(), &old);
    let mut v = m.to_json(l.seed());
    fs::write(a.0.join("state.json"), v.pretty()).unwrap();
    drop(l);
    let mut l = Store::open(&a.0).unwrap();
    let remapped = l
        .list_tags()
        .into_iter()
        .find(|t| t.name == "Foreign")
        .unwrap()
        .tag_id;
    l.merge_tags(&remapped, &local.tag_id).unwrap();
    let (m, _) = merged(&l.state_json(), &old);
    v = m.to_json("x");
    assert_eq!(v.get("tags").unwrap().as_arr().unwrap().len(), 1);
    assert_eq!(
        rows(&v)[0].get("tagIds"),
        Some(&Json::Arr(vec![Json::str(&local.tag_id)]))
    );
    l.delete_tag(&local.tag_id).unwrap();
    let (m, _) = merged(&l.state_json(), &old);
    assert!(m
        .to_json("x")
        .get("tags")
        .unwrap()
        .as_arr()
        .unwrap()
        .is_empty());
    let (again, p) = merge_states(&m, &State::from_json(&old).unwrap()).unwrap();
    no_meta_changes(&p);
    assert_eq!(again.to_json("x"), m.to_json("x"));
}
#[test]
fn incoming_alias_to_locally_deleted_terminal_becomes_tombstone() {
    let a = Temp::new("u07-history-a");
    let b = Temp::new("u07-history-b");
    let mut s = Store::open(&a.0).unwrap();
    let id = formal(&mut s);
    let a = s.create_tag("A").unwrap();
    let btag = s.create_tag("B").unwrap();
    s.set_record_tags(&id, std::slice::from_ref(&a.tag_id), None)
        .unwrap();
    let old = s.state_json();
    s.merge_tags(&a.tag_id, &btag.tag_id).unwrap();
    let incoming = s.state_json();
    // Destination knows the terminal deletion but has never seen the source alias.
    let mut local = Store::open(&b.0).unwrap();
    let mut v = incoming.clone();
    set(&mut v, "tagAliases", Json::Arr(vec![]));
    fs::write(b.0.join("state.json"), v.pretty()).unwrap();
    drop(local);
    local = Store::open(&b.0).unwrap();
    local.delete_tag(&btag.tag_id).unwrap();
    let (m, _) = merged(&local.state_json(), &incoming);
    let (m, _) = merge_states(&m, &State::from_json(&old).unwrap()).unwrap();
    assert!(m
        .to_json("x")
        .get("tags")
        .unwrap()
        .as_arr()
        .unwrap()
        .is_empty());
}
#[test]
fn store_merge_metadata_roundtrip_is_byte_identical_on_second_import() {
    let a = Temp::new("u07-import-a");
    let b = Temp::new("u07-import-b");
    let f = Temp::new("u07-import-file");
    let mut s = seeded(&a.0, "合成导入");
    let id = s.list_formal()[0].record_id.clone();
    let tag = s.create_tag("合成标签").unwrap();
    s.set_favorite(&id, true, None).unwrap();
    s.set_record_tags(&id, std::slice::from_ref(&tag.tag_id), None)
        .unwrap();
    let path = f.0.join("v3");
    s.export_backup(&path, "synthetic").unwrap();
    let mut d = Store::open_exclusive(&b.0).unwrap();
    let plan = d.plan_merge(&path).unwrap();
    let report = d.merge_backup(&path).unwrap();
    assert_eq!(plan, report.plan);
    assert_eq!(plan.tags_added, 1);
    assert!(d.row(&id).unwrap().favorite);
    assert_eq!(d.row(&id).unwrap().tag_ids, vec![tag.tag_id]);
    let bytes = fs::read(b.0.join("state.json")).unwrap();
    let report = d.merge_backup(&path).unwrap();
    no_meta_changes(&report.plan);
    assert_eq!(fs::read(b.0.join("state.json")).unwrap(), bytes);
    assert!(report.safety_backup_dir.is_none());
}
#[test]
fn cross_device_history_collisions_are_valid_and_idempotent() {
    for local_op in 0..3 {
        for incoming_op in 0..3 {
            let a = Temp::new("u07-matrix-a");
            let b = Temp::new("u07-matrix-b");
            let mut l = Store::open(&a.0).unwrap();
            let mut i = Store::open(&b.0).unwrap();
            let lr = formal(&mut l);
            let ir = formal(&mut i);
            let la = l.create_tag("Local A").unwrap();
            let lb = l.create_tag("Shared B").unwrap();
            let ia = i.create_tag("Incoming A").unwrap();
            let ib = i.create_tag("Shared B").unwrap();
            l.set_record_tags(&lr, std::slice::from_ref(&la.tag_id), None)
                .unwrap();
            i.set_record_tags(&ir, std::slice::from_ref(&ia.tag_id), None)
                .unwrap();
            match local_op {
                1 => {
                    l.merge_tags(&la.tag_id, &lb.tag_id).unwrap();
                }
                2 => {
                    l.delete_tag(&la.tag_id).unwrap();
                }
                _ => {}
            }
            match incoming_op {
                1 => {
                    i.merge_tags(&ia.tag_id, &ib.tag_id).unwrap();
                }
                2 => {
                    i.delete_tag(&ia.tag_id).unwrap();
                }
                _ => {}
            }
            let mut foreign = i.state_json();
            edit_row(&mut foreign, 0, |r| {
                set(r, "createdAt", Json::str("device-B-record"))
            });
            for key in ["tags", "tagAliases", "tagTombstones"] {
                let mut values = foreign.get(key).unwrap().as_arr().unwrap().to_vec();
                for v in &mut values {
                    set(
                        v,
                        if key == "tagAliases" {
                            "fromCreatedAt"
                        } else {
                            "createdAt"
                        },
                        Json::str("device-B-tag"),
                    );
                }
                set(&mut foreign, key, Json::Arr(values));
            }
            let (m, _) = merged(&l.state_json(), &foreign);
            let (again, p) = merge_states(&m, &State::from_json(&foreign).unwrap()).unwrap();
            no_meta_changes(&p);
            assert_eq!(
                again.to_json("x"),
                m.to_json("x"),
                "local {local_op} incoming {incoming_op}"
            );
        }
    }
}
