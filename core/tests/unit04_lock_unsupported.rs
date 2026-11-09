//! 模拟 Android：std 文件锁返回 ErrorKind::Unsupported 时走可移植锁。
#![cfg(feature = "fault-injection")]
mod unit04_support;
use shiguang_core::lock::{self, Acquire};
use shiguang_core::Store;
use std::fs;
use unit04_support::*;

fn unsupported() {
    lock::force_unsupported(true);
}

#[test]
fn unsupported_lock_never_blocks_startup_and_writes_work() {
    let t = TempRoot::new("unsupported-open");
    unsupported();
    // 0.1.2 在 Android 上留下的空锁文件不影响启动。
    fs::write(t.path().join(".instance.lock"), b"").unwrap();
    fs::write(t.path().join(".write.lock"), b"").unwrap();
    let mut s = Store::open_exclusive(t.path()).expect("Unsupported 不得成为启动拦截");
    let id = formal(&mut s);
    assert!(s.formal(&id).is_some());
    s.reconcile_media().expect("独占实例可做媒体核对");
    assert!(t.path().join(".instance.lock.owner").exists());
    assert!(!t.path().join(".write.lock.owner").exists(), "事务结束释放写锁");
    drop(s);
    assert!(!t.path().join(".instance.lock.owner").exists());
    let s = Store::open_exclusive(t.path()).unwrap();
    assert_eq!(s.list_formal().len(), 1);
}

#[test]
fn unsupported_lock_still_rejects_second_instance_without_touching_files() {
    let t = TempRoot::new("unsupported-second");
    unsupported();
    let mut first = Store::open_exclusive(t.path()).unwrap();
    draft(&mut first);
    fs::write(t.path().join(".tmp-owned-by-writer"), b"synthetic partial").unwrap();
    let before = tree(t.path());
    let owner = fs::read(t.path().join(".instance.lock.owner")).unwrap();
    let e = Store::open_exclusive(t.path()).err().expect("second instance must fail");
    assert_eq!(e.code, "STORE_LOCKED");
    assert_eq!(tree(t.path()), before);
    assert_eq!(fs::read(t.path().join(".instance.lock.owner")).unwrap(), owner);
    drop(first);
    Store::open_exclusive(t.path()).unwrap();
}

#[test]
fn unsupported_lock_second_instance_on_other_thread_is_rejected() {
    let t = TempRoot::new("unsupported-thread");
    unsupported();
    let _first = Store::open_exclusive(t.path()).unwrap();
    let root = t.path().to_path_buf();
    let code = std::thread::spawn(move || {
        lock::force_unsupported(true);
        Store::open_exclusive(root).err().map(|e| e.code)
    })
    .join()
    .unwrap();
    assert_eq!(code.as_deref(), Some("STORE_LOCKED"));
}

#[test]
fn unsupported_write_lock_held_elsewhere_blocks_commit_without_changes() {
    let t = TempRoot::new("unsupported-busy");
    unsupported();
    let mut s = Store::open_exclusive(t.path()).unwrap();
    let id = draft(&mut s);
    let before = tree(t.path());
    let Acquire::Held(guard) = lock::try_acquire(t.path(), ".write.lock").unwrap() else {
        panic!("test must hold write lock");
    };
    assert!(guard.is_portable());
    let e = s.commit(&id, 0).err().expect("commit must wait then fail");
    assert_eq!(e.code, "STORE_BUSY");
    assert_eq!(tree(t.path()), before);
    drop(guard);
    s.commit(&id, 0).unwrap();
}

#[test]
fn unsupported_lock_takes_over_stale_owner_left_by_crashed_process() {
    let t = TempRoot::new("unsupported-stale");
    unsupported();
    // pid 4194304 超出 Linux pid_max 上限，必然不存在。
    fs::write(t.path().join(".instance.lock.owner"), "4194304 1 0\n").unwrap();
    fs::write(t.path().join(".write.lock.owner"), "4194304 1 0\n").unwrap();
    let mut s = Store::open_exclusive(t.path()).expect("残留锁应被接管");
    formal(&mut s);
}

#[test]
fn supported_platform_never_creates_portable_owner_file() {
    let t = TempRoot::new("supported-native");
    lock::force_unsupported(false);
    let mut s = Store::open_exclusive(t.path()).unwrap();
    formal(&mut s);
    assert!(!t.path().join(".instance.lock.owner").exists());
    assert!(!t.path().join(".write.lock.owner").exists());
}
