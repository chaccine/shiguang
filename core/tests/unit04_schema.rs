mod unit04_support;
use shiguang_core::{
    json::Json,
    schema::{migrate_v1_to_v2, MIGRATIONS},
    RecordStatus, Store, CURRENT_SCHEMA_VERSION,
};
use std::fs;
use unit04_support::*;

#[test]
fn missing_schema_is_v1_migrates_and_backs_up_exact_bytes_once() {
    let t = TempRoot::new("migration");
    let original = legacy(&t);
    let s = Store::open(t.path()).unwrap();
    assert_eq!(CURRENT_SCHEMA_VERSION, 2);
    assert_eq!(
        s.state_json().get("version").and_then(Json::as_i64),
        Some(1)
    );
    assert_eq!(
        s.state_json().get("schemaVersion").and_then(Json::as_i64),
        Some(2)
    );
    assert_eq!(s.list_formal()[0].status, RecordStatus::Active);
    assert_eq!(s.list_formal()[0].trashed_at, None);
    for key in ["deletionMarkers", "conflictCopies"] {
        assert_eq!(
            s.state_json()
                .get(key)
                .and_then(Json::as_arr)
                .unwrap()
                .len(),
            0
        );
    }
    let copies = backups(&t);
    assert_eq!(copies.len(), 1);
    assert!(copies[0]
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("state.schema-v1."));
    assert_eq!(fs::read(&copies[0]).unwrap(), original);
    drop(s);
    Store::open(t.path()).unwrap();
    assert_eq!(backups(&t), copies);
    assert_eq!(fs::read(&copies[0]).unwrap(), original);
}
#[test]
fn explicit_v1_uses_same_migration_chain() {
    let t = TempRoot::new("explicit-v1");
    legacy(&t);
    let mut v = t.json();
    set(&mut v, "schemaVersion", Json::Num(1));
    fs::write(t.path().join("state.json"), v.pretty()).unwrap();
    let before = t.bytes();
    let s = Store::open(t.path()).unwrap();
    assert_eq!(s.state_json().get("schemaVersion"), Some(&Json::Num(2)));
    assert_eq!(fs::read(&backups(&t)[0]).unwrap(), before);
}
#[test]
fn too_new_schema_rejects_without_touching_state_temps_or_directories() {
    let t = TempRoot::new("too-new");
    legacy(&t);
    let mut v = t.json();
    set(
        &mut v,
        "schemaVersion",
        Json::Num(CURRENT_SCHEMA_VERSION + 1),
    );
    fs::write(t.path().join("state.json"), v.pretty()).unwrap();
    fs::write(t.path().join(".tmp-preserve"), b"synthetic").unwrap();
    fs::remove_dir_all(t.path().join("previews")).unwrap();
    let before = tree(t.path());
    let e = Store::open(t.path()).err().expect("must reject new schema");
    assert_eq!(e.code, "SCHEMA_TOO_NEW");
    assert_eq!(
        e.message,
        "这份数据由更新版本的拾光写入，当前版本无法安全读取。请升级拾光；原数据未改动。"
    );
    assert_eq!(tree(t.path()), before);
    assert!(!t.path().join("previews").exists());
}
#[test]
fn migration_function_and_table_expose_v1_to_v2() {
    let t = TempRoot::new("migration-table");
    legacy(&t);
    assert_eq!(MIGRATIONS[0].0, 1);
    let value = migrate_v1_to_v2(t.json()).unwrap();
    assert_eq!(value.get("schemaVersion"), Some(&Json::Num(2)));
    let rows = value.get("records").and_then(Json::as_arr).unwrap();
    assert_eq!(rows[0].get("status"), Some(&Json::str("active")));
    assert_eq!(rows[0].get("trashedAt"), Some(&Json::Null));
    assert_eq!((MIGRATIONS[0].1)(t.json()).unwrap(), value);
}
#[test]
fn transaction_reloading_legacy_schema_refuses_to_overwrite() {
    let t = TempRoot::new("schema-on-disk");
    let mut s = Store::open(t.path()).unwrap();
    let id = draft(&mut s);
    legacy(&t);
    let before = t.bytes();
    let memory = s.state_json();
    let e = s
        .save_draft(&id, None, Some("不得覆盖"), None, None)
        .unwrap_err();
    assert_eq!(e.code, "SCHEMA_CHANGED_ON_DISK");
    assert_eq!(t.bytes(), before);
    assert_eq!(s.state_json(), memory);
}
