//! 分阶段原子写入；替换成功后的同步失败不能回滚。

use crate::fault::{self, FaultPoint};
use crate::model::CoreError;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Durability {
    Durable,
    ParentSyncUnsupported,
    Uncertain { error: String },
}

impl Durability {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Durable => "durable",
            Self::ParentSyncUnsupported => "parentSyncUnsupported",
            Self::Uncertain { .. } => "uncertain",
        }
    }
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<Durability, CoreError> {
    write_atomic_inner(path, |file| file.write_all(bytes), None)
}

pub(crate) fn write_atomic_restore(path: &Path, source: &Path) -> Result<Durability, CoreError> {
    let mut source = File::open(source)?;
    write_atomic_inner(
        path,
        |output| {
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let n = source.read(&mut buffer)?;
                if n == 0 {
                    return Ok(());
                }
                output.write_all(&buffer[..n])?;
            }
        },
        Some(FaultPoint::RestoreSwitchState),
    )
}

fn write_atomic_inner(
    path: &Path,
    write: impl FnOnce(&mut File) -> std::io::Result<()>,
    before_replace: Option<FaultPoint>,
) -> Result<Durability, CoreError> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let counter = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".tmp-shiguang-{}-{counter}", std::process::id()));
    let temp_error = |error| {
        CoreError::with_stage(
            "PERSIST_TEMP_CREATE_FAILED",
            "temp_create",
            format!("创建临时文件失败：{error}"),
        )
    };
    fault::hit(FaultPoint::TempCreate).map_err(temp_error)?;
    // create_new 失败时文件不属于本次写入，不能删除。
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(temp_error)?;
    let result = (|| {
        fault::hit(FaultPoint::TempWrite)
            .and_then(|()| write(&mut file))
            .map_err(|e| {
                CoreError::with_stage(
                    "PERSIST_TEMP_WRITE_FAILED",
                    "temp_write",
                    format!("写入临时文件失败：{e}"),
                )
            })?;
        fault::hit(FaultPoint::TempSync)
            .and_then(|()| file.sync_all())
            .map_err(|e| {
                CoreError::with_stage(
                    "PERSIST_TEMP_SYNC_FAILED",
                    "temp_sync",
                    format!("同步临时文件失败：{e}"),
                )
            })?;
        // Windows 删除/替换前也先关闭句柄。
        drop(file);
        if let Some(point) = before_replace {
            fault::hit(point).map_err(|e| {
                CoreError::with_stage("PERSIST_REPLACE_FAILED", "replace", e.to_string())
            })?;
        }
        fault::hit(FaultPoint::Replace)
            .and_then(|()| replace_file(&tmp, path))
            .map_err(|e| {
                CoreError::with_stage(
                    "PERSIST_REPLACE_FAILED",
                    "replace",
                    format!("替换文件失败：{e}"),
                )
            })
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    Ok(parent_sync(dir))
}

#[cfg(not(windows))]
fn replace_file(source: &Path, dest: &Path) -> std::io::Result<()> {
    fs::rename(source, dest)
}

// std::fs::rename cannot replace an existing target on Windows. MoveFileExW
// preserves the same atomic replacement semantics without a remove/rename gap.
#[cfg(windows)]
fn replace_file(source: &Path, dest: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let dest: Vec<u16> = dest.as_os_str().encode_wide().chain(Some(0)).collect();
    // Both buffers are NUL terminated and live until the synchronous call returns.
    if unsafe { MoveFileExW(source.as_ptr(), dest.as_ptr(), 1 | 8) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(crate) fn parent_sync(dir: &Path) -> Durability {
    if let Err(error) = fault::hit(FaultPoint::ParentSync) {
        return Durability::Uncertain {
            error: error.to_string(),
        };
    }
    #[cfg(unix)]
    {
        match File::open(dir).and_then(|file| file.sync_all()) {
            Ok(()) => Durability::Durable,
            Err(error) => Durability::Uncertain {
                error: error.to_string(),
            },
        }
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Durability::ParentSyncUnsupported
    }
}
