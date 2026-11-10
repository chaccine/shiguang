//! 进程级“打开一次”的数据槽（Unit-0.7 热修复）。
//!
//! 背景：Android 上 Activity 被系统重建（例如 SAF 文件选择器返回、MIUI 回收后台界面）时，
//! 宿主可能在同一进程里再次执行应用入口；前端也可能在入口的 setup 完成前就发起命令。
//! 旧实现只在 setup 里 `manage()`，于是命令报 “state not managed …”，且同一进程内
//! 第二次打开会撞上仍被旧实例持有的进程内锁。
//!
//! `OpenOnce<T>` 在进程里只创建一次、在注册命令前就可交给宿主管理：
//! - `begin()` 只有第一次返回 true（只打开一次数据目录，重复入口复用同一个 Store）；
//! - 打开完成前，`wait_lock()` 会等待（有超时），而不是报“未管理”或抢先读到半成品；
//! - 打开失败时保存真实错误（锁、迁移、数据损坏……），之后的命令都返回这个可操作的错误。
use crate::CoreError;
use std::ops::{Deref, DerefMut};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const STORE_STARTING: &str = "STORE_STARTING";

struct Inner<T> {
    started: bool,
    finished: bool,
    value: Result<T, CoreError>,
}

pub struct OpenOnce<T> {
    inner: Mutex<Inner<T>>,
    ready: Condvar,
}

/// 已完成打开（成功或失败）时的独占访问；解引用为 `Result<T, CoreError>`。
pub struct ReadyGuard<'a, T> {
    guard: MutexGuard<'a, Inner<T>>,
}

impl<T> Deref for ReadyGuard<'_, T> {
    type Target = Result<T, CoreError>;
    fn deref(&self) -> &Self::Target {
        &self.guard.value
    }
}
impl<T> DerefMut for ReadyGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.guard.value
    }
}

fn starting_error() -> CoreError {
    CoreError::new(
        STORE_STARTING,
        "拾光还在打开你的数据，请稍等几秒再试。数据没有被改动。",
    )
}

impl<T> Default for OpenOnce<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> OpenOnce<T> {
    pub const fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                started: false,
                finished: false,
                value: Err(CoreError {
                    code: STORE_STARTING,
                    stage: None,
                    message: String::new(),
                }),
            }),
            ready: Condvar::new(),
        }
    }

    fn lock_inner(&self) -> MutexGuard<'_, Inner<T>> {
        // 某个命令 panic 不应让后续所有命令都失败：数据本身由 Store 的原子写保护。
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 只有第一次调用返回 true；调用方随后必须调用 `finish`。
    pub fn begin(&self) -> bool {
        let mut inner = self.lock_inner();
        if inner.started {
            return false;
        }
        inner.started = true;
        true
    }

    pub fn finish(&self, value: Result<T, CoreError>) {
        let mut inner = self.lock_inner();
        inner.value = value;
        inner.finished = true;
        drop(inner);
        self.ready.notify_all();
    }

    pub fn is_finished(&self) -> bool {
        self.lock_inner().finished
    }

    /// 等待打开完成（最多 `timeout`），返回独占访问；超时返回 STORE_STARTING。
    pub fn wait_lock_for(&self, timeout: Duration) -> Result<ReadyGuard<'_, T>, CoreError> {
        let deadline = Instant::now() + timeout;
        let mut inner = self.lock_inner();
        while !inner.finished {
            let now = Instant::now();
            if now >= deadline {
                return Err(starting_error());
            }
            inner = match self.ready.wait_timeout(inner, deadline - now) {
                Ok((g, _)) => g,
                Err(p) => p.into_inner().0,
            };
        }
        Ok(ReadyGuard { guard: inner })
    }

    /// 默认最多等 90 秒（大量照片的启动核查也足够）。
    pub fn wait_lock(&self) -> Result<ReadyGuard<'_, T>, CoreError> {
        self.wait_lock_for(Duration::from_secs(90))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn begin_only_once_and_waiters_see_result() {
        let slot: Arc<OpenOnce<u32>> = Arc::new(OpenOnce::new());
        assert!(slot.begin());
        assert!(!slot.begin(), "second entry must reuse, not reopen");
        let s2 = slot.clone();
        let waiter = std::thread::spawn(move || *s2.wait_lock().unwrap().as_ref().unwrap());
        std::thread::sleep(Duration::from_millis(30));
        slot.finish(Ok(7));
        assert_eq!(waiter.join().unwrap(), 7);
    }

    #[test]
    fn timeout_reports_starting_not_panic() {
        let slot: OpenOnce<u32> = OpenOnce::new();
        let err = slot.wait_lock_for(Duration::from_millis(10)).err().unwrap();
        assert_eq!(err.code, STORE_STARTING);
        assert!(!err.message.is_empty());
    }

    #[test]
    fn failure_is_kept_and_actionable() {
        let slot: OpenOnce<u32> = OpenOnce::new();
        slot.begin();
        slot.finish(Err(CoreError::new("STORE_LOCKED", "x")));
        let g = slot.wait_lock().unwrap();
        assert_eq!(g.as_ref().err().unwrap().code, "STORE_LOCKED");
    }
}
