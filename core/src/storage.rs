//! Read-only local usage. Symlinks are never traversed; no cleanup or deletion API.
use crate::{json::Json, CoreError, Store};
use std::{fs, path::Path};
#[derive(Debug, Default, PartialEq, Eq)]
pub struct StorageStats {
    pub media: u64,
    pub previews: u64,
    pub backups: u64,
    pub data: u64,
    pub other: u64,
    pub total: u64,
    pub skipped_symlinks: u64,
}
impl StorageStats {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("media", Json::Num(self.media as i64)),
            ("previews", Json::Num(self.previews as i64)),
            ("backups", Json::Num(self.backups as i64)),
            ("data", Json::Num(self.data as i64)),
            ("other", Json::Num(self.other as i64)),
            ("total", Json::Num(self.total as i64)),
            ("skippedSymlinks", Json::Num(self.skipped_symlinks as i64)),
            ("available", Json::Null),
        ])
    }
}
impl Store {
    pub fn storage_stats(&self) -> Result<StorageStats, CoreError> {
        let root = self.root().canonicalize()?;
        let mut stats = StorageStats::default();
        walk(&root, &root, &mut stats)?;
        Ok(stats)
    }
}
fn walk(root: &Path, dir: &Path, stats: &mut StorageStats) -> Result<(), CoreError> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let meta = fs::symlink_metadata(&path)?;
        if meta.file_type().is_symlink() {
            stats.skipped_symlinks += 1;
            continue;
        }
        // Also reject paths which resolve outside the root (e.g. ancestor replacement).
        let resolved = path.canonicalize()?;
        if !resolved.starts_with(root) {
            continue;
        }
        if meta.is_dir() {
            walk(root, &resolved, stats)?;
        } else if meta.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| CoreError::new("STORAGE_PATH", "存储路径无效"))?;
            let first = relative.components().next().unwrap().as_os_str();
            let bucket = if first == "media" {
                &mut stats.media
            } else if first == "previews" {
                &mut stats.previews
            } else if first == "backups" {
                &mut stats.backups
            } else if relative == Path::new("state.json") {
                &mut stats.data
            } else {
                &mut stats.other
            };
            *bucket += meta.len();
            stats.total += meta.len();
        }
    }
    Ok(())
}
