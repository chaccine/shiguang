//! 本地持久化：状态文件原子写入 + media 原图目录 + 派生预览缓存。

use crate::json::{self, Json};
use crate::model::{CoreError, PhotoUse, RecordRow, Snapshot, RecordStatus, ConflictChoice, ConflictCopy, MediaReport, PhotoStatus, PurgeOutcome};
use crate::persist::{self, Durability};
use crate::preview;
use crate::sha256;
use crate::time;
use std::fs;
use std::path::{Path, PathBuf};

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
}

#[derive(Clone)]
struct State {
    version: i64,
    seq: u64,
    records: Vec<RecordRow>,
}

#[derive(Clone, Debug)]
pub struct CommitOutcome {
    pub record_id: String,
    pub content_revision: u32,
    pub committed_at: String,
    pub durability: Durability,
}

impl Store {
    // Phase 1 API stubs. Existing write paths retain their baseline behavior.
    pub fn open_exclusive(_root: impl Into<PathBuf>) -> Result<Self, CoreError> {
        Err(CoreError::new("NOT_IMPLEMENTED", "open_exclusive"))
    }
    pub fn trash_record(&mut self, _record_id: &str) -> Result<RecordRow, CoreError> {
        Err(CoreError::new("NOT_IMPLEMENTED", "trash_record"))
    }
    pub fn restore_record(&mut self, _record_id: &str) -> Result<RecordRow, CoreError> {
        Err(CoreError::new("NOT_IMPLEMENTED", "restore_record"))
    }
    pub fn list_trash(&self) -> Result<Vec<&RecordRow>, CoreError> {
        Err(CoreError::new("NOT_IMPLEMENTED", "list_trash"))
    }
    pub fn purge_record(&mut self, _record_id: &str) -> Result<PurgeOutcome, CoreError> {
        Err(CoreError::new("NOT_IMPLEMENTED", "purge_record"))
    }
    pub fn empty_trash(&mut self) -> Result<PurgeOutcome, CoreError> {
        Err(CoreError::new("NOT_IMPLEMENTED", "empty_trash"))
    }
    pub fn reconcile_media(&mut self) -> Result<MediaReport, CoreError> {
        Err(CoreError::new("NOT_IMPLEMENTED", "reconcile_media"))
    }
    pub fn photo_status(&self, _asset_id: &str) -> Result<PhotoStatus, CoreError> {
        Err(CoreError::new("NOT_IMPLEMENTED", "photo_status"))
    }
    pub fn resolve_conflict(&mut self, _record_id: &str, _choice: ConflictChoice) -> Result<RecordRow, CoreError> {
        Err(CoreError::new("NOT_IMPLEMENTED", "resolve_conflict"))
    }
    pub fn list_conflict_copies(&self) -> Result<Vec<ConflictCopy>, CoreError> {
        Err(CoreError::new("NOT_IMPLEMENTED", "list_conflict_copies"))
    }
    pub fn restore_conflict_copy(&mut self, _conflict_id: &str) -> Result<RecordRow, CoreError> {
        Err(CoreError::new("NOT_IMPLEMENTED", "restore_conflict_copy"))
    }

