mod unit05_support;
mod unit07_support;
use shiguang_core::{State, Store};
use std::fs;
use unit07_support::*;
#[test]
fn names_rename_conflicts_and_normalization() {
    let t = Temp::new("u07-names");
    let mut s = Store::open(&t.0).unwrap();
    let a = s.create_tag("  Summer   Trip  ").unwrap();
    assert_eq!(a.name, "Summer   Trip");
    assert_eq!(a.norm_name, "summer trip");
    let e = s.create_tag("SUMMER Trip").unwrap_err();
    assert_eq!(e.code, "TAG_NAME_CONFLICT");
    assert!(e.message.contains(&a.tag_id));
    for name in [
        "".to_string(),
        " \t ".into(),
        "a\nb".into(),
        "a\0b".into(),
        "a\u{2028}b".into(),
        "a\u{2029}b".into(),
        "字".repeat(41),
    ] {
        assert_eq!(s.create_tag(&name).unwrap_err().code, "TAG_NAME_INVALID");
    }
    assert!(s.create_tag(&"字".repeat(40)).is_ok());
    let b = s.create_tag("Other").unwrap();
    let bytes = fs::read(t.0.join("state.json")).unwrap();
    assert_eq!(
        s.rename_tag(&b.tag_id, "summer trip").unwrap_err().code,
        "TAG_NAME_CONFLICT"
    );
    assert_eq!(fs::read(t.0.join("state.json")).unwrap(), bytes);
    let id = formal(&mut s);
    s.set_record_tags(&id, std::slice::from_ref(&a.tag_id), None)
        .unwrap();
    s.rename_tag(&a.tag_id, " SUMMER Trip ").unwrap();
    assert_eq!(s.row(&id).unwrap().tag_revision, 1);
    assert_eq!(
        s.merge_tags(&a.tag_id, &a.tag_id).unwrap_err().code,
        "TAG_MERGE_SAME"
    );
    assert_eq!(s.delete_tag("missing").unwrap_err().code, "TAG_NOT_FOUND");
    assert!(s.tag_impact("missing").is_err());
}
#[test]
fn merge_delete_atomic_links_alias_chain_and_content_survives() {
    let t = Temp::new("u07-links");
    let mut s = Store::open(&t.0).unwrap();
    let id = formal(&mut s);
    s.save_draft(&id, None, Some("合成待定"), None, None)
        .unwrap();
    photo(&mut s, &id, "tag-photo");
    s.commit(&id, 1).unwrap();
    let trashed = formal(&mut s);
    let a = s.create_tag("A").unwrap();
    let b = s.create_tag("B").unwrap();
    let c = s.create_tag("C").unwrap();
    s.set_record_tags(&id, &[a.tag_id.clone(), b.tag_id.clone()], None)
        .unwrap();
    s.set_record_tags(&trashed, std::slice::from_ref(&a.tag_id), None)
        .unwrap();
    s.trash_record(&trashed).unwrap();
    let impact = s.tag_impact(&a.tag_id).unwrap();
    assert_eq!((impact.active, impact.trashed), (1, 1));
    let before = s.row(&id).unwrap().formal.clone();
    let out = s.merge_tags(&a.tag_id, &b.tag_id).unwrap();
    assert_eq!(out.affected_records, 2);
    assert_eq!(s.row(&id).unwrap().tag_ids, vec![b.tag_id.clone()]);
    assert_eq!(s.row(&id).unwrap().tag_revision, 2);
    assert_eq!(s.row(&trashed).unwrap().tag_revision, 2);
    s.merge_tags(&b.tag_id, &c.tag_id).unwrap();
    let v = s.state_json();
    let aliases = v.get("tagAliases").unwrap().as_arr().unwrap();
    assert_eq!(aliases.len(), 2);
    for a in aliases {
        assert_eq!(a.get("toTagId").unwrap().as_str(), Some(c.tag_id.as_str()));
    }
    assert_eq!(
        (
            s.list_tags()[0].active_count,
            s.list_tags()[0].trashed_count
        ),
        (1, 1)
    );
    let out = s.delete_tag(&c.tag_id).unwrap();
    assert_eq!(out.affected_records, 2);
    assert_eq!(s.row(&id).unwrap().formal, before);
    assert!(s.row(&id).unwrap().tag_ids.is_empty());
    assert_eq!(s.list_trash().unwrap().len(), 1);
    assert_eq!(s.list_formal().len(), 1);
    let v = s.state_json();
    assert_eq!(v.get("tagTombstones").unwrap().as_arr().unwrap().len(), 3);
    assert!(v.get("tagAliases").unwrap().as_arr().unwrap().is_empty());
    State::from_json(&v).unwrap();
}
#[test]
fn trimming_precedes_display_name_validation() {
    let t=Temp::new("u07-trim");let mut s=Store::open(&t.0).unwrap();let tag=s.create_tag("\t 合成名称 \t").unwrap();assert_eq!(tag.name,"合成名称");assert_eq!(tag.norm_name,"合成名称");assert_eq!(s.create_tag("合成\t名称").unwrap_err().code,"TAG_NAME_INVALID");
}
