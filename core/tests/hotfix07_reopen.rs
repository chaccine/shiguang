//! Unit-0.7 热修复回归：0.1.5 Android“导出备份后无法打开”。
//! 用 fault-injection 让系统锁返回 Unsupported 以模拟 Android 的可移植锁路径。
//! 覆盖：导出后重开、导出中途失败后重开、导出时进程被杀（锁 owner 残留）后重开、
//! 选择器取消（不触碰数据）、同一进程第二次进入入口复用同一个 Store（OpenOnce）。
#![cfg(feature = "fault-injection")]
mod unit05_support;
use shiguang_core::fault::{self, FaultPoint};
use shiguang_core::lock;
use shiguang_core::session::OpenOnce;
use shiguang_core::Store;
use std::fs;
use std::sync::Arc;
use unit05_support::*;

fn android() {
    lock::force_unsupported(true);
}

#[test]
fn export_then_reopen_keeps_data_and_opens() {
    android();
    let a = Temp::new("hf-export-reopen");
    let f = Temp::new("hf-export-reopen-file");
    let s = seeded(&a.0, "合成正文");
    let before = live_tree(&a.0);
    s.export_backup(&f.0.join("b.sgbak"), "0.1.7").unwrap();
    assert!(
        !a.0.join(".write.lock.owner").exists(),
        "导出结束必须释放写锁"
    );
    drop(s);
    assert!(!a.0.join(".instance.lock.owner").exists());
    let s = Store::open_exclusive(&a.0).expect("导出后必须能重新打开");
    assert_eq!(s.list_formal().len(), 1);
    assert_eq!(live_tree(&a.0), before, "导出不得改动数据目录");
}

#[test]
fn encrypted_export_then_reopen() {
    android();
    let a = Temp::new("hf-enc-reopen");
    let f = Temp::new("hf-enc-reopen-file");
    let s = seeded(&a.0, "合成正文");
    let before = live_tree(&a.0);
    s.export_backup_encrypted(
        &f.0.join("b.sgbak"),
        "0.1.7",
        "synthetic-pass",
        shiguang_core::KdfParams::fast(),
    )
    .unwrap();
    drop(s);
    let s = Store::open_exclusive(&a.0).expect("加密导出后必须能重新打开");
    assert_eq!(s.list_formal().len(), 1);
    assert_eq!(live_tree(&a.0), before);
}

#[test]
fn interrupted_export_then_reopen() {
    android();
    for point in [FaultPoint::BackupWrite, FaultPoint::BackupFinalize] {
        let a = Temp::new("hf-export-fail");
        let f = Temp::new("hf-export-fail-file");
        let s = seeded(&a.0, "合成正文");
        let before = live_tree(&a.0);
        fault::set(point);
        assert!(s.export_backup(&f.0.join("b.sgbak"), "0.1.7").is_err());
        fault::clear();
        assert!(
            !a.0.join(".write.lock.owner").exists(),
            "失败路径也必须释放写锁"
        );
        drop(s);
        let s = Store::open_exclusive(&a.0).expect("导出失败后必须能重新打开");
        assert_eq!(s.list_formal().len(), 1);
        assert_eq!(live_tree(&a.0), before);
    }
}

// 陈旧 owner 的判定依赖 /proc（Android / Linux）；没有 /proc 的平台按设计
// 从不抢占未知 owner（见 lock.rs without_proc_an_unknown_owner_is_never_stolen）。
#[cfg(any(target_os = "linux", target_os = "android"))]
#[test]
fn process_killed_during_export_then_reopen() {
    android();
    let a = Temp::new("hf-killed");
    let f = Temp::new("hf-killed-file");
    let s = seeded(&a.0, "合成正文");
    let before = live_tree(&a.0);
    drop(s);
    // 被杀进程残留：两把锁的 owner 文件（不存在的 pid）+ 目标目录里的半个导出文件。
    let dead = "4194302 12345 0\n";
    fs::write(a.0.join(".instance.lock.owner"), dead).unwrap();
    fs::write(a.0.join(".write.lock.owner"), dead).unwrap();
    fs::write(f.0.join(".b.sgbak.partial-4194302"), b"synthetic partial").unwrap();
    let mut s = Store::open_exclusive(&a.0).expect("被杀进程留下的锁必须可接管");
    assert_eq!(s.list_formal().len(), 1);
    // 写操作也能拿到写锁（接管写锁 owner）。
    let id = draft(&mut s, "被杀后仍可写");
    s.commit(&id, 0).unwrap();
    assert_eq!(s.list_formal().len(), 2);
    drop(s);
    let _ = before;
}

#[test]
fn picker_cancel_touches_nothing() {
    // 选择器取消时 Tauri 层在导出前就返回 cancelled；core 只做过一次可用性检查（只读）。
    android();
    let a = Temp::new("hf-cancel");
    let s = seeded(&a.0, "合成正文");
    let before = live_tree(&a.0);
    assert!(s.row(&s.list_formal()[0].record_id).is_ok());
    drop(s);
    assert_eq!(live_tree(&a.0), before);
    Store::open_exclusive(&a.0).expect("取消后可正常打开");
}

#[test]
fn second_entry_in_same_process_reuses_store_instead_of_store_locked() {
    android();
    let a = Temp::new("hf-reentry");
    drop(seeded(&a.0, "合成正文"));
    let slot: Arc<OpenOnce<Store>> = Arc::new(OpenOnce::new());
    // 第一次进入入口：打开。
    assert!(slot.begin());
    slot.finish(Store::open_exclusive(&a.0));
    // Activity 重建 → 第二次进入入口：不再打开（旧实现在这里会撞上进程内锁）。
    assert!(!slot.begin());
    let g = slot.wait_lock().unwrap();
    assert_eq!(g.as_ref().expect("复用同一个 Store").list_formal().len(), 1);
    drop(g);
    // 对照：旧实现第二次直接打开会被拒绝（证明根因）。
    let e = Store::open_exclusive(&a.0)
        .err()
        .expect("同进程第二个实例被锁拒绝");
    assert_eq!(e.code, "STORE_LOCKED");
}

#[test]
fn commands_arriving_before_open_finishes_wait_instead_of_failing() {
    android();
    let a = Temp::new("hf-early");
    drop(seeded(&a.0, "合成正文"));
    let slot: Arc<OpenOnce<Store>> = Arc::new(OpenOnce::new());
    assert!(slot.begin());
    let early = {
        let slot = slot.clone();
        std::thread::spawn(move || {
            slot.wait_lock()
                .unwrap()
                .as_ref()
                .map(|s| s.list_formal().len())
                .unwrap()
        })
    };
    std::thread::sleep(std::time::Duration::from_millis(50));
    let root = a.0.clone();
    std::thread::spawn({
        let slot = slot.clone();
        move || {
            lock::force_unsupported(true);
            slot.finish(Store::open_exclusive(&root))
        }
    })
    .join()
    .unwrap();
    assert_eq!(early.join().unwrap(), 1);
}
