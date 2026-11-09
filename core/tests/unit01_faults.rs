#![cfg(feature = "fault-injection")]

use shiguang_core::fault::{self, FaultPoint};
use shiguang_core::persist::Durability;
use shiguang_core::{sha256, Store};
use std::fs;
use std::path::{Path, PathBuf};

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(name: &str) -> Self {
        fault::clear();
        let path =
            std::env::temp_dir().join(format!("shiguang-u01f-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        fault::clear();
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn assert_no_temps(root: &Path) {
    for entry in fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        assert!(
            !entry.file_name().to_string_lossy().starts_with(".tmp-"),
            "残留临时文件：{}",
            entry.path().display()
        );
    }
}

#[test]
fn t_b1_commit_replace_failure_keeps_memory_equal_disk() {
    let tmp = TempRoot::new("b1");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "标题", "正文", "2026-11-09", None)
        .unwrap();
    let id = row.record_id;
    let before = store.state_json().dump();
    let bytes = fs::read(tmp.path().join("state.json")).unwrap();
    let durability = store.last_durability().clone();

    fault::set(FaultPoint::Replace);
    let err = store.commit(&id, 0).unwrap_err();
    fault::clear();
    assert_eq!(err.code, "PERSIST_REPLACE_FAILED");
    assert_eq!(err.stage, Some("replace"));
    assert!(store.row(&id).unwrap().formal.is_none());
    assert!(store.row(&id).unwrap().draft.is_some());
    assert_eq!(store.state_json().dump(), before);
    assert_eq!(fs::read(tmp.path().join("state.json")).unwrap(), bytes);
    assert_eq!(store.last_durability(), &durability);
    assert_no_temps(tmp.path());

    let reopened = Store::open(tmp.path()).unwrap();
    assert!(reopened.row(&id).unwrap().formal.is_none());
    assert!(reopened.row(&id).unwrap().draft.is_some());
    assert_eq!(reopened.state_json().dump(), before);
    assert_no_temps(tmp.path());
}

fn save_failure(name: &str, point: FaultPoint, code: &str, stage: &str) {
    let tmp = TempRoot::new(name);
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "旧标题", "旧正文", "2026-11-09", None)
        .unwrap();
    let path = tmp.path().join("state.json");
    let bytes = fs::read(&path).unwrap();
    let before = store.state_json().dump();
    let durability = store.last_durability().clone();

    fault::set(point);
    let err = store
        .save_draft(&row.record_id, Some("新标题"), Some("新正文"), None, None)
        .unwrap_err();
    fault::clear();
    assert_eq!(err.code, code);
    assert_eq!(err.stage, Some(stage));
    let after = fs::read(&path).unwrap();
    assert_eq!(sha256::hex_digest(&after), sha256::hex_digest(&bytes));
    assert_eq!(after, bytes);
    assert_eq!(store.state_json().dump(), before);
    assert_eq!(store.last_durability(), &durability);
    // 重开前检查，避免启动清理掩盖写入清理失败。
    assert_no_temps(tmp.path());
    assert_eq!(Store::open(tmp.path()).unwrap().state_json().dump(), before);
}

#[test]
fn t_f1_temp_create_failure_keeps_state() {
    save_failure(
        "f1",
        FaultPoint::TempCreate,
        "PERSIST_TEMP_CREATE_FAILED",
        "temp_create",
    );
}

#[test]
fn t_f2_temp_write_failure_keeps_state() {
    save_failure(
        "f2",
        FaultPoint::TempWrite,
        "PERSIST_TEMP_WRITE_FAILED",
        "temp_write",
    );
}

#[test]
fn t_f3_temp_sync_failure_keeps_state() {
    save_failure(
        "f3",
        FaultPoint::TempSync,
        "PERSIST_TEMP_SYNC_FAILED",
        "temp_sync",
    );
}

#[test]
fn t_f4_replace_failure_keeps_state() {
    save_failure(
        "f4",
        FaultPoint::Replace,
        "PERSIST_REPLACE_FAILED",
        "replace",
    );
}

#[test]
fn t_f5_parent_sync_failure_reports_uncertain() {
    let tmp = TempRoot::new("f5");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "标题", "旧正文", "2026-11-09", None)
        .unwrap();
    fault::set(FaultPoint::ParentSync);
    store
        .save_draft(&row.record_id, None, Some("新正文"), None, None)
        .unwrap();
    fault::clear();
    match store.last_durability() {
        Durability::Uncertain { error } => assert!(error.contains("injected fault")),
        durability => panic!("目录同步失败应为 uncertain：{durability:?}"),
    }
    assert_eq!(store.last_durability().as_str(), "uncertain");
    assert_no_temps(tmp.path());
    let reopened = Store::open(tmp.path()).unwrap();
    assert_eq!(
        reopened
            .row(&row.record_id)
            .unwrap()
            .draft
            .as_ref()
            .unwrap()
            .body,
        "新正文"
    );
    assert_eq!(reopened.state_json().dump(), store.state_json().dump());
}

#[test]
fn commit_parent_sync_failure_keeps_committed_state() {
    let tmp = TempRoot::new("commit-uncertain");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "标题", "正文", "2026-11-09", None)
        .unwrap();
    fault::set(FaultPoint::ParentSync);
    let outcome = store.commit(&row.record_id, 0).unwrap();
    fault::clear();
    assert!(matches!(outcome.durability, Durability::Uncertain { .. }));
    assert_eq!(&outcome.durability, store.last_durability());
    assert!(store.row(&row.record_id).unwrap().draft.is_none());
    assert!(store.row(&row.record_id).unwrap().formal.is_some());
    assert_no_temps(tmp.path());
    let reopened = Store::open(tmp.path()).unwrap();
    assert_eq!(reopened.state_json().dump(), store.state_json().dump());
}
