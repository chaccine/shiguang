mod unit05_support;
mod unit07_support;
use shiguang_core::{backup, json::{self, Json}, merge_states, sha256, KdfParams, Order, RecordStatus, State, Store};
use std::{fs,path::Path};
use unit07_support::*;
const DAY:&str="2026-11-12";

fn remove(v:&mut Json,key:&str){let Json::Obj(f)=v else{panic!()};f.retain(|(k,_)|k!=key);}
fn canonical(v:Json)->Json{match v{Json::Obj(f)=>{let mut f:Vec<_>=f.into_iter().map(|(k,v)|(k,canonical(v))).collect();f.sort_by(|a,b|a.0.cmp(&b.0));Json::Obj(f)},Json::Arr(a)=>Json::Arr(a.into_iter().map(canonical).collect()),v=>v}}
fn as_v4(mut v:Json)->Json{
    let mut r=rows(&v).to_vec();for r in &mut r{remove(r,"museumHidden");}
    set(&mut v,"records",Json::Arr(r));set(&mut v,"schemaVersion",Json::Num(4));v
}
fn rec(s:&mut Store)->String{s.create_draft(None,"","合成正式文字","2024-11-12",None).map(|r|{let id=r.record_id;s.commit(&id,0).unwrap();id}).unwrap()}

#[test]
fn v4_to_v5_is_lossless_once_with_exact_backup_and_v3_chain_defaults() {
    let t=Temp::new("u011-migration");let mut s=Store::open(&t.0).unwrap();let id=rec(&mut s);
    photo(&mut s,&id,"synthetic-original");s.commit(&id,1).unwrap();
    s.set_draft_photo_caption(&id,&s.formal(&id).unwrap().photos[0].photo_use_id.clone(),"未发布说明").unwrap();
    s.set_favorite(&id,true,None).unwrap();let tag=s.create_tag("合成标签").unwrap();s.set_record_tags(&id,&[tag.tag_id],None).unwrap();
    let old=as_v4(s.state_json());drop(s);let bytes=old.pretty().into_bytes();fs::write(t.0.join("state.json"),&bytes).unwrap();
    let s=Store::open(&t.0).unwrap();assert!(!s.row(&id).unwrap().museum_hidden);
    assert_eq!(s.state_json().get("schemaVersion"),Some(&Json::Num(5)));
    assert_eq!(canonical(as_v4(s.state_json())),canonical(old));
    let backups:Vec<_>=fs::read_dir(t.0.join("backups")).unwrap().map(|e|e.unwrap().path()).filter(|p|p.file_name().unwrap().to_string_lossy().starts_with("state.schema-v4.")).collect();
    assert_eq!(backups.len(),1);assert_eq!(fs::read(&backups[0]).unwrap(),bytes);
    drop(s);Store::open(&t.0).unwrap();assert_eq!(fs::read_dir(t.0.join("backups")).unwrap().count(),1);
    let v3=fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/v3/state.json")).unwrap();
    let t=Temp::new("u011-v3-chain");fs::write(t.0.join("state.json"),v3).unwrap();let s=Store::open(&t.0).unwrap();
    assert_eq!(s.state_json().get("schemaVersion"),Some(&Json::Num(5)));
    assert!(rows(&s.state_json()).iter().all(|r|r.get("museumHidden")==Some(&Json::Bool(false))));
    assert_eq!((s.list_formal().len(),s.list_drafts().len(),s.list_trash().unwrap().len()),(2,2,1));
}