    pub fn open(root: impl Into<PathBuf>) -> Result<Self, CoreError> {
        let root = root.into();
        fs::create_dir_all(root.join(MEDIA_DIR))?;
        fs::create_dir_all(root.join(PREVIEW_DIR))?;
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(".tmp-") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        let seed = std::env::var("SHIGUANG_SEED").unwrap_or_else(|_| "20261109".to_string());
        let state_path = root.join(STATE_FILE);
        let state = if state_path.exists() {
            let text = fs::read_to_string(&state_path)?;
            State::from_json(&json::parse(&text).map_err(|e| {
                CoreError::new("STATE_CORRUPT", format!("状态文件无法解析：{e}"))
            })?)?
        } else {
            State {
                version: STATE_VERSION,
                seq: 0,
                records: Vec::new(),
            }
        };
        Ok(Store {
            root,
            seed,
            state,
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
        let mut candidate = self.candidate_state()?;
        let value = op(&mut candidate)?;
        let durability = self.apply_candidate(candidate)?;
        Ok((value, durability))
    }

    fn candidate_state(&self) -> Result<State, CoreError> {
        // 写前重载缩小跨进程丢失更新的窗口；单写者文件锁留到 g（后续阶段），
        // 当前读取、比较、替换之间仍可能发生竞争。
        match fs::read_to_string(self.root.join(STATE_FILE)) {
            Ok(text) => State::from_json(&json::parse(&text).map_err(|e| {
                CoreError::new("STATE_CORRUPT", format!("状态文件无法解析：{e}"))
            })?),
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
            return self.transact(|state| {
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
            .filter(|r| r.draft.is_some())
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
        // 校验先于任何修改：内容合法，且所有原图仍在磁盘上。
        // 提交调用方的本地草稿及原始基线，不能用磁盘草稿替换它。
        let local_row = self.state.row(record_id)?;
        let base_revision = local_row.base_revision;
        let draft = local_row
            .draft
            .clone()
            .ok_or_else(|| {
                CoreError::new("NO_DRAFT", format!("没有待提交的草稿：{record_id}"))
            })?;
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
        let mut candidate = self.candidate_state()?;
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
                // 必须保留旧基线，不能让陈旧草稿被下一次提交自动升级为正式版。
                row.base_revision = base_revision;
                self.apply_candidate(candidate)?;
            }
            // 磁盘已有（不同）草稿时不写入，也不替换本地内存中的草稿。
            // 已知限制：第二份草稿只在当前实例内存中；冲突副本存储/UI 留到后续阶段。
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
            .filter(|r| r.formal.is_some())
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
        let mut photos = Vec::new();
        for row in &self.state.records {
            for snapshot in [row.formal.as_ref(), row.draft.as_ref()].into_iter().flatten() {
                for photo in &snapshot.photos {
                    if seen.insert(photo.photo_use_id.clone()) {
                        photos.push(photo.clone());
                    }
                }
            }
        }
        photos
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
                file: format!(
                    "{}/{}",
                    MEDIA_DIR,
                    entry.file_name().to_string_lossy()
                ),
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
                    ("titleSha256", Json::str(sha256::hex_digest(formal.title.as_bytes()))),
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
        let durability = self.persist_state(&self.state)?;
        self.last_durability = durability.clone();
        Ok(durability)
    }

    fn persist_state(&self, state: &State) -> Result<Durability, CoreError> {
        let path = self.root.join(STATE_FILE);
        let value = state.to_json(&self.seed);
        let text = value.pretty();
        let serialize_error = |message| {
            CoreError::with_stage("STATE_SERIALIZE_FAILED", "serialize", message)
        };
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
    fn row(&self, record_id: &str) -> Result<&RecordRow, CoreError> {
        self.records
            .iter()
            .find(|r| r.record_id == record_id)
            .ok_or_else(|| CoreError::new("NOT_FOUND", format!("记录不存在：{record_id}")))
    }

    fn row_mut(&mut self, record_id: &str) -> Result<&mut RecordRow, CoreError> {
        self.records
            .iter_mut()
            .find(|r| r.record_id == record_id)
            .ok_or_else(|| CoreError::new("NOT_FOUND", format!("记录不存在：{record_id}")))
    }

    fn allocate_id(&mut self, prefix: &str) -> String {
        self.seq += 1;
        format!("{}-{:06}", prefix, self.seq)
    }

    fn to_json(&self, seed: &str) -> Json {
        Json::obj(vec![
            ("version", Json::Num(self.version)),
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
            None => {
                return Err(CoreError::new(
                    "STATE_CORRUPT",
                    "状态文件缺少 records",
                ))
            }
        };
        Ok(State {
            version,
            seq,
            records,
        })
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
            ".tmp-shiguang-1-2", ".tmp-legacy", ".keep", "tmp-other", "media/.tmp-keep",
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
