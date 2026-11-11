#![cfg(feature = "fault-injection")]
mod unit05_support;
use shiguang_core::{
    fault::{self, FaultPoint},
    Store,
};
use std::{fs, path::Path};
use unit05_support::*;

#[test]
fn v3_migration_interrupted_at_each_safe_write_stage_leaves_original_reopenable() {
    let old = fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/v3/state.json"))
        .unwrap();
    for (point, visit) in [
        (FaultPoint::MigrationBackup, 1),
        (FaultPoint::MigrationWrite, 1),
        (FaultPoint::TempCreate, 2),
        (FaultPoint::TempWrite, 2),
        (FaultPoint::TempSync, 2),
        (FaultPoint::Replace, 2),
    ] {
        let t = Temp::new("u010-migration-fault");
        fs::write(t.0.join("state.json"), &old).unwrap();
        fault::set_after(point, visit);
        assert!(Store::open(&t.0).is_err(), "{point:?}");
        fault::clear();
        assert_eq!(fs::read(t.0.join("state.json")).unwrap(), old, "{point:?}");
        let reopened = Store::open(&t.0).unwrap();
        assert_eq!(reopened.list_formal().len(), 2);
        assert_eq!(reopened.list_drafts().len(), 2);
        clean(&t.0);
    }
}