#[test]
fn v5_flag_is_strictly_boolean_and_future_schema_does_not_write() {
    let t=Temp::new("u011-invalid-state");let mut s=Store::open(&t.0).unwrap();rec(&mut s);let base=s.state_json();drop(s);
    for value in [None,Some(Json::Null),Some(Json::Num(0)),Some(Json::str("true"))] {
        let mut v=base.clone();edit_row(&mut v,0,|r|{if let Some(v)=value{set(r,"museumHidden",v);}else{remove(r,"museumHidden");}});
        fs::write(t.0.join("state.json"),v.pretty()).unwrap();let disk=tree(&t.0);
        assert_eq!(Store::open(&t.0).err().unwrap().code,"STATE_CORRUPT");assert_eq!(tree(&t.0),disk);
    }
    let mut v=base;set(&mut v,"schemaVersion",Json::Num(6));fs::write(t.0.join("state.json"),v.pretty()).unwrap();let disk=tree(&t.0);
    assert_eq!(Store::open(&t.0).err().unwrap().code,"SCHEMA_TOO_NEW");assert_eq!(tree(&t.0),disk);
}

#[test]
fn hidden_is_independent_g01_metadata_retains_access_and_commits_current_formal_only() {
    let t=Temp::new("u011-hidden");let mut s=Store::open(&t.0).unwrap();let id=rec(&mut s);
    photo(&mut s,&id,"synthetic");s.commit(&id,1).unwrap();s.set_favorite(&id,true,None).unwrap();
    s.save_draft(&id,Some("草稿标题"),Some("草稿正文"),Some("2020-01-01"),None).unwrap();
    let before=s.row(&id).unwrap().clone();s.set_museum_hidden(&id,true).unwrap();let after=s.row(&id).unwrap();
    let mut expected=before.clone();expected.museum_hidden=true;assert_eq!(after.to_json(),expected.to_json());
    assert_eq!(s.museum_home_summary(DAY).unwrap().hidden_count,1);
    assert_eq!(s.museum_reunion_preview(DAY).unwrap().total,0);assert!(s.on_this_day(11,12,DAY).unwrap().is_empty());
    assert!(s.museum_reshuffle(17,&[],1,DAY).unwrap().items.is_empty());
    assert!(s.museum_year_room(2024,Order::Desc,None,50,DAY).unwrap().featured.is_empty());
    assert_eq!(s.museum_favorites_page(Order::Desc,None,50,DAY).unwrap().total,1);
    assert_eq!(s.museum_photos_page(Order::Desc,None,50,DAY).unwrap().total,1);
    assert_eq!(s.museum_year_room(2024,Order::Desc,None,50,DAY).unwrap().page.total,1);
    assert_eq!(s.day_entries("2024-11-12",Order::Desc,DAY).unwrap().len(),1);assert_eq!(s.calendar_month(2024,11,None).unwrap()[0].count,1);
    s.set_favorite(&id,false,None).unwrap();assert_eq!(s.museum_favorites_page(Order::Desc,None,50,DAY).unwrap().total,0);
    s.commit(&id,2).unwrap();assert!(s.row(&id).unwrap().museum_hidden);assert!(!s.row(&id).unwrap().favorite);
    assert_eq!(s.museum_year_room(2024,Order::Desc,None,50,DAY).unwrap().page.total,0);
    assert_eq!(s.museum_year_room(2020,Order::Desc,None,50,DAY).unwrap().page.items[0].title,"草稿标题");
    drop(s);let s=Store::open(&t.0).unwrap();assert!(s.row(&id).unwrap().museum_hidden);
}

#[test]
fn reset_clears_only_preferences_including_trash_and_never_restores_deleted_content() {
    let t=Temp::new("u011-reset");let mut s=Store::open(&t.0).unwrap();let a=rec(&mut s);let b=rec(&mut s);let c=rec(&mut s);
    for id in [&a,&b,&c]{s.set_museum_hidden(id,true).unwrap();}
    s.trash_record(&b).unwrap();s.trash_record(&c).unwrap();s.purge_record(&c).unwrap();
    let mut want=s.state_json();let mut r=rows(&want).to_vec();for row in &mut r{set(row,"museumHidden",Json::Bool(false));}set(&mut want,"records",Json::Arr(r));
    assert_eq!(s.reset_museum_hidden().unwrap().affected_records,2);assert_eq!(canonical(s.state_json()),canonical(want));
    assert_eq!(s.row(&b).unwrap().status,RecordStatus::Trashed);assert_eq!(s.row(&c).unwrap_err().code,"RECORD_DELETED");
    assert_eq!(s.museum_reunion_preview(DAY).unwrap().total,1);assert_eq!(s.reset_museum_hidden().unwrap().affected_records,0);
    let draft=draft(&mut s,"合成草稿");assert_eq!(s.set_museum_hidden(&draft,true).unwrap_err().code,"RECORD_NOT_FORMAL");
    assert_eq!(s.set_museum_hidden(&b,true).unwrap_err().code,"RECORD_TRASHED");assert_eq!(s.set_museum_hidden(&c,true).unwrap_err().code,"RECORD_DELETED");
}

