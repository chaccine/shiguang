mod unit05_support;
mod unit07_support;
use shiguang_core::{json::Json, State, Store, CURRENT_SCHEMA_VERSION};
use std::fs;
use unit07_support::*;
#[test]
fn migration_chain_defaults_and_exact_backup() {
    for version in [1, 2] {
        let t = Temp::new("u07-migration");
        let mut s = Store::open(&t.0).unwrap();
        formal(&mut s);
        let old = downgrade(s.state_json(), version);
        drop(s);
        let bytes = format!(" \n{}\n", old.pretty()).into_bytes();
        fs::write(t.0.join("state.json"), &bytes).unwrap();
        let s = Store::open(&t.0).unwrap();
        assert_eq!(CURRENT_SCHEMA_VERSION, 3);
        assert_eq!(s.state_json().get("schemaVersion"), Some(&Json::Num(3)));
        let r = s.list_formal()[0];
        assert!(!r.favorite);
        assert_eq!(r.favorite_revision, 0);
        assert!(r.tag_ids.is_empty());
        assert_eq!(r.tag_revision, 0);
        for k in ["tags", "tagAliases", "tagTombstones"] {
            assert!(s.state_json().get(k).unwrap().as_arr().unwrap().is_empty());
        }
        assert_eq!(s.state_json().get("tagDictRevision"), Some(&Json::Num(0)));
        let b = fs::read_dir(t.0.join("backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(b).unwrap(), bytes);
    }
}
#[test]
fn future_schema_and_invalid_metadata_reject_without_writes() {
    let t = Temp::new("u07-invalid");
    let mut s = Store::open(&t.0).unwrap();
    formal(&mut s);
    s.create_tag("合成").unwrap();
    let base = s.state_json();
    drop(s);
    let mut v = base.clone();
    set(&mut v, "schemaVersion", Json::Num(4));
    fs::write(t.0.join("state.json"), v.pretty()).unwrap();
    let before = tree(&t.0);
    assert_eq!(Store::open(&t.0).err().unwrap().code, "SCHEMA_TOO_NEW");
    assert_eq!(tree(&t.0), before);
    for case in 0..9 {
        let mut v = base.clone();
        set(&mut v, "seq", Json::Num(100));
        match case {
            0 => edit_row(&mut v, 0, |r| {
                set(r, "tagIds", Json::Arr(vec![Json::str("tag-999999")]))
            }),
            1 => {
                let mut tags = v.get("tags").unwrap().as_arr().unwrap().to_vec();
                let mut tag = tags[0].clone();
                set(&mut tag, "tagId", Json::str("tag-000099"));
                tags.push(tag);
                set(&mut v, "tags", Json::Arr(tags));
            }
            2 => set(
                &mut v,
                "tagAliases",
                Json::Arr(vec![Json::obj(vec![
                    ("fromTagId", Json::str("tag-000080")),
                    ("fromCreatedAt", Json::str("synthetic")),
                    ("toTagId", Json::str("tag-000081")),
                    ("mergedAt", Json::str("synthetic")),
                ])]),
            ),
            3 => {
                let tag = &v.get("tags").unwrap().as_arr().unwrap()[0];
                let tomb = Json::obj(vec![
                    ("tagId", tag.get("tagId").unwrap().clone()),
                    ("createdAt", tag.get("createdAt").unwrap().clone()),
                    ("deletedAt", Json::str("synthetic")),
                ]);
                set(&mut v, "tagTombstones", Json::Arr(vec![tomb]));
            }
            4 => edit_row(&mut v, 0, |r| set(r, "favoriteRevision", Json::Num(-1))),
            5 => edit_row(&mut v, 0, |r| set(r, "tagRevision", Json::Num(4294967296))),
            6 => {
                let mut tags = v.get("tags").unwrap().as_arr().unwrap().to_vec();
                set(&mut tags[0], "normName", Json::str("wrong"));
                set(&mut v, "tags", Json::Arr(tags));
            }
            7 => {
                let id = v.get("tags").unwrap().as_arr().unwrap()[0]
                    .get("tagId")
                    .unwrap()
                    .clone();
                edit_row(&mut v, 0, |r| {
                    set(r, "tagIds", Json::Arr(vec![id.clone(), id]))
                });
            }
            _ => edit_row(&mut v, 0, |r| set(r, "favorite", Json::str("true"))),
        }
        assert_eq!(
            State::from_json(&v).err().unwrap().code,
            "STATE_CORRUPT",
            "case {case}"
        );
        fs::write(t.0.join("state.json"), v.pretty()).unwrap();
        let b = fs::read(t.0.join("state.json")).unwrap();
        assert!(Store::open(&t.0).is_err());
        assert_eq!(fs::read(t.0.join("state.json")).unwrap(), b);
    }
}
