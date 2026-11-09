//! 数据目录锁：`.instance.lock`（实例独占）与 `.write.lock`（事务写锁）。
//!
//! 首选 `std::fs::File::try_lock`（Linux/macOS/Windows 上为 flock/LockFileEx）。
//! Rust std 在 Android 上没有实现文件锁，`try_lock` 恒返回
//! `ErrorKind::Unsupported`（"try_lock() not supported"）。只在**收到 Unsupported 时**
//! 才改用可移植锁，桌面端行为与语义不变：
//!
//! 1. 进程内注册表（静态 Mutex<HashSet>）：同一进程内的第二个持有者一定被拒绝；
//!    Android 应用是单进程，这一层已覆盖所有能发生的并发。
//! 2. 旁路文件 `<name>.owner`（create_new 原子创建），内容为
//!    `pid starttime unix_ms`，用于跨进程互斥；残留文件在以下情况视为过期并接管：
//!    - 记录的 pid 是当前进程（进程内注册表中没有 → 是上次同 pid 进程留下的）；
//!    - `/proc/<pid>/stat` 不存在（进程已退出），或其 starttime 与记录不符（pid 被复用）；
//!    - 内容无法解析且文件已超过 10 秒（写到一半崩溃）。
//!
//! 没有 /proc 的平台上，无法确认对方已退出时一律视为被占用（宁可拒绝，绝不无锁写入）。
//!
//! 已知局限：两个**不同进程**同时判定同一份残留为过期时存在极小的 TOCTOU 窗口；
//! 只在没有系统文件锁的平台（Android，单进程）上才会走到这里。

use crate::model::CoreError;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 持有期间保持锁；drop 时释放（系统锁随句柄关闭释放，可移植锁删除旁路文件）。
pub struct LockGuard {
    _file: File,
    portable: Option<PortableHold>,
}

struct PortableHold {
    key: PathBuf,
    owner: PathBuf,
}

impl LockGuard {
    /// 是否走了可移植锁（系统不支持文件锁时）。
    pub fn is_portable(&self) -> bool {
        self.portable.is_some()
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        if let Some(hold) = self.portable.take() {
            let mut held = registry().lock().unwrap_or_else(|p| p.into_inner());
            let _ = fs::remove_file(&hold.owner);
            held.remove(&hold.key);
        }
    }
}

pub enum Acquire {
    Held(LockGuard),
    Busy,
}

fn registry() -> &'static Mutex<HashSet<PathBuf>> {
    static HELD: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    HELD.get_or_init(|| Mutex::new(HashSet::new()))
}

fn open_lock_file(root: &Path, name: &str) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join(name))
}

// 测试钩子：fault-injection 下可让当前线程的系统锁返回 Unsupported，模拟 Android。
#[cfg(feature = "fault-injection")]
std::thread_local! {
    static FORCE_UNSUPPORTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(feature = "fault-injection")]
pub fn force_unsupported(on: bool) {
    FORCE_UNSUPPORTED.with(|f| f.set(on));
}

fn os_try_lock(file: &File) -> Result<bool, io::Error> {
    #[cfg(feature = "fault-injection")]
    if FORCE_UNSUPPORTED.with(|f| f.get()) {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "try_lock() not supported",
        ));
    }
    match file.try_lock() {
        Ok(()) => Ok(true),
        Err(fs::TryLockError::WouldBlock) => Ok(false),
        Err(fs::TryLockError::Error(e)) => Err(e),
    }
}

/// 尝试获取 `root/name` 锁；被占用返回 `Busy`，其它 IO 错误原样返回。
pub fn try_acquire(root: &Path, name: &str) -> Result<Acquire, CoreError> {
    let file = open_lock_file(root, name)?;
    match os_try_lock(&file) {
        Ok(true) => Ok(Acquire::Held(LockGuard {
            _file: file,
            portable: None,
        })),
        Ok(false) => Ok(Acquire::Busy),
        Err(e) if e.kind() == io::ErrorKind::Unsupported => {
            Ok(portable_acquire(root, name, file, &proc_root())?)
        }
        Err(e) => Err(e.into()),
    }
}