#[test]
fn plain_and_encrypted_v5_backups_restore_hidden_flags_and_independent_drafts_losslessly() {
    let t=Temp::new("u011-backups");let mut src=Store::open_exclusive(t.0.join("src")).unwrap();let id=rec(&mut src);
    photo(&mut src,&id,"synthetic-backup");src.commit(&id,1).unwrap();src.set_museum_hidden(&id,true).unwrap();
    src.save_draft(&id,None,Some("合成未提交"),Some("2030-01-01"),None).unwrap();
    for encrypted in [false,true] {
        let file=t.0.join(if encrypted{"encrypted.sgbak"}else{"plain.sgbak"});
        let report=if encrypted{src.export_backup_encrypted(&file,"0.1.11","synthetic-pass",KdfParams::fast()).unwrap()}else{src.export_backup(&file,"0.1.11").unwrap()};
        assert_eq!(report.manifest.schema_version,5);
        let target=t.0.join(if encrypted{"target-encrypted"}else{"target-plain"});let mut dst=Store::open_exclusive(&target).unwrap();rec(&mut dst);
        if encrypted{dst.restore_backup_overwrite_with_password(&file,"synthetic-pass").unwrap();}else{dst.restore_backup_overwrite(&file).unwrap();}
        assert_eq!(dst.state_json(),src.state_json());assert_eq!(dst.museum_reunion_preview(DAY).unwrap().total,0);
    }
}

#[test]
fn actual_v4_backup_verifies_restores_and_merges_with_false_preference() {
    let t=Temp::new("u011-v4-backup");let mut src=Store::open(t.0.join("src")).unwrap();let id=rec(&mut src);
    photo(&mut src,&id,"synthetic-legacy");src.commit(&id,1).unwrap();src.set_museum_hidden(&id,true).unwrap();
    let file=t.0.join("v4.sgbak");src.export_backup(&file,"0.1.11").unwrap();
    let (mut manifest,mut payloads)=unpack(&fs::read(&file).unwrap());
    let index=manifest.get("entries").unwrap().as_arr().unwrap().iter().position(|e|e.get("path").unwrap().as_str()==Some("state.json")).unwrap();
    let old=as_v4(json::parse(std::str::from_utf8(&payloads[index]).unwrap()).unwrap());payloads[index]=old.pretty().into_bytes();
    edit_entries(&mut manifest,|entries|{set(&mut entries[index],"size",Json::Num(payloads[index].len() as i64));set(&mut entries[index],"sha256",Json::str(sha256::hex_digest(&payloads[index])));});
    set(&mut manifest,"schemaVersion",Json::Num(4));set(&mut manifest,"appVersion",Json::str("0.1.10"));fs::write(&file,pack(&manifest,&payloads)).unwrap();
    assert_eq!(backup::verify_backup(&file).unwrap().schema_version,4);
    let mut dst=Store::open_exclusive(t.0.join("restore")).unwrap();dst.restore_backup_overwrite(&file).unwrap();
    assert!(!dst.row(&id).unwrap().museum_hidden);assert_eq!(dst.formal(&id),src.formal(&id));
    let mut merged=Store::open_exclusive(t.0.join("merge")).unwrap();assert_eq!(merged.merge_backup(&file).unwrap().plan.added,1);assert!(!merged.row(&id).unwrap().museum_hidden);
    // A v4 false default must not clear an already hidden local preference.
    src.set_museum_hidden(&id,true).unwrap();let mut own=Store::open_exclusive(t.0.join("own")).unwrap();
    let current=t.0.join("current.sgbak");src.export_backup(&current,"0.1.11").unwrap();own.restore_backup_overwrite(&current).unwrap();own.merge_backup(&file).unwrap();assert!(own.row(&id).unwrap().museum_hidden);
}

