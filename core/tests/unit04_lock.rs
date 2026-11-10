mod unit04_support;
use shiguang_core::Store;
use std::fs;
use unit04_support::*;

#[test]
fn exclusive_instances_exclude_each_other_and_drop_releases_lock() {
    let t = TempRoot::new("exclusive");
    let first = Store::open_exclusive(t.path()).unwrap();
    let error = Store::open_exclusive(t.path())
        .err()
        .expect("second instance must fail");
    assert_eq!(error.code, "STORE_LOCKED");
    assert_eq!(error.message, "拾光已在另一个窗口或程序中打开。为保护你的数据，这里暂不能写入，请先关闭另一个窗口再重新打开。");
    drop(first);
    let _third = Store::open_exclusive(t.path()).unwrap();
}

#[test]
fn rejected_exclusive_open_never_cleans_or_changes_any_file() {
    let t = TempRoot::new("exclusive-no-write");
    let mut first = Store::open_exclusive(t.path()).unwrap();
    draft(&mut first);
    fs::write(t.path().join(".tmp-owned-by-writer"), b"synthetic partial").unwrap();
    let before = tree(t.path());
    assert_eq!(
        Store::open_exclusive(t.path()).err().unwrap().code,
        "STORE_LOCKED"
    );
    assert_eq!(tree(t.path()), before);
}
