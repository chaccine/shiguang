//! 本地持久化：状态文件原子写入 + media 原图目录 + 派生预览缓存。

use crate::json::{self, Json};
use crate::model::{
    ConflictChoice, ConflictCopy, CoreError, DeletionMarker, MediaIssue, MediaReport, PhotoStatus,
    PhotoUse, PurgeOutcome, QuarantinedMedia, RecordRow, RecordStatus, Snapshot,
};
use crate::persist::{self, Durability};
use crate::preview;
use crate::sha256;
use crate::time;
use crate::{
    fault::{self, FaultPoint},
    schema,
};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const STATE_FILE: &str = "state.json";
const MEDIA_DIR: &str = "media";
const PREVIEW_DIR: &str = "previews";
const STATE_VERSION: i64 = 1;

pub struct StoreConfig {
    pub root: PathBuf,
    pub seed: String,
}

impl StoreConfig {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let seed = std::env::var("SHIGUANG_SEED").unwrap_or_else(|_| "20261109".to_string());
        Self {
            root: root.into(),
            seed,
        }
    }
}

pub struct Store {
    root: PathBuf,
    seed: String,
    state: State,
    last_durability: Durability,
    instance_lock: Option<File>,
    pending_conflicts: std::collections::BTreeMap<String, (Snapshot, u32)>,
}

#[derive(Clone)]
struct State {
    version: i64,
    seq: u64,
    records: Vec<RecordRow>,
    deletion_markers: Vec<DeletionMarker>,
    conflict_copies: Vec<ConflictCopy>,
}

#[derive(Clone, Debug)]
pub struct CommitOutcome {
    pub record_id: String,
    pub content_revision: u32,
    pub committed_at: String,
    pub durability: Durability,
}