#[test]
fn merge_hidden_union_is_identity_aware_idempotent_and_never_resurrects() {
    let t=Temp::new("u011-merge");let mut s=Store::open(&t.0).unwrap();let id=rec(&mut s);let unhidden=state(&s);
    s.set_museum_hidden(&id,true).unwrap();let hidden=state(&s);
    let (m,p)=merge_states(&unhidden,&hidden).unwrap();assert_eq!(p.museum_hidden_updated,1);
    assert!(rows(&m.to_json("s"))[0].get("museumHidden")==Some(&Json::Bool(true)));
    let (again,p)=merge_states(&m,&hidden).unwrap();assert_eq!(p.museum_hidden_updated,0);assert_eq!(again.to_json("s"),m.to_json("s"));
    let (m,p)=merge_states(&hidden,&unhidden).unwrap();assert_eq!(p.museum_hidden_updated,0);assert_eq!(m.to_json("s"),hidden.to_json("s"));
    s.reset_museum_hidden().unwrap();let (m,_)=merge_states(&state(&s),&hidden).unwrap();assert_eq!(rows(&m.to_json("s"))[0].get("museumHidden"),Some(&Json::Bool(true))); // old backup may re-hide; documented
    let mut collision=hidden.to_json("s");edit_row(&mut collision,0,|r|set(r,"createdAt",Json::str("different synthetic identity")));
    let (m,p)=merge_states(&unhidden,&State::from_json(&collision).unwrap()).unwrap();assert_eq!(p.added,1);assert_eq!(p.museum_hidden_updated,0);
    let v=m.to_json("s");assert_eq!(rows(&v)[0].get("museumHidden"),Some(&Json::Bool(false)));assert_eq!(rows(&v)[1].get("museumHidden"),Some(&Json::Bool(true)));
    s.set_museum_hidden(&id,false).unwrap();s.trash_record(&id).unwrap();let (m,p)=merge_states(&state(&s),&hidden).unwrap();assert_eq!(p.kept_trashed,1);assert_eq!(rows(&m.to_json("s"))[0].get("status"),Some(&Json::str("trashed")));
    s.purge_record(&id).unwrap();let (m,p)=merge_states(&state(&s),&hidden).unwrap();assert_eq!(p.skipped_deleted.len(),1);assert_eq!(p.museum_hidden_updated,0);assert!(rows(&m.to_json("s")).is_empty());
}

#[test]
fn store_merge_persists_preference_union_and_second_import_is_no_op() {
    let t=Temp::new("u011-store-merge");let mut src=Store::open_exclusive(t.0.join("src")).unwrap();let id=rec(&mut src);
    let file=t.0.join("unhidden.sgbak");src.export_backup(&file,"0.1.11").unwrap();
    let mut dst=Store::open_exclusive(t.0.join("dst")).unwrap();dst.restore_backup_overwrite(&file).unwrap();
    src.set_museum_hidden(&id,true).unwrap();let file=t.0.join("hidden.sgbak");src.export_backup(&file,"0.1.11").unwrap();
    assert_eq!(dst.plan_merge(&file).unwrap().museum_hidden_updated,1);assert_eq!(dst.merge_backup(&file).unwrap().plan.museum_hidden_updated,1);assert!(dst.row(&id).unwrap().museum_hidden);
    let bytes=fs::read(dst.root().join("state.json")).unwrap();let out=dst.merge_backup(&file).unwrap();assert_eq!(out.plan.museum_hidden_updated,0);assert!(out.safety_backup_dir.is_none());assert_eq!(fs::read(dst.root().join("state.json")).unwrap(),bytes);
}
