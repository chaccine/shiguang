#![cfg(feature="fault-injection")]
mod unit05_support;
mod unit07_support;
use shiguang_core::{fault::{self,FaultPoint},json::Json,Store};
use std::fs;
use unit07_support::*;

#[test]
fn hiding_unhiding_and_reset_failure_preserve_disk_memory_drafts_and_reopen() {
    for point in [FaultPoint::TagTxnWrite,FaultPoint::TempCreate,FaultPoint::TempWrite,FaultPoint::TempSync,FaultPoint::Replace] {
        for op in 0..3 {
            let t=Temp::new("u011-meta-fault");let mut s=Store::open(&t.0).unwrap();let id=formal(&mut s);
            s.save_draft(&id,None,Some("合成未发布草稿"),None,None).unwrap();
            if op!=0{s.set_museum_hidden(&id,true).unwrap();}
            let memory=s.state_json();let disk=fs::read(t.0.join("state.json")).unwrap();
            fault::set(point);
            let result=if op==2{s.reset_museum_hidden().map(|_|())}else{s.set_museum_hidden(&id,op==0).map(|_|())};
            assert!(result.is_err(),"{point:?} op {op}");fault::clear();
            assert_eq!(s.state_json(),memory);assert_eq!(fs::read(t.0.join("state.json")).unwrap(),disk);
            drop(s);let s=Store::open(&t.0).unwrap();assert_eq!(s.state_json(),memory);clean(&t.0);
        }
    }
}
#[test]
fn preference_no_ops_skip_writes() {
    let t=Temp::new("u011-meta-noop");let mut s=Store::open(&t.0).unwrap();let id=formal(&mut s);
    let bytes=fs::read(t.0.join("state.json")).unwrap();fault::set(FaultPoint::TempWrite);
    s.set_museum_hidden(&id,false).unwrap();assert_eq!(s.reset_museum_hidden().unwrap().affected_records,0);fault::clear();
    assert_eq!(fs::read(t.0.join("state.json")).unwrap(),bytes);
    s.set_museum_hidden(&id,true).unwrap();fault::set(FaultPoint::TagTxnWrite);s.set_museum_hidden(&id,true).unwrap();fault::clear();
}
#[test]
fn v4_migration_failure_keeps_exact_v4_bytes_and_is_retryable() {
    for (point,visit) in [(FaultPoint::MigrationBackup,1),(FaultPoint::MigrationWrite,1),(FaultPoint::TempCreate,2),
        (FaultPoint::TempWrite,2),(FaultPoint::TempSync,2),(FaultPoint::Replace,2)] {
        let t=Temp::new("u011-migration-fault");let mut s=Store::open(&t.0).unwrap();formal(&mut s);let mut v=s.state_json();drop(s);
        let mut records=rows(&v).to_vec();for row in &mut records{let Json::Obj(fields)=row else{panic!()};fields.retain(|(k,_)|k!="museumHidden");}
        set(&mut v,"records",Json::Arr(records));set(&mut v,"schemaVersion",Json::Num(4));let bytes=v.pretty().into_bytes();fs::write(t.0.join("state.json"),&bytes).unwrap();
        fault::set_after(point,visit);assert!(Store::open(&t.0).is_err(),"{point:?}");fault::clear();
        assert_eq!(fs::read(t.0.join("state.json")).unwrap(),bytes);let s=Store::open(&t.0).unwrap();assert_eq!(s.list_formal().len(),1);assert!(!s.list_formal()[0].museum_hidden);clean(&t.0);
    }
}
#[test]
fn hidden_only_backup_merge_failures_roll_back_preferences_and_content() {
    for point in [FaultPoint::MergeStage,FaultPoint::MergeStateWrite] {
        let t=Temp::new("u011-merge-fault");let mut src=Store::open_exclusive(t.0.join("src")).unwrap();let id=formal(&mut src);
        let file=t.0.join("base.sgbak");src.export_backup(&file,"0.1.11").unwrap();let mut dst=Store::open_exclusive(t.0.join("dst")).unwrap();dst.restore_backup_overwrite(&file).unwrap();
        src.set_museum_hidden(&id,true).unwrap();let hidden=t.0.join("hidden.sgbak");src.export_backup(&hidden,"0.1.11").unwrap();
        let memory=dst.state_json();let disk=live_tree(dst.root());fault::set(point);assert!(dst.merge_backup(&hidden).is_err());fault::clear();
        assert_eq!(dst.state_json(),memory);assert_eq!(live_tree(dst.root()),disk);let root=dst.root().to_path_buf();drop(dst);let dst=Store::open_exclusive(root).unwrap();assert_eq!(dst.state_json(),memory);
    }
}