impl Store {
    pub fn open_exclusive(root: impl Into<PathBuf>) -> Result<Self, CoreError> {
        let root = root.into();
        preflight(&root)?;
        fs::create_dir_all(&root)?;
        let lock = lock_file(&root, ".instance.lock")?;
        match lock.try_lock() {
            Ok(()) => {},
            Err(std::fs::TryLockError::WouldBlock) => return Err(CoreError::new("STORE_LOCKED", "拾光已在另一个窗口或程序中打开。为保护你的数据，这里暂不能写入，请先关闭另一个窗口再重新打开。")),
            Err(std::fs::TryLockError::Error(e)) => return Err(e.into()),
        }
        let mut store = Self::open(root)?;
        store.instance_lock = Some(lock);
        Ok(store)
    }
    pub fn trash_record(&mut self, record_id: &str) -> Result<RecordRow, CoreError> {
        self.transact(|state| {
            let row = state.row_mut(record_id)?;
            if row.formal.is_none() {
                return Err(CoreError::new(
                    "RECORD_NOT_FORMAL",
                    "仅正式记录可以移到回收站",
                ));
            }
            row.status = RecordStatus::Trashed;
            row.trashed_at = Some(time::now_rfc3339());
            Ok(row.clone())
        })
        .map(|(row, _)| row)
    }
    pub fn restore_record(&mut self, record_id: &str) -> Result<RecordRow, CoreError> {
        self.transact(|state| {
            let row = state.any_row_mut(record_id)?;
            if row.status != RecordStatus::Trashed {
                return Err(CoreError::new("RECORD_NOT_TRASHED", "记录不在回收站"));
            }
            row.status = RecordStatus::Active;
            row.trashed_at = None;
            Ok(row.clone())
        })
        .map(|(row, _)| row)
    }
    pub fn list_trash(&self) -> Result<Vec<&RecordRow>, CoreError> {
        let mut rows: Vec<_> = self
            .state
            .records
            .iter()
            .filter(|r| r.status == RecordStatus::Trashed)
            .collect();
        rows.sort_by(|a, b| {
            b.trashed_at
                .cmp(&a.trashed_at)
                .then_with(|| b.record_id.cmp(&a.record_id))
        });
        Ok(rows)
    }
    pub fn purge_record(&mut self, record_id: &str) -> Result<PurgeOutcome, CoreError> {
        self.purge(Some(record_id))
    }
    pub fn empty_trash(&mut self) -> Result<PurgeOutcome, CoreError> {
        self.purge(None)
    }
    fn purge(&mut self, record_id: Option<&str>) -> Result<PurgeOutcome, CoreError> {
        let _write_lock = write_lock(&self.root)?;
        let mut candidate = self.candidate_state()?;
        if let Some(id) = record_id {
            if candidate.row(id)?.status != RecordStatus::Trashed {
                return Err(CoreError::new(
                    "RECORD_NOT_TRASHED",
                    "永久删除只允许用于回收站记录",
                ));
            }
        }
        let selected: Vec<_> = candidate
            .records
            .iter()
            .filter(|r| {
                r.status == RecordStatus::Trashed && record_id.is_none_or(|id| id == r.record_id)
            })
            .cloned()
            .collect();
        let assets: std::collections::BTreeSet<_> = selected
            .iter()
            .flat_map(|r| [r.formal.as_ref(), r.draft.as_ref()].into_iter().flatten())
            .flat_map(|s| s.photos.iter().map(|p| p.asset_id.clone()))
            .collect();
        let deleted_at = time::now_rfc3339();
        let markers: Vec<_> = selected
            .iter()
            .map(|r| DeletionMarker {
                record_id: r.record_id.clone(),
                deleted_at: deleted_at.clone(),
                last_content_revision: r.content_revision,
            })
            .collect();
        candidate
            .records
            .retain(|r| !markers.iter().any(|m| m.record_id == r.record_id));
        candidate.deletion_markers.extend(markers.clone());
        // 先持久化删除标记：若随后移动失败或崩溃，原图仍在原位，可再次核对隔离。
        if !markers.is_empty() {
            self.apply_candidate(candidate)?;
        }
        let referenced = self.state.referenced_assets();
        let mut quarantined = Vec::new();
        for path in media_files(&self.root)? {
            let asset = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            if assets.contains(asset) && !referenced.contains(asset) {
                quarantined.push(self.quarantine(&path)?);
            }
        }
        Ok(PurgeOutcome {
            deletion_markers: markers,
            quarantined,
        })
    }
    fn quarantine(&self, path: &Path) -> Result<QuarantinedMedia, CoreError> {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| CoreError::io("原图文件名无效"))?;
        let parent = self.root.join("media-quarantine");
        let dir = parent.join(timestamp());
        fs::create_dir_all(&dir)?;
        let dest = unique_path(&dir, name, "");
        // 同一数据根目录内 rename：不复制后删除，不覆盖已有隔离文件。
        fs::rename(path, &dest)?;
        for directory in [&dir, &parent, &self.root.join(MEDIA_DIR), &self.root] {
            if let Durability::Uncertain { error } = persist::parent_sync(directory) {
                return Err(CoreError::io(format!(
                    "原图已移入隔离区，但目录同步失败：{error}"
                )));
            }
        }
        Ok(QuarantinedMedia {
            asset_id: path
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|s| s.starts_with("ast-"))
                .map(str::to_string),
            file: format!("media/{name}"),
            moved_to: dest
                .strip_prefix(&self.root)
                .map_err(|e| CoreError::io(e.to_string()))?
                .to_string_lossy()
                .into_owned(),
        })
    }
    pub fn reconcile_media(&mut self) -> Result<MediaReport, CoreError> {
        if self.instance_lock.is_none() {
            return Err(CoreError::new(
                "STORE_NOT_EXCLUSIVE",
                "原图核对需要独占打开数据目录",
            ));
        }
        let _write_lock = write_lock(&self.root)?;
        let state = self.candidate_state()?;
        let referenced = state.referenced_assets();
        let mut report = MediaReport {
            checked_at: time::now_rfc3339(),
            ..MediaReport::default()
        };
        for path in media_files(&self.root)? {
            let asset = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            if !referenced.contains(asset)
                || path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(".tmp-"))
            {
                report.quarantined.push(self.quarantine(&path)?);
            }
        }
        let mut seen = std::collections::BTreeSet::new();
        for (record_id, photo) in state.photo_refs() {
            if !seen.insert((record_id, &photo.photo_use_id, &photo.asset_id)) {
                continue;
            }
            let status = self.check_photo(photo)?;
            let issue = MediaIssue {
                record_id: record_id.to_string(),
                photo_use_id: photo.photo_use_id.clone(),
                asset_id: photo.asset_id.clone(),
            };
            match status {
                PhotoStatus::Missing => report.missing.push(issue),
                PhotoStatus::Corrupt => report.corrupt.push(issue),
                PhotoStatus::Available => {}
            }
        }
        self.state = state;
        Ok(report)
    }
    fn check_photo(&self, photo: &PhotoUse) -> Result<PhotoStatus, CoreError> {
        let Some(path) = self.find_asset_path(&photo.asset_id) else {
            return Ok(PhotoStatus::Missing);
        };
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(PhotoStatus::Missing),
            Err(e) => return Err(e.into()),
        };
        Ok(
            if bytes.len() as u64 != photo.bytes || sha256::hex_digest(&bytes) != photo.sha256 {
                PhotoStatus::Corrupt
            } else {
                PhotoStatus::Available
            },
        )
    }
    pub fn photo_status(&self, asset_id: &str) -> Result<PhotoStatus, CoreError> {
        let photos: Vec<_> = self
            .state
            .photo_refs()
            .into_iter()
            .filter(|(_, p)| p.asset_id == asset_id)
            .map(|(_, p)| p)
            .collect();
        if photos.is_empty() {
            return Ok(if self.find_asset_path(asset_id).is_some() {
                PhotoStatus::Available
            } else {
                PhotoStatus::Missing
            });
        }
        for photo in photos {
            let status = self.check_photo(photo)?;
            if status != PhotoStatus::Available {
                return Ok(status);
            }
        }
        Ok(PhotoStatus::Available)
    }
    pub fn resolve_conflict(
        &mut self,
        record_id: &str,
        choice: ConflictChoice,
    ) -> Result<RecordRow, CoreError> {
        let local = self.state.row(record_id)?;
        ensure_active(local)?;
        if local.formal.is_none() {
            return Err(CoreError::new(
                "RECORD_NOT_FORMAL",
                "这条记录还没有正式版，不存在需要选择的冲突",
            ));
        }
        let (snapshot, base_revision) = self
            .pending_conflicts
            .get(record_id)
            .cloned()
            .or_else(|| local.draft.clone().map(|s| (s, local.base_revision)))
            .ok_or_else(|| CoreError::new("NO_DRAFT", "没有待处理的草稿"))?;
        let row = self
            .transact(|state| {
                let row = state.row_mut(record_id)?;
                let occupied = row.draft.clone().filter(|draft| draft != &snapshot);
                let occupied_base = row.base_revision;
                match choice {
                    ConflictChoice::KeepMine => {
                        // 用户选择替换草稿槽时，另一份草稿也保留为可恢复副本。
                        if let Some(draft) = occupied {
                            state.add_conflict(
                                record_id,
                                occupied_base,
                                draft,
                                "resolve_keep_mine",
                            );
                        }
                        let row = state.row_mut(record_id)?;
                        row.draft = Some(snapshot);
                        row.base_revision = row.content_revision;
                    }
                    ConflictChoice::KeepFormal => {
                        state.add_conflict(
                            record_id,
                            base_revision,
                            snapshot,
                            "resolve_keep_formal",
                        );
                        // 明确清空草稿槽之前也保存不同的磁盘草稿。
                        if let Some(draft) = occupied {
                            state.add_conflict(
                                record_id,
                                occupied_base,
                                draft,
                                "resolve_keep_formal_occupied",
                            );
                        }
                        let row = state.row_mut(record_id)?;
                        row.draft = None;
                        row.base_revision = row.content_revision;
                    }
                }
                Ok(state.row(record_id)?.clone())
            })
            .map(|(row, _)| row)?;
        self.pending_conflicts.remove(record_id);
        Ok(row)
    }
    /// 把本实例待处理的冲突草稿（磁盘草稿槽被占时 commit 失败留下的）持久化为冲突副本；
    /// 不改动草稿槽与正式版。没有待处理冲突时返回 NO_DRAFT。
    pub fn save_conflict_copy(&mut self, record_id: &str) -> Result<ConflictCopy, CoreError> {
        let (snapshot, base_revision) = self
            .pending_conflicts
            .get(record_id)
            .cloned()
            .ok_or_else(|| CoreError::new("NO_DRAFT", "没有待保存的冲突草稿"))?;
        let (copy, _) = self.transact(|state| {
            ensure_active(state.row(record_id)?)?;
            state.add_conflict(record_id, base_revision, snapshot.clone(), "revision_conflict");
            state
                .conflict_copies
                .iter()
                .rev()
                .find(|c| c.record_id == record_id && c.snapshot == snapshot)
                .cloned()
                .ok_or_else(|| CoreError::new("CONFLICT_COPY_MISSING", "冲突副本写入失败"))
        })?;
        self.pending_conflicts.remove(record_id);
        Ok(copy)
    }
    pub fn list_conflict_copies(&self) -> Result<Vec<ConflictCopy>, CoreError> {
        let mut copies = self.state.conflict_copies.clone();
        copies.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.conflict_id.cmp(&a.conflict_id))
        });
        Ok(copies)
    }
    pub fn restore_conflict_copy(&mut self, conflict_id: &str) -> Result<RecordRow, CoreError> {
        self.transact(|state| {
            let index = state
                .conflict_copies
                .iter()
                .position(|c| c.conflict_id == conflict_id)
                .ok_or_else(|| CoreError::new("CONFLICT_NOT_FOUND", "冲突副本不存在"))?;
            let copy = state.conflict_copies[index].clone();
            let row = state.row_mut(&copy.record_id)?;
            if row.draft.is_some() {
                return Err(CoreError::new(
                    "DRAFT_OCCUPIED",
                    "已有草稿，请先处理后再恢复副本",
                ));
            }
            row.draft = Some(copy.snapshot);
            row.base_revision = row.content_revision;
            let row = row.clone();
            state.conflict_copies.remove(index);
            Ok(row)
        })
        .map(|(row, _)| row)
    }

    pub fn open(root: impl Into<PathBuf>) -> Result<Self, CoreError> {
        let root = root.into();
        preflight(&root)?;
        fs::create_dir_all(&root)?;
        let _write_lock = write_lock(&root)?;
        let seed = std::env::var("SHIGUANG_SEED").unwrap_or_else(|_| "20261109".to_string());
        let state_path = root.join(STATE_FILE);
        let state = if state_path.exists() {
            let text = fs::read_to_string(&state_path)?;
            let value = parse_state(&text)?;
            let from = schema::version(&value)?;
            if from < schema::CURRENT_SCHEMA_VERSION {
                let backup_error = |e| {
                    CoreError::with_stage(
                        "MIGRATION_BACKUP_FAILED",
                        "migration_backup",
                        format!("迁移备份失败：{e}"),
                    )
                };
                fault::hit(FaultPoint::MigrationBackup).map_err(|e| backup_error(e.to_string()))?;
                let backup_dir = root.join("backups");
                fs::create_dir_all(&backup_dir).map_err(|e| backup_error(e.to_string()))?;
                let backup = unique_path(
                    &backup_dir,
                    &format!("state.schema-v{from}.{}", timestamp()),
                    ".json",
                );
                let durability = persist::write_atomic(&backup, text.as_bytes())
                    .map_err(|e| backup_error(e.to_string()))?;
                if let Durability::Uncertain { error } = durability {
                    return Err(backup_error(error));
                }
                // backups/ 可能刚创建；同步根目录后才允许替换原状态。
                if let Durability::Uncertain { error } = persist::parent_sync(&root) {
                    return Err(backup_error(error));
                }
                let migration_error = |e| {
                    CoreError::with_stage(
                        "MIGRATION_FAILED",
                        "migration_write",
                        format!("迁移失败：{e}"),
                    )
                };
                let value = schema::migrate(value).map_err(|e| migration_error(e.to_string()))?;
                let state = State::from_json(&value).map_err(|e| migration_error(e.to_string()))?;
                // 使用迁移后的原 JSON 保留 seed 及所有旧字段，严格校验后替换。
                let encoded = value.pretty();
                State::from_json(&parse_state(&encoded)?)
                    .map_err(|e| migration_error(e.to_string()))?;
                fault::hit(FaultPoint::MigrationWrite)
                    .map_err(|e| migration_error(e.to_string()))?;
                persist::write_atomic(&state_path, encoded.as_bytes())
                    .map_err(|e| migration_error(e.to_string()))?;
                state
            } else {
                State::from_json(&value)?
            }
        } else {
            State {
                version: STATE_VERSION,
                seq: 0,
                records: Vec::new(),
                deletion_markers: Vec::new(),
                conflict_copies: Vec::new(),
            }
        };
        fs::create_dir_all(root.join(MEDIA_DIR))?;
        fs::create_dir_all(root.join(PREVIEW_DIR))?;
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().starts_with(".tmp-")
                && entry.file_type()?.is_file()
            {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(Store {
            root,
            seed,
            state,
            instance_lock: None,
            pending_conflicts: std::collections::BTreeMap::new(),
            last_durability: Durability::Uncertain {
                error: "当前实例尚未写入状态".to_string(),
            },
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn seed(&self) -> &str {
        &self.seed
    }

    pub fn state_json(&self) -> Json {
        self.state.to_json(&self.seed)
    }

    /// 最近一次成功状态写入的耐久性；本实例尚未写入时为 Uncertain。
    pub fn last_durability(&self) -> &Durability {
        &self.last_durability
    }

    pub fn row(&self, record_id: &str) -> Result<&RecordRow, CoreError> {
        self.state.row(record_id)
    }

    /// 事务：在候选状态上执行操作，序列化成功后再替换内存状态。
    /// 任一环节失败，`self.state` 保持不变。
    fn transact<T>(
        &mut self,
        op: impl FnOnce(&mut State) -> Result<T, CoreError>,
    ) -> Result<(T, Durability), CoreError> {
        let _write_lock = write_lock(&self.root)?;
        let mut candidate = self.candidate_state()?;
        let value = op(&mut candidate)?;
        let durability = self.apply_candidate(candidate)?;
        Ok((value, durability))
    }

    fn candidate_state(&self) -> Result<State, CoreError> {
        // 调用方在整个重载、比较及原子替换期间持有写锁。
        match fs::read_to_string(self.root.join(STATE_FILE)) {
            Ok(text) => {
                let value = parse_state(&text)?;
                let version = schema::version(&value)?;
                // 即使 schema 已变化，损坏文件也必须首先被严格拒绝。
                let decoded = State::from_json(&schema::migrate(value)?)?;
                if version != schema::CURRENT_SCHEMA_VERSION {
                    return Err(CoreError::new(
                        "SCHEMA_CHANGED_ON_DISK",
                        "磁盘数据结构版本已改变，请重新打开拾光；你的输入未丢失",
                    ));
                }
                Ok(decoded)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(self.state.clone()),
            Err(error) => Err(error.into()),
        }
    }

    fn apply_candidate(&mut self, candidate: State) -> Result<Durability, CoreError> {
        let durability = self.persist_state(&candidate)?;
        self.state = candidate;
        self.last_durability = durability.clone();
        Ok(durability)
    }

    /// 新建草稿；base 指向已有正式记录时，草稿从正式快照派生（正式快照保持不变）。
    pub fn create_draft(
        &mut self,
        base: Option<&str>,
        title: &str,
        body: &str,
        event_date: &str,
        event_time: Option<&str>,
    ) -> Result<RecordRow, CoreError> {
        let now = time::now_rfc3339();
        if let Some(base_id) = base {
            return self
                .transact(|state| {
                    let row = state.row_mut(base_id)?;
                    let formal = row.formal.clone().ok_or_else(|| {
                        CoreError::new(
                            "BASE_NOT_FORMAL",
                            format!("只能基于正式记录创建修改草稿：{base_id}"),
                        )
                    })?;
                    if row.draft.is_none() {
                        row.draft = Some(formal);
                        row.base_revision = row.content_revision;
                    }
                    row.updated_at = now.clone();
                    Ok(row.clone())
                })
                .map(|(row, _)| row);
        }

        self.transact(|state| {
            let record_id = state.allocate_id("rec");
            let snapshot = Snapshot {
                title: title.to_string(),
                body: body.to_string(),
                event_date: event_date.to_string(),
                event_time: normalize_time(event_time),
                photos: Vec::new(),
            };
            let row = RecordRow {
                status: RecordStatus::Active,
                trashed_at: None,
                record_id,
                content_revision: 0,
                created_at: now.clone(),
                updated_at: now.clone(),
                committed_at: None,
                base_revision: 0,
                formal: None,
                draft: Some(snapshot),
            };
            state.records.push(row.clone());
            Ok(row)
        })
        .map(|(row, _)| row)
    }

    /// 保存/更新草稿字段；草稿允许不完整（日期可暂空），但有值时校验格式。
    pub fn save_draft(
        &mut self,
        record_id: &str,
        title: Option<&str>,
        body: Option<&str>,
        event_date: Option<&str>,
        event_time: Option<Option<&str>>,
    ) -> Result<RecordRow, CoreError> {
        let now = time::now_rfc3339();
        self.transact(|state| {
            let row = state.row_mut(record_id)?;
            // 草稿缺失时先从正式快照派生；此处只读取，暂不物化。
            let materialized = if row.draft.is_none() {
                Some(row.formal.clone().ok_or_else(|| {
                    CoreError::new("NO_DRAFT", format!("记录没有草稿可保存：{record_id}"))
                })?)
            } else {
                None
            };
            // 先校验日期/时刻，失败时不留下任何修改。
            if let Some(v) = event_date {
                if !v.trim().is_empty() && !time::is_valid_date(v) {
                    return Err(CoreError::new(
                        "INVALID_EVENT_DATE",
                        format!("事件日期无效：{v}（需为真实的 YYYY-MM-DD）"),
                    ));
                }
            }
            if let Some(Some(raw)) = event_time {
                if !raw.trim().is_empty() && !time::is_valid_time(raw) {
                    return Err(CoreError::new(
                        "INVALID_EVENT_TIME",
                        format!("事件时刻无效：{raw}（需为 HH:MM，可留空）"),
                    ));
                }
            }
            // 校验通过后再物化草稿并赋值。
            if let Some(formal) = materialized {
                row.draft = Some(formal);
                row.base_revision = row.content_revision;
            }
            let draft = row.draft.as_mut().expect("draft just ensured");
            if let Some(v) = title {
                draft.title = v.to_string();
            }
            if let Some(v) = body {
                draft.body = v.to_string();
            }
            if let Some(v) = event_date {
                draft.event_date = v.to_string();
            }
            if let Some(v) = event_time {
                draft.event_time = normalize_time(v);
            }
            row.updated_at = now;
            Ok(row.clone())
        })
        .map(|(row, _)| row)
    }

    /// 附加一张合成图：复制原图到 media/，assetId 由内容 SHA 决定，photoUse 独立 caption。
    pub fn attach_photo(
        &mut self,
        record_id: &str,
        source: &Path,
        caption: &str,
        media_type: Option<&str>,
    ) -> Result<PhotoUse, CoreError> {
        let bytes = fs::read(source).map_err(|e| {
            CoreError::new(
                "ASSET_READ_FAILED",
                format!("读取图片失败（{}）：{e}", source.display()),
            )
        })?;
        let file_name = source
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| CoreError::new("INVALID_ASSET_NAME", "图片文件名无效"))?;
        self.attach_photo_data(record_id, file_name, &bytes, caption, media_type)
    }

    /// 字节通道与路径通道共享校验、asset / photoUse 分配及原子状态写入。
    /// file_name 仅参与类型嗅探，绝不作为文件路径使用；同时拒绝两种平台的路径分隔符。
    pub fn attach_photo_bytes(
        &mut self,
        record_id: &str,
        file_name: &str,
        bytes: &[u8],
        caption: &str,
        media_type: Option<&str>,
    ) -> Result<PhotoUse, CoreError> {
        self.attach_photo_data(record_id, file_name, bytes, caption, media_type)
    }

    fn attach_photo_data(
        &mut self,
        record_id: &str,
        file_name: &str,
        bytes: &[u8],
        caption: &str,
        media_type: Option<&str>,
    ) -> Result<PhotoUse, CoreError> {
        if file_name.is_empty()
            || file_name == "."
            || file_name == ".."
            || file_name.contains(['/', '\\', ':', '\0'])
        {
            return Err(CoreError::new(
                "INVALID_ASSET_NAME",
                "请只提供图片文件名，不含路径",
            ));
        }
        if bytes.is_empty() {
            return Err(CoreError::new("EMPTY_ASSET", "图片文件为空，拒绝附加"));
        }
        if bytes.len() > 25 * 1024 * 1024 {
            return Err(CoreError::new("ASSET_TOO_LARGE", "图片超过 25MB，拒绝附加"));
        }
        let source = Path::new(file_name);
        let sha = sha256::hex_digest(bytes);
        let media_type = media_type
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| sniff_media_type(source, bytes));
        let ext = extension_for(&media_type, source);
        let asset_id = format!("ast-{}", &sha[..16]);
        let dest = self.root.join(MEDIA_DIR).join(format!("{asset_id}.{ext}"));

        // 所有领域校验先在候选状态完成，非法请求不产生原图或推进序号。
        let _write_lock = write_lock(&self.root)?;
        let mut candidate = self.candidate_state()?;
        let row = candidate.row_mut(record_id)?;
        if row.draft.is_none() {
            row.draft = Some(row.formal.clone().ok_or_else(|| {
                CoreError::new("NO_DRAFT", format!("记录没有草稿可附加照片：{record_id}"))
            })?);
            row.base_revision = row.content_revision;
        }
        let use_ref = PhotoUse {
            photo_use_id: candidate.allocate_id("pu"),
            asset_id,
            caption: caption.to_string(),
            sha256: sha.clone(),
            bytes: bytes.len() as u64,
            media_type,
        };
        let row = candidate.row_mut(record_id)?;
        row.draft
            .as_mut()
            .expect("draft just ensured")
            .photos
            .push(use_ref.clone());
        row.updated_at = time::now_rfc3339();

        let asset_durability = if dest.exists() {
            let existing = fs::read(&dest)?;
            if sha256::hex_digest(&existing) != sha {
                return Err(CoreError::new("ASSET_CONFLICT", "assetId 冲突且内容不一致"));
            }
            None
        } else {
            Some(persist::write_atomic(&dest, bytes)?)
        };
        fault::hit(FaultPoint::AfterMediaWrite).map_err(|e| {
            CoreError::with_stage(
                "MEDIA_STATE_WRITE_FAILED",
                "after_media_write",
                format!("原图已保存，照片引用尚未写入：{e}"),
            )
        })?;
        self.apply_candidate(candidate)?;
        // 原图写入也需要目录同步；不能用状态文件的确认掩盖原图的不确定性。
        if let Some(d @ Durability::Uncertain { .. }) = asset_durability {
            self.last_durability = d;
        }
        Ok(use_ref)
    }

    /// 只移除草稿中的使用关系，原图及正式快照保持不变。
    pub fn remove_draft_photo(
        &mut self,
        record_id: &str,
        photo_use_id: &str,
    ) -> Result<RecordRow, CoreError> {
        self.transact(|state| {
            let row = state.row_mut(record_id)?;
            let draft = row
                .draft
                .as_mut()
                .ok_or_else(|| CoreError::new("PHOTO_USE_NOT_FOUND", "草稿中没有这张照片"))?;
            let index = draft
                .photos
                .iter()
                .position(|p| p.photo_use_id == photo_use_id)
                .ok_or_else(|| CoreError::new("PHOTO_USE_NOT_FOUND", "草稿中没有这张照片"))?;
            draft.photos.remove(index);
            row.updated_at = time::now_rfc3339();
            Ok(row.clone())
        })
        .map(|(row, _)| row)
    }

    /// 仅丢弃草稿槽，从未提交的记录整行移除；不清理 media。
    pub fn discard_draft(&mut self, record_id: &str) -> Result<Option<RecordRow>, CoreError> {
        self.transact(|state| {
            let row = state.row_mut(record_id)?;
            if row.formal.is_none() {
                state.records.retain(|r| r.record_id != record_id);
                Ok(None)
            } else {
                row.draft = None;
                row.base_revision = row.content_revision;
                row.updated_at = time::now_rfc3339();
                Ok(Some(row.clone()))
            }
        })
        .map(|(row, _)| row)
    }

    /// 全部未提交草稿，最近更新优先；同一时刻按 recordId 倒序。
    pub fn list_drafts(&self) -> Vec<&RecordRow> {
        let mut rows: Vec<_> = self
            .state
            .records
            .iter()
            .filter(|r| r.status == RecordStatus::Active && r.draft.is_some())
            .collect();
        rows.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| b.record_id.cmp(&a.record_id))
        });
        rows
    }

    /// 「存入时光」：校验通过后把草稿快照转为正式，revision 递增，草稿清空。
    /// 调用方预期版本和本地草稿基线均须匹配磁盘正式版本；冲突时保留本地草稿。
    pub fn commit(
        &mut self,
        record_id: &str,
        expected_base_revision: u32,
    ) -> Result<CommitOutcome, CoreError> {
        let _write_lock = write_lock(&self.root)?;
        let mut candidate = self.candidate_state()?;
        candidate.row_mut(record_id)?;
        // 校验先于任何修改：内容合法，且所有原图仍在磁盘上。
        // 提交调用方的本地草稿及原始基线，不能用磁盘草稿替换它。
        let local_row = self.state.row(record_id)?;
        ensure_active(local_row)?;
        let (draft, base_revision) = self
            .pending_conflicts
            .get(record_id)
            .cloned()
            .or_else(|| {
                local_row
                    .draft
                    .clone()
                    .map(|draft| (draft, local_row.base_revision))
            })
            .ok_or_else(|| CoreError::new("NO_DRAFT", format!("没有待提交的草稿：{record_id}")))?;
        draft.validate_for_commit()?;
        for photo in &draft.photos {
            let asset_path = self.find_asset_path(&photo.asset_id).ok_or_else(|| {
                CoreError::new(
                    "ASSET_MISSING",
                    format!(
                        "原图缺失，拒绝提交（{} / {}）；不会用缺失的媒体生成正式记录",
                        photo.photo_use_id, photo.asset_id
                    ),
                )
            })?;
            let bytes = fs::read(&asset_path).map_err(|e| {
                CoreError::new(
                    "ASSET_READ_FAILED",
                    format!(
                        "读取原图失败（{} / {}，{}）：{e}；正式记录未改变，草稿已保留",
                        photo.photo_use_id,
                        photo.asset_id,
                        asset_path.display()
                    ),
                )
            })?;
            if bytes.len() as u64 != photo.bytes {
                return Err(CoreError::new(
                    "ASSET_SIZE_MISMATCH",
                    format!(
                        "原图字节数与记录不一致（{} / {}）：记录 {} 字节，实际 {} 字节；正式记录未改变，草稿已保留",
                        photo.photo_use_id,
                        photo.asset_id,
                        photo.bytes,
                        bytes.len()
                    ),
                ));
            }
            if sha256::hex_digest(&bytes) != photo.sha256 {
                return Err(CoreError::new(
                    "ASSET_HASH_MISMATCH",
                    format!(
                        "原图 SHA-256 与记录不一致（{} / {}）；正式记录未改变，草稿已保留",
                        photo.photo_use_id, photo.asset_id
                    ),
                ));
            }
        }
        let row = candidate.row_mut(record_id)?;
        if row.content_revision != expected_base_revision || base_revision != row.content_revision {
            let conflict = CoreError::with_stage(
                "REVISION_CONFLICT",
                "commit",
                format!(
                    "版本冲突：期望正式版本 {expected_base_revision}，实际正式版本 {}，本地草稿基于版本 {base_revision}；正式版未覆盖，本地草稿已保留",
                    row.content_revision
                ),
            );
            if row.draft.is_none() {
                row.draft = Some(draft);
                // 保留原基线，之后必须由用户明确选择重定基线。
                row.base_revision = base_revision;
                self.apply_candidate(candidate)?;
            } else if row.draft.as_ref() != Some(&draft) || row.base_revision != base_revision {
                // 磁盘草稿槽已被另一份草稿占用：commit 本身不写盘（保持 Unit-0.1 语义：
                // 冲突时 state.json 与本实例状态都不变）。本地草稿记入 pending_conflicts，
                // 由用户/调用方显式 save_conflict_copy 或 resolve_conflict 持久化为冲突副本。
                self.pending_conflicts
                    .insert(record_id.to_string(), (draft, base_revision));
            }
            // updatedAt / committedAt / SHIGUANG_CLOCK 均不参与胜负判断。
            return Err(conflict);
        }
        let now = time::now_rfc3339();
        row.content_revision = row.content_revision.saturating_add(1);
        row.formal = Some(draft);
        row.committed_at = Some(now.clone());
        row.updated_at = now.clone();
        row.draft = None;
        row.base_revision = row.content_revision;
        let record_id = row.record_id.clone();
        let content_revision = row.content_revision;
        let committed_at = now;
        let durability = self.apply_candidate(candidate)?;
        self.pending_conflicts.remove(&record_id);
        Ok(CommitOutcome {
            record_id,
            content_revision,
            committed_at,
            durability,
        })
    }

    /// 正式列表只包含正式快照；带未提交修改草稿的记录仍显示旧正式内容。
    pub fn list_formal(&self) -> Vec<&RecordRow> {
        let mut rows: Vec<&RecordRow> = self
            .state
            .records
            .iter()
            .filter(|r| r.status == RecordStatus::Active && r.formal.is_some())
            .collect();
        rows.sort_by(|a, b| {
            let left = a.formal.as_ref().expect("filtered formal");
            let right = b.formal.as_ref().expect("filtered formal");
            right
                .event_date
                .cmp(&left.event_date)
                .then_with(|| b.committed_at.cmp(&a.committed_at))
                .then_with(|| b.record_id.cmp(&a.record_id))
        });
        rows
    }

    pub fn formal(&self, record_id: &str) -> Option<&Snapshot> {
        self.state
            .records
            .iter()
            .find(|r| r.record_id == record_id)
            .and_then(|r| r.formal.as_ref())
    }

    pub fn asset_path(&self, asset_id: &str) -> Option<PathBuf> {
        self.find_asset_path(asset_id)
    }

    fn find_asset_path(&self, asset_id: &str) -> Option<PathBuf> {
        let dir = self.root.join(MEDIA_DIR);
        let entries = fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') || !path.is_file() {
                continue;
            }
            // 精确匹配 `{asset_id}.{ext}`：去掉最后一个扩展名后必须恰好等于 assetId。
            if path.file_stem().and_then(|stem| stem.to_str()) == Some(asset_id) {
                return Some(path);
            }
        }
        None
    }

    pub fn preview_path(&self, asset_id: &str) -> PathBuf {
        self.root
            .join(PREVIEW_DIR)
            .join(format!("{asset_id}.preview.png"))
    }

    /// 生成缺失的预览；已有预览不重复写。返回本次生成的 assetId。
    pub fn ensure_previews(&self) -> Result<Vec<String>, CoreError> {
        let mut created = Vec::new();
        for photo in self.all_photos() {
            let preview_path = self.preview_path(&photo.asset_id);
            if preview_path.exists() {
                continue;
            }
            let asset_path = self.find_asset_path(&photo.asset_id).ok_or_else(|| {
                CoreError::new(
                    "ASSET_MISSING",
                    format!("原图缺失，无法重建预览：{}", photo.asset_id),
                )
            })?;
            let bytes = fs::read(&asset_path)?;
            let sha = sha256::hex_digest(&bytes);
            if sha != photo.sha256 {
                return Err(CoreError::new(
                    "ASSET_HASH_MISMATCH",
                    format!("原图 SHA 与记录不一致：{}", photo.asset_id),
                ));
            }
            let png = preview::preview_bytes(&sha);
            persist::write_atomic(&preview_path, &png)?;
            created.push(photo.asset_id.clone());
        }
        Ok(created)
    }

    /// 删除派生预览缓存；绝不触碰 media/ 原图。
    pub fn clear_previews(&self) -> Result<Vec<String>, CoreError> {
        let mut removed = Vec::new();
        let dir = self.root.join(PREVIEW_DIR);
        if dir.exists() {
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                let path = entry.path();
                if path.is_file() {
                    removed.push(entry.file_name().to_string_lossy().to_string());
                    fs::remove_file(&path)?;
                }
            }
        }
        Ok(removed)
    }

    pub fn all_photos(&self) -> Vec<PhotoUse> {
        let mut seen = std::collections::BTreeSet::new();
        self.state
            .photo_refs()
            .into_iter()
            .filter(|(_, photo)| seen.insert(photo.photo_use_id.clone()))
            .map(|(_, photo)| photo.clone())
            .collect()
    }

    /// 磁盘上的原图清单（用于 AC-U0-07 前后对比，不依赖任何记录引用）。
    pub fn assets_on_disk(&self) -> Result<Vec<AssetInfo>, CoreError> {
        let mut assets = Vec::new();
        let dir = self.root.join(MEDIA_DIR);
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let bytes = fs::read(&path)?;
            assets.push(AssetInfo {
                file: format!("{}/{}", MEDIA_DIR, entry.file_name().to_string_lossy()),
                asset_id: entry
                    .file_name()
                    .to_string_lossy()
                    .split('.')
                    .next()
                    .unwrap_or_default()
                    .to_string(),
                sha256: sha256::hex_digest(&bytes),
                bytes: bytes.len() as u64,
            });
        }
        assets.sort_by(|a, b| a.file.cmp(&b.file));
        Ok(assets)
    }

    pub fn manifest_json(&self, versions: &[(String, String)]) -> Result<Json, CoreError> {
        let records = self
            .list_formal()
            .into_iter()
            .map(|row| {
                let formal = row.formal.as_ref().expect("formal row");
                Json::obj(vec![
                    ("recordId", Json::str(row.record_id.clone())),
                    ("contentRevision", Json::Num(row.content_revision as i64)),
                    ("committedAt", opt_str(&row.committed_at)),
                    ("eventDate", Json::str(formal.event_date.clone())),
                    ("eventTime", opt_str(&formal.event_time)),
                    (
                        "bodySha256",
                        Json::str(sha256::hex_digest(formal.body.as_bytes())),
                    ),
                    (
                        "titleSha256",
                        Json::str(sha256::hex_digest(formal.title.as_bytes())),
                    ),
                    (
                        "photos",
                        Json::Arr(
                            formal
                                .photos
                                .iter()
                                .map(|p| {
                                    Json::obj(vec![
                                        ("photoUseId", Json::str(p.photo_use_id.clone())),
                                        ("assetId", Json::str(p.asset_id.clone())),
                                        ("caption", Json::str(p.caption.clone())),
                                        ("sha256", Json::str(p.sha256.clone())),
                                        ("bytes", Json::Num(p.bytes as i64)),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                ])
            })
            .collect();

        let assets = self
            .assets_on_disk()?
            .into_iter()
            .map(|a| {
                Json::obj(vec![
                    ("assetId", Json::str(a.asset_id)),
                    ("file", Json::str(a.file)),
                    ("sha256", Json::str(a.sha256)),
                    ("bytes", Json::Num(a.bytes as i64)),
                ])
            })
            .collect();

        let mut platform = vec![
            ("os", Json::str(std::env::consts::OS)),
            ("arch", Json::str(std::env::consts::ARCH)),
            ("unit", Json::str("UNIT0")),
            ("seed", Json::str(self.seed.clone())),
            ("generatedAt", Json::str(time::now_rfc3339())),
        ];
        for (k, v) in versions {
            platform.push((k.as_str(), Json::str(v.clone())));
        }

        Ok(Json::obj(vec![
            ("platform", Json::obj(platform)),
            ("records", Json::Arr(records)),
            ("assets", Json::Arr(assets)),
        ]))
    }

    pub fn persist(&mut self) -> Result<Durability, CoreError> {
        self.transact(|_| Ok(())).map(|(_, durability)| durability)
    }

    fn persist_state(&self, state: &State) -> Result<Durability, CoreError> {
        let path = self.root.join(STATE_FILE);
        let value = state.to_json(&self.seed);
        let text = value.pretty();
        let serialize_error =
            |message| CoreError::with_stage("STATE_SERIALIZE_FAILED", "serialize", message);
        let parsed = json::parse(&text).map_err(serialize_error)?;
        let round_trip = State::from_json(&parsed).map_err(|e| serialize_error(e.to_string()))?;
        if round_trip.to_json(&self.seed).dump() != value.dump() {
            return Err(serialize_error("状态序列化往返不一致".to_string()));
        }
        persist::write_atomic(&path, text.as_bytes())
    }
}

#[derive(Clone, Debug)]
pub struct AssetInfo {
    pub asset_id: String,
    pub file: String,
    pub sha256: String,
    pub bytes: u64,
}

impl State {
    fn missing_row(&self, record_id: &str) -> CoreError {
        if self
            .deletion_markers
            .iter()
            .any(|m| m.record_id == record_id)
        {
            CoreError::new("RECORD_DELETED", "这条记录已永久删除")
        } else {
            CoreError::new("NOT_FOUND", format!("记录不存在：{record_id}"))
        }
    }
    fn row(&self, record_id: &str) -> Result<&RecordRow, CoreError> {
        self.records
            .iter()
            .find(|r| r.record_id == record_id)
            .ok_or_else(|| self.missing_row(record_id))
    }
    fn any_row_mut(&mut self, record_id: &str) -> Result<&mut RecordRow, CoreError> {
        let index = self
            .records
            .iter()
            .position(|r| r.record_id == record_id)
            .ok_or_else(|| self.missing_row(record_id))?;
        Ok(&mut self.records[index])
    }
    fn row_mut(&mut self, record_id: &str) -> Result<&mut RecordRow, CoreError> {
        let row = self.any_row_mut(record_id)?;
        ensure_active(row)?;
        Ok(row)
    }
    fn photo_refs(&self) -> Vec<(&str, &PhotoUse)> {
        self.records
            .iter()
            .flat_map(|r| {
                [r.formal.as_ref(), r.draft.as_ref()]
                    .into_iter()
                    .flatten()
                    .flat_map(move |s| s.photos.iter().map(move |p| (r.record_id.as_str(), p)))
            })
            .chain(self.conflict_copies.iter().flat_map(|c| {
                c.snapshot
                    .photos
                    .iter()
                    .map(move |p| (c.record_id.as_str(), p))
            }))
            .collect()
    }
    fn referenced_assets(&self) -> std::collections::BTreeSet<String> {
        self.photo_refs()
            .iter()
            .map(|(_, p)| p.asset_id.clone())
            .collect()
    }

    fn add_conflict(
        &mut self,
        record_id: &str,
        base_revision: u32,
        snapshot: Snapshot,
        reason: &str,
    ) -> bool {
        if self.conflict_copies.iter().any(|c| {
            c.record_id == record_id && c.base_revision == base_revision && c.snapshot == snapshot
        }) {
            return false;
        }
        let conflict_id = self.allocate_id("conflict");
        self.conflict_copies.push(ConflictCopy {
            conflict_id,
            record_id: record_id.to_string(),
            base_revision,
            snapshot,
            created_at: time::now_rfc3339(),
            reason: reason.to_string(),
        });
        true
    }

    fn allocate_id(&mut self, prefix: &str) -> String {
        self.seq += 1;
        format!("{}-{:06}", prefix, self.seq)
    }

    fn to_json(&self, seed: &str) -> Json {
        Json::obj(vec![
            ("version", Json::Num(self.version)),
            ("schemaVersion", Json::Num(schema::CURRENT_SCHEMA_VERSION)),
            (
                "deletionMarkers",
                Json::Arr(
                    self.deletion_markers
                        .iter()
                        .map(DeletionMarker::to_json)
                        .collect(),
                ),
            ),
            (
                "conflictCopies",
                Json::Arr(
                    self.conflict_copies
                        .iter()
                        .map(ConflictCopy::to_json)
                        .collect(),
                ),
            ),
            ("seed", Json::str(seed)),
            ("seq", Json::Num(self.seq as i64)),
            (
                "records",
                Json::Arr(self.records.iter().map(RecordRow::to_json).collect()),
            ),
        ])
    }

    fn from_json(value: &Json) -> Result<Self, CoreError> {
        let version = value
            .get("version")
            .and_then(Json::as_i64)
            .ok_or_else(|| CoreError::new("STATE_CORRUPT", "状态文件缺少 version 或不是整数"))?;
        if version != STATE_VERSION {
            return Err(CoreError::new(
                "STATE_VERSION_UNSUPPORTED",
                format!("不支持的状态版本：{version}"),
            ));
        }
        let seq = match value.get("seq").and_then(Json::as_i64) {
            Some(n) if n >= 0 => n as u64,
            Some(n) => {
                return Err(CoreError::new(
                    "STATE_CORRUPT",
                    format!("状态文件 seq 必须为非负整数：{n}"),
                ))
            }
            None => {
                return Err(CoreError::new(
                    "STATE_CORRUPT",
                    "状态文件缺少 seq 或不是整数",
                ))
            }
        };
        if value.get("seed").and_then(Json::as_str).is_none() {
            return Err(CoreError::new(
                "STATE_CORRUPT",
                "状态文件缺少 seed 或不是字符串",
            ));
        }
        let records = match value.get("records") {
            Some(Json::Arr(items)) => items
                .iter()
                .map(RecordRow::from_json)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| CoreError::new("STATE_CORRUPT", e))?,
            Some(_) => {
                return Err(CoreError::new(
                    "STATE_CORRUPT",
                    "状态文件 records 必须是数组",
                ))
            }
            None => return Err(CoreError::new("STATE_CORRUPT", "状态文件缺少 records")),
        };
        schema::version(value)?;
        let array = |key| {
            value.get(key).and_then(Json::as_arr).ok_or_else(|| {
                CoreError::new("STATE_CORRUPT", format!("字段 {key} 缺失或不是数组"))
            })
        };
        let deletion_markers = array("deletionMarkers")?
            .iter()
            .map(DeletionMarker::from_json)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| CoreError::new("STATE_CORRUPT", e))?;
        let conflict_copies = array("conflictCopies")?
            .iter()
            .map(ConflictCopy::from_json)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| CoreError::new("STATE_CORRUPT", e))?;
        for row in &records {
            if (row.status == RecordStatus::Trashed) != row.trashed_at.is_some()
                || (row.status == RecordStatus::Trashed && row.formal.is_none())
            {
                return Err(CoreError::new(
                    "STATE_CORRUPT",
                    "回收站状态与 trashedAt / formal 不一致",
                ));
            }
        }
        Ok(State {
            version,
            seq,
            records,
            deletion_markers,
            conflict_copies,
        })
    }
}

fn ensure_active(row: &RecordRow) -> Result<(), CoreError> {
    if row.status == RecordStatus::Trashed {
        return Err(CoreError::new(
            "RECORD_TRASHED",
            "记录已在回收站，请先恢复后再修改",
        ));
    }
    Ok(())
}

fn media_files(root: &Path) -> Result<Vec<PathBuf>, CoreError> {
    let mut paths = Vec::new();
    for entry in fs::read_dir(root.join(MEDIA_DIR))? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            paths.push(entry.path());
        }
    }
    paths.sort();
    Ok(paths)
}

