#![cfg(feature = "fault-injection")]
mod unit05_support;
mod unit07_support;
use shiguang_core::{
    fault::{self, FaultPoint},
    Store,
};
use std::fs;
use unit07_support::*;
#[test]
fn every_metadata_mutation_rolls_back_disk_memory_and_reopen() {
    for point in [
        FaultPoint::TagTxnWrite,
        FaultPoint::TempWrite,
        FaultPoint::Replace,
    ] {
        for op in 0..7 {
            let t = Temp::new("u07-fault");
            let mut s = Store::open(&t.0).unwrap();
            let id = formal(&mut s);
            let a = s.create_tag("A").unwrap();
            let b = s.create_tag("B").unwrap();
            s.set_record_tags(&id, &[a.tag_id.clone(), b.tag_id.clone()], None)
                .unwrap();
            let memory = s.state_json();
            let disk = fs::read(t.0.join("state.json")).unwrap();
            fault::set(point);
            let result = match op {
                0 => s.merge_tags(&a.tag_id, &b.tag_id).map(|_| ()),
                1 => s.delete_tag(&a.tag_id).map(|_| ()),
                2 => s.rename_tag(&a.tag_id, "C").map(|_| ()),
                3 => s.set_favorite(&id, true, None).map(|_| ()),
                4 => s.set_record_tags(&id, &[], None).map(|_| ()),
                5 => s.create_tag("C").map(|_| ()),
                _ => s
                    .set_record_tags(&id, std::slice::from_ref(&b.tag_id), None)
                    .map(|_| ()),
            };
            assert!(result.is_err(), "{point:?} op {op}");
            fault::clear();
            assert_eq!(s.state_json(), memory);
            assert_eq!(s.row(&id).unwrap().tag_ids, vec![a.tag_id, b.tag_id]);
            assert!(!s.row(&id).unwrap().favorite);
            assert_eq!(fs::read(t.0.join("state.json")).unwrap(), disk);
            drop(s);
            let s = Store::open(&t.0).unwrap();
            assert_eq!(s.state_json(), memory);
            clean(&t.0);
        }
    }
}
#[test]
fn migration_faults_keep_original_bytes() {
    for version in [1, 2] {
        for point in [FaultPoint::MigrationBackup, FaultPoint::MigrationWrite] {
            let t = Temp::new("u07-mig-fault");
            let mut s = Store::open(&t.0).unwrap();
            formal(&mut s);
            let v = downgrade(s.state_json(), version);
            drop(s);
            fs::write(t.0.join("state.json"), v.pretty()).unwrap();
            let old = fs::read(t.0.join("state.json")).unwrap();
            fault::set(point);
            assert!(Store::open(&t.0).is_err());
            fault::clear();
            assert_eq!(fs::read(t.0.join("state.json")).unwrap(), old);
            assert!(Store::open(&t.0).is_ok());
        }
    }
}
#[test]
fn noops_do_not_visit_write_fault_points() {
    let t = Temp::new("u07-noop");
    let mut s = Store::open(&t.0).unwrap();
    let id = formal(&mut s);
    fault::set(FaultPoint::TempWrite);
    s.set_favorite(&id, false, Some(0)).unwrap();
    s.set_record_tags(&id, &[], Some(0)).unwrap();
    fault::clear();
}