fn proc_root() -> PathBuf {
    PathBuf::from("/proc")
}

fn owner_path(root: &Path, name: &str) -> PathBuf {
    root.join(format!("{name}.owner"))
}

fn registry_key(root: &Path, name: &str) -> PathBuf {
    fs::canonicalize(root)
        .unwrap_or_else(|_| root.to_path_buf())
        .join(name)
}

fn portable_acquire(
    root: &Path,
    name: &str,
    file: File,
    proc: &Path,
) -> io::Result<Acquire> {
    let key = registry_key(root, name);
    let owner = owner_path(root, name);
    // 整个获取过程持有注册表锁：同进程内的竞争在这里串行化。
    let mut held = registry().lock().unwrap_or_else(|p| p.into_inner());
    if held.contains(&key) {
        return Ok(Acquire::Busy);
    }
    for _ in 0..2 {
        match OpenOptions::new().write(true).create_new(true).open(&owner) {
            Ok(mut f) => {
                let line = format!(
                    "{} {} {}\n",
                    std::process::id(),
                    self_starttime(proc).unwrap_or(0),
                    unix_ms()
                );
                if let Err(e) = f.write_all(line.as_bytes()).and_then(|_| f.sync_all()) {
                    let _ = fs::remove_file(&owner);
                    return Err(e);
                }
                held.insert(key.clone());
                return Ok(Acquire::Held(LockGuard {
                    _file: file,
                    portable: Some(PortableHold { key, owner }),
                }));
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                if !is_stale(&owner, proc) {
                    return Ok(Acquire::Busy);
                }
                match fs::remove_file(&owner) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
            }
            Err(e) => return Err(e),
        }
    }
    Ok(Acquire::Busy)
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// `/proc/<pid>/stat` 第 22 字段（进程启动时间，时钟滴答）。
fn starttime(proc: &Path, pid: &str) -> Option<u64> {
    let stat = fs::read_to_string(proc.join(pid).join("stat")).ok()?;
    let after = &stat[stat.rfind(')')? + 1..];
    after.split_whitespace().nth(19)?.parse().ok()
}

fn self_starttime(proc: &Path) -> Option<u64> {
    starttime(proc, &std::process::id().to_string())
}

fn is_stale(owner: &Path, proc: &Path) -> bool {
    let content = match fs::read_to_string(owner) {
        Ok(c) => c,
        // 刚被持有者释放：交给下一轮 create_new 重试。
        Err(e) if e.kind() == io::ErrorKind::NotFound => return true,
        Err(_) => return false,
    };
    let mut parts = content.split_whitespace();
    let parsed = (
        parts.next().and_then(|p| p.parse::<u32>().ok()),
        parts.next().and_then(|s| s.parse::<u64>().ok()),
    );
    let (pid, recorded_start) = match parsed {
        (Some(pid), Some(start)) => (pid, start),
        _ => {
            // 写到一半崩溃留下的残缺内容：超过 10 秒才接管。
            let age = fs::metadata(owner)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok());
            return age.is_some_and(|a| a > Duration::from_secs(10));
        }
    };
    if pid == std::process::id() {
        // 调用方已确认进程内注册表里没有这把锁 → 是旧进程（同 pid）残留。
        return true;
    }
    if !proc.join("self").exists() && !proc.join("1").exists() {
        // 没有 /proc：无法判断对方是否存活，保守地视为占用。
        return false;
    }
    match starttime(proc, &pid.to_string()) {
        None => !proc.join(pid.to_string()).exists(),
        Some(now_start) => recorded_start != 0 && now_start != recorded_start,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "shiguang-lock-{name}-{}-{}",
            std::process::id(),
            unix_ms()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn acquire_portable(root: &Path, name: &str, proc: &Path) -> Acquire {
        let file = open_lock_file(root, name).unwrap();
        portable_acquire(root, name, file, proc).unwrap()
    }

    fn fake_proc(root: &Path, pid: u32, start: u64) -> PathBuf {
        let proc = root.join("fake-proc");
        fs::create_dir_all(proc.join("1")).unwrap();
        let dir = proc.join(pid.to_string());
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("stat"),
            format!("{pid} (app (x)) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 {start} 0 0"),
        )
        .unwrap();
        proc
    }

    #[test]
    fn unsupported_falls_back_and_rejects_second_holder_in_process() {
        let root = temp("inproc");
        let first = acquire_portable(&root, ".write.lock", &proc_root());
        let Acquire::Held(guard) = first else { panic!("first must hold") };
        assert!(guard.is_portable());
        assert!(owner_path(&root, ".write.lock").exists());
        assert!(matches!(
            acquire_portable(&root, ".write.lock", &proc_root()),
            Acquire::Busy
        ));
        drop(guard);
        assert!(!owner_path(&root, ".write.lock").exists());
        assert!(matches!(
            acquire_portable(&root, ".write.lock", &proc_root()),
            Acquire::Held(_)
        ));
    }

    #[test]
    fn stale_owner_from_dead_process_is_taken_over() {
        let root = temp("dead");
        let proc = fake_proc(&root, 4242, 77);
        // 999999 在假 /proc 中不存在 → 已退出。
        fs::write(owner_path(&root, ".instance.lock"), "999999 5 0\n").unwrap();
        assert!(matches!(
            acquire_portable(&root, ".instance.lock", &proc),
            Acquire::Held(_)
        ));
    }

    #[test]
    fn live_other_process_owner_blocks_and_pid_reuse_is_detected() {
        let root = temp("live");
        let proc = fake_proc(&root, 4242, 77);
        fs::write(owner_path(&root, ".instance.lock"), "4242 77 0\n").unwrap();
        assert!(matches!(
            acquire_portable(&root, ".instance.lock", &proc),
            Acquire::Busy
        ));
        assert_eq!(
            fs::read_to_string(owner_path(&root, ".instance.lock")).unwrap(),
            "4242 77 0\n",
            "被拒绝时不得改动对方的锁文件"
        );
        // 同 pid 但启动时间不同 → pid 被复用，旧锁过期。
        fs::write(owner_path(&root, ".instance.lock"), "4242 76 0\n").unwrap();
        assert!(matches!(
            acquire_portable(&root, ".instance.lock", &proc),
            Acquire::Held(_)
        ));
    }

    #[test]
    fn without_proc_an_unknown_owner_is_never_stolen() {
        let root = temp("noproc");
        let proc = root.join("no-proc-here");
        fs::write(owner_path(&root, ".write.lock"), "4242 77 0\n").unwrap();
        assert!(matches!(
            acquire_portable(&root, ".write.lock", &proc),
            Acquire::Busy
        ));
    }

    #[test]
    fn own_pid_leftover_is_stale_and_fresh_garbage_is_not() {
        let root = temp("ownpid");
        fs::write(
            owner_path(&root, ".write.lock"),
            format!("{} 1 0\n", std::process::id()),
        )
        .unwrap();
        assert!(matches!(
            acquire_portable(&root, ".write.lock", &proc_root()),
            Acquire::Held(_)
        ));
        fs::write(owner_path(&root, ".instance.lock"), "garbage").unwrap();
        assert!(matches!(
            acquire_portable(&root, ".instance.lock", &proc_root()),
            Acquire::Busy
        ));
    }

    #[test]
    fn real_proc_starttime_parses_for_self() {
        if Path::new("/proc/self/stat").exists() {
            assert!(self_starttime(&proc_root()).is_some());
        }
    }
}
