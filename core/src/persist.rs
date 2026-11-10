//! 分阶段原子写入；替换成功后的同步失败不能回滚。

use crate::fault::{self, FaultPoint};
use crate::model::CoreError;
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::Write;
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
            .and_then(|()| file.write_all(bytes))
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
        fault::hit(FaultPoint::Replace)
            .and_then(|()| fs::rename(&tmp, path))
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