fn parse_state(text: &str) -> Result<Json, CoreError> {
    json::parse(text).map_err(|e| CoreError::new("STATE_CORRUPT", format!("状态文件无法解析：{e}")))
}

fn preflight(root: &Path) -> Result<(), CoreError> {
    match fs::read_to_string(root.join(STATE_FILE)) {
        Ok(text) => {
            schema::version(&parse_state(&text)?)?;
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn timestamp() -> String {
    time::now_rfc3339()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

fn unique_path(dir: &Path, stem: &str, suffix: &str) -> PathBuf {
    let mut counter = 0u64;
    loop {
        let name = if counter == 0 {
            format!("{stem}{suffix}")
        } else {
            format!("{stem}.{counter}{suffix}")
        };
        let path = dir.join(name);
        if !path.exists() {
            return path;
        }
        counter += 1;
    }
}

fn lock_file(root: &Path, name: &str) -> Result<File, CoreError> {
    Ok(OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join(name))?)
}

fn write_lock(root: &Path) -> Result<File, CoreError> {
    let lock = lock_file(root, ".write.lock")?;
    let start = Instant::now();
    loop {
        match lock.try_lock() {
            Ok(()) => return Ok(lock),
            Err(std::fs::TryLockError::WouldBlock) => {
                if start.elapsed() >= Duration::from_secs(3) {
                    return Err(CoreError::new(
                        "STORE_BUSY",
                        "另一个拾光窗口正在写入，请稍后重试；你的输入未丢失",
                    ));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(e.into()),
        }
    }
}

fn opt_str(value: &Option<String>) -> Json {
    match value {
        Some(v) => Json::str(v.clone()),
        None => Json::Null,
    }
}

fn normalize_time(value: Option<&str>) -> Option<String> {
    match value {
        Some(v) if !v.trim().is_empty() => Some(v.trim().to_string()),
        _ => None,
    }
}

fn sniff_media_type(source: &Path, bytes: &[u8]) -> String {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return "image/png".to_string();
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return "image/jpeg".to_string();
    }
    if bytes.starts_with(b"GIF8") {
        return "image/gif".to_string();
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp".to_string();
    }
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn extension_for(media_type: &str, source: &Path) -> String {
    match media_type {
        "image/png" => "png".to_string(),
        "image/jpeg" => "jpg".to_string(),
        "image/gif" => "gif".to_string(),
        "image/webp" => "webp".to_string(),
        _ => source
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| "bin".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "shiguang-store-test-{}-{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&root);
        root
    }

    #[test]
    fn draft_round_trip_and_atomic_state() {
        let root = temp_root("roundtrip");
        let mut store = Store::open(&root).unwrap();
        let row = store
            .create_draft(None, "标题", "正文", "2026-11-09", None)
            .unwrap();
        let id = row.record_id.clone();
        drop(store);

        let reopened = Store::open(&root).unwrap();
        let row = reopened.row(&id).unwrap();
        assert_eq!(row.draft.as_ref().unwrap().body, "正文");
        assert!(row.formal.is_none());
        assert_eq!(row.content_revision, 0);
        // 无临时文件残留
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn normal_writes_report_durable_on_linux() {
        let root = temp_root("durable");
        let mut store = Store::open(&root).unwrap();
        let row = store
            .create_draft(None, "标题", "正文", "2026-11-09", None)
            .unwrap();
        assert_eq!(store.last_durability(), &Durability::Durable);
        let outcome = store.commit(&row.record_id, 0).unwrap();
        assert_eq!(outcome.durability, Durability::Durable);
        assert_eq!(outcome.durability.as_str(), "durable");
        assert_eq!(store.persist().unwrap(), Durability::Durable);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn open_cleans_only_root_temp_files() {
        let root = temp_root("cleanup");
        fs::create_dir_all(root.join(MEDIA_DIR)).unwrap();
        for name in [
            ".tmp-shiguang-1-2",
            ".tmp-legacy",
            ".keep",
            "tmp-other",
            "media/.tmp-keep",
        ] {
            fs::write(root.join(name), b"synthetic").unwrap();
        }
        fs::create_dir(root.join(".tmp-directory")).unwrap();
        Store::open(&root).unwrap();
        assert!(!root.join(".tmp-shiguang-1-2").exists());
        assert!(!root.join(".tmp-legacy").exists());
        for name in [".keep", "tmp-other", "media/.tmp-keep", ".tmp-directory"] {
            assert!(root.join(name).exists(), "不得删除 {name}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn serialization_mismatch_keeps_memory_and_disk() {
        let root = temp_root("serialize");
        let mut store = Store::open(&root).unwrap();
        store
            .create_draft(None, "标题", "正文", "2026-11-09", None)
            .unwrap();
        let before = store.state_json().dump();
        let bytes = fs::read(root.join(STATE_FILE)).unwrap();
        let error = store
            .transact(|state| {
                state.seq = u64::MAX;
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error.code, "STATE_SERIALIZE_FAILED");
        assert_eq!(error.stage, Some("serialize"));
        assert_eq!(store.state_json().dump(), before);
        assert_eq!(fs::read(root.join(STATE_FILE)).unwrap(), bytes);
        fs::remove_dir_all(root).unwrap();
    }
}
