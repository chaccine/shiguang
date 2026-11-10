//! Pure, deterministic merge. Wall-clock timestamps never choose a winner.
use crate::{
    json::Json, ConflictCopy, CoreError, MediaReport, RecordRow, RecordStatus, Snapshot, State,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordIdentity {
    pub record_id: String,
    pub created_at: String,
}
impl RecordIdentity {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("recordId", Json::str(&self.record_id)),
            ("createdAt", Json::str(&self.created_at)),
        ])
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MergePlan {
    pub added: u64,
    pub updated: u64,
    pub unchanged: u64,
    pub conflicts: u64,
    pub kept_trashed: u64,
    pub kept_active: u64,
    pub skipped_deleted: Vec<RecordIdentity>,
    pub deleted_in_backup: Vec<RecordIdentity>,
    pub markers_added: u64,
    pub conflict_copies_added: u64,
    pub conflict_copies_dropped: u64,
    pub media_added: u64,
    pub media_missing: u64,
    pub media_conflicts: Vec<String>,
}
impl MergePlan {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("added", Json::Num(self.added as i64)),
            ("updated", Json::Num(self.updated as i64)),
            ("unchanged", Json::Num(self.unchanged as i64)),
            ("conflicts", Json::Num(self.conflicts as i64)),
            ("keptTrashed", Json::Num(self.kept_trashed as i64)),
            ("keptActive", Json::Num(self.kept_active as i64)),
            (
                "skippedDeleted",
                Json::Arr(
                    self.skipped_deleted
                        .iter()
                        .map(RecordIdentity::to_json)
                        .collect(),
                ),
            ),
            (
                "deletedInBackup",
                Json::Arr(
                    self.deleted_in_backup
                        .iter()
                        .map(RecordIdentity::to_json)
                        .collect(),
                ),
            ),
            ("markersAdded", Json::Num(self.markers_added as i64)),
            (
                "conflictCopiesAdded",
                Json::Num(self.conflict_copies_added as i64),
            ),
            (
                "conflictCopiesDropped",
                Json::Num(self.conflict_copies_dropped as i64),
            ),
            ("mediaAdded", Json::Num(self.media_added as i64)),
            ("mediaMissing", Json::Num(self.media_missing as i64)),
            (
                "mediaConflicts",
                Json::Arr(self.media_conflicts.iter().map(Json::str).collect()),
            ),
        ])
    }
}
#[derive(Clone, Debug)]
pub struct MergeReport {
    pub plan: MergePlan,
    pub safety_backup_dir: Option<PathBuf>,
    pub media_report: MediaReport,
}
impl MergeReport {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("plan", self.plan.to_json()),
            (
                "safetyBackupDir",
                self.safety_backup_dir
                    .as_ref()
                    .map(|p| Json::str(p.to_string_lossy()))
                    .unwrap_or(Json::Null),
            ),
            ("mediaReport", self.media_report.to_json()),
        ])
    }
}
// Persist source-to-local aliases so collided IDs retain identity on reimport and re-export.
#[derive(Clone)]
pub(crate) struct MergeOrigin {
    kind: String,
    source_id: String,
    created_at: String,
    local_id: String,
}
impl MergeOrigin {
    pub(crate) fn to_json(&self) -> Json {
        Json::obj(vec![
            ("kind", Json::str(&self.kind)),
            ("sourceId", Json::str(&self.source_id)),
            ("createdAt", Json::str(&self.created_at)),
            ("localId", Json::str(&self.local_id)),
        ])
    }
    pub(crate) fn from_json(v: &Json) -> Result<Self, CoreError> {
        let field = |k| {
            v.get(k)
                .and_then(Json::as_str)
                .map(str::to_owned)
                .ok_or_else(|| bad("无效的合并来源映射"))
        };
        let o = Self {
            kind: field("kind")?,
            source_id: field("sourceId")?,
            created_at: field("createdAt")?,
            local_id: field("localId")?,
        };
        if !["record", "photo"].contains(&o.kind.as_str()) {
            return Err(bad("无效的映射类型"));
        }
        Ok(o)
    }
}
fn bad(message: &str) -> CoreError {
    CoreError::new("STATE_CORRUPT", message)
}
pub(crate) fn validate_ids(s: &State) -> Result<(), CoreError> {
    let mut ids = BTreeMap::<String, String>::new();
    let mut check = |id: &str, owner: String| -> Result<(), CoreError> {
        let (_, n) = id.rsplit_once('-').ok_or_else(|| bad("ID 格式无效"))?;
        let n = n.parse::<u64>().map_err(|_| bad("ID 编号无效"))?;
        if n > s.seq {
            return Err(bad("seq 小于已使用的 ID 编号"));
        }
        // Own the key: the closure receives IDs from different snapshot lifetimes.
        if let Some(previous) = ids.get(id) {
            if previous != &owner {
                return Err(bad("ID 重复"));
            }
        } else {
            ids.insert(id.to_owned(), owner);
        }
        Ok(())
    };
    let mut records = BTreeSet::new();
    for r in &s.records {
        if !records.insert(&r.record_id) {
            return Err(bad("recordId 重复"));
        }
        check(&r.record_id, format!("record:{}", r.record_id))?;
    }
    let mut conflicts = BTreeSet::new();
    for c in &s.conflict_copies {
        if !conflicts.insert(&c.conflict_id) {
            return Err(bad("conflictId 重复"));
        }
        check(&c.conflict_id, format!("conflict:{}", c.conflict_id))?;
    }
    for (r, p) in s.photo_refs() {
        check(
            &p.photo_use_id,
            format!("photo:{r}:{}:{}", p.asset_id, p.sha256),
        )?;
    }
    for snap in s
        .records
        .iter()
        .flat_map(|r| r.formal.iter().chain(r.draft.iter()))
        .chain(s.conflict_copies.iter().map(|c| &c.snapshot))
    {
        let mut uses = BTreeSet::new();
        for photo in &snap.photos {
            if !uses.insert(&photo.photo_use_id) {
                return Err(bad("快照中 photoUseId 重复"));
            }
        }
    }
    for m in &s.deletion_markers {
        let n = m
            .record_id
            .rsplit_once('-')
            .and_then(|(_, n)| n.parse::<u64>().ok())
            .ok_or_else(|| bad("删除标记 ID 无效"))?;
        if n > s.seq {
            return Err(bad("seq 小于删除标记 ID 编号"));
        }
    }

    let mut origins = BTreeMap::new();
    for o in &s.merge_origins {
        let key = (&o.kind, &o.source_id, &o.created_at);
        if let Some(old) = origins.insert(key, &o.local_id) {
            if old != &o.local_id {
                return Err(bad("来源 ID 映射冲突"));
            }
        }
    }
    Ok(())
}
fn allocate(s: &mut State, prefix: &str) -> Result<String, CoreError> {
    s.seq = s
        .seq
        .checked_add(1)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or_else(|| bad("ID 编号已耗尽"))?;
    Ok(format!("{prefix}-{:06}", s.seq))
}
fn origin(s: &State, r: &RecordRow) -> RecordIdentity {
    let id = s
        .merge_origins
        .iter()
        .find(|o| o.kind == "record" && o.local_id == r.record_id && o.created_at == r.created_at)
        .map(|o| o.source_id.clone())
        .unwrap_or_else(|| r.record_id.clone());
    RecordIdentity {
        record_id: id,
        created_at: r.created_at.clone(),
    }
}
fn find_record(s: &State, key: &RecordIdentity) -> Option<usize> {
    s.records.iter().position(|r| origin(s, r) == *key)
}
fn deleted(s: &State, key: &RecordIdentity) -> bool {
    s.deletion_markers.iter().any(|m| {
        m.matches(&key.record_id, Some(&key.created_at))
            || s.merge_origins.iter().any(|o| {
                o.kind == "record"
                    && o.source_id == key.record_id
                    && o.created_at == key.created_at
                    && m.matches(&o.local_id, Some(&key.created_at))
            })
    })
}
fn snapshots_mut(r: &mut RecordRow) -> impl Iterator<Item = &mut Snapshot> {
    r.formal.iter_mut().chain(r.draft.iter_mut())
}
fn normalize_photos(
    s: &mut State,
    incoming: &State,
    key: &RecordIdentity,
    target: &str,
    snapshot: &mut Snapshot,
) -> Result<(), CoreError> {
    for p in &mut snapshot.photos {
        let source = incoming
            .merge_origins
            .iter()
            .find(|o| {
                o.kind == "photo" && o.local_id == p.photo_use_id && o.created_at == key.created_at
            })
            .map(|o| o.source_id.clone())
            .unwrap_or_else(|| {
                Json::Arr(vec![
                    Json::str(&key.record_id),
                    Json::str(&p.photo_use_id),
                    Json::str(&p.asset_id),
                    Json::str(&p.sha256),
                ])
                .dump()
            });
        let source_value = crate::json::parse(&source).map_err(|_| bad("无效的照片来源映射"))?;
        let source_fields = source_value
            .as_arr()
            .filter(|a| a.len() == 4)
            .ok_or_else(|| bad("无效的照片来源映射"))?;
        let original_id = source_fields[1]
            .as_str()
            .ok_or_else(|| bad("无效的照片来源 ID"))?;
        p.photo_use_id = original_id.to_owned();
        if let Some(o) = s
            .merge_origins
            .iter()
            .find(|o| o.kind == "photo" && o.source_id == source && o.created_at == key.created_at)
        {
            p.photo_use_id = o.local_id.clone();
            continue;
        }
        let collision = s.photo_refs().iter().any(|(r, x)| {
            x.photo_use_id == p.photo_use_id
                && (*r != target || x.asset_id != p.asset_id || x.sha256 != p.sha256)
        });
        if collision {
            let new = allocate(s, "pu")?;
            s.merge_origins.push(MergeOrigin {
                kind: "photo".into(),
                source_id: source,
                created_at: key.created_at.clone(),
                local_id: new.clone(),
            });
            p.photo_use_id = new;
        }
    }
    Ok(())
}
fn conflict(
    s: &mut State,
    r: &RecordRow,
    snapshot: &Snapshot,
    reason: &str,
    p: &mut MergePlan,
) -> Result<bool, CoreError> {
    if s.conflict_copies
        .iter()
        .any(|c| c.record_id == r.record_id && c.snapshot == *snapshot)
    {
        return Ok(false);
    }
    let id = allocate(s, "conflict")?;
    s.conflict_copies.push(ConflictCopy {
        conflict_id: id,
        record_id: r.record_id.clone(),
        base_revision: r.content_revision,
        snapshot: snapshot.clone(),
        created_at: r.updated_at.clone(),
        reason: reason.into(),
    });
    p.conflict_copies_added += 1;
    Ok(true)
}
/// Merge validated states, with checked ID allocation and strict output validation.
/// Photos and missing-original counts are filled by Store's read-only media inspection.
pub fn merge_states(local: &State, incoming: &State) -> Result<(State, MergePlan), CoreError> {
    validate_ids(local)?;
    validate_ids(incoming)?;
    let mut s = local.clone();
    let mut p = MergePlan::default();
    s.seq = s.seq.max(incoming.seq);
    let mut mapping = BTreeMap::new();
    for original in &incoming.records {
        let key = origin(incoming, original);
        if deleted(&s, &key) {
            p.skipped_deleted.push(key);
            continue;
        }
        let index = find_record(&s, &key);
        let mut r = original.clone();
        r.record_id = if let Some(i) = index {
            s.records[i].record_id.clone()
        } else if s.records.iter().any(|x| x.record_id == r.record_id)
            || s.deletion_markers
                .iter()
                .any(|m| m.record_id == r.record_id)
        {
            allocate(&mut s, "rec")?
        } else {
            r.record_id.clone()
        };
        if r.record_id != key.record_id
            && !s.merge_origins.iter().any(|o| {
                o.kind == "record" && o.source_id == key.record_id && o.created_at == key.created_at
            })
        {
            s.merge_origins.push(MergeOrigin {
                kind: "record".into(),
                source_id: key.record_id.clone(),
                created_at: key.created_at.clone(),
                local_id: r.record_id.clone(),
            });
        }
        mapping.insert(
            original.record_id.clone(),
            (r.record_id.clone(), key.clone()),
        );
        let target = r.record_id.clone();
        for snap in snapshots_mut(&mut r) {
            normalize_photos(&mut s, incoming, &key, &target, snap)?;
        }
        let Some(index) = index else {
            s.records.push(r);
            p.added += 1;
            continue;
        };
        let mut l = s.records[index].clone();
        let kept_trashed = l.status == RecordStatus::Trashed && r.status == RecordStatus::Active;
        if kept_trashed {
            p.kept_trashed += 1;
        }
        if l.status == RecordStatus::Active && r.status == RecordStatus::Trashed {
            p.kept_active += 1;
        }
        if l.formal == r.formal {
            l.content_revision = l.content_revision.max(r.content_revision);
            p.unchanged += 1;
        } else if !kept_trashed && r.content_revision > l.content_revision && r.formal.is_some() {
            if let Some(old) = &l.formal {
                conflict(&mut s, &l, old, "merge-replaced-local", &mut p)?;
            }
            l.formal = r.formal.clone();
            l.content_revision = r.content_revision;
            l.committed_at = r.committed_at.clone();
            p.updated += 1;
        } else if let Some(snap) = &r.formal {
            if conflict(&mut s, &r, snap, "merge-incoming", &mut p)? {
                p.conflicts += 1;
            } else {
                p.unchanged += 1;
            }
        }
        if let Some(d) = &r.draft {
            if let Some(ld) = &l.draft {
                if d != ld {
                    conflict(&mut s, &l, d, "merge-incoming-draft", &mut p)?;
                }
            } else if r.base_revision < l.content_revision {
                conflict(&mut s, &l, d, "merge-incoming-draft", &mut p)?;
            } else {
                l.draft = Some(d.clone());
                l.base_revision = l.content_revision;
            }
        }
        s.records[index] = l;
    }
    for m in &incoming.deletion_markers {
        let mut marker = m.clone();
        if let Some(o) = incoming.merge_origins.iter().find(|o| {
            o.kind == "record"
                && o.local_id == m.record_id
                && m.created_at.as_deref().is_none_or(|c| c == o.created_at)
        }) {
            marker.record_id = o.source_id.clone();
        }
        let found = s.records.iter().find(|r| {
            let key = origin(&s, r);
            marker.matches(&key.record_id, Some(&key.created_at))
        });
        if let Some(r) = found {
            p.deleted_in_backup.push(origin(&s, r));
        } else if !s
            .deletion_markers
            .iter()
            .any(|x| x.matches(&marker.record_id, marker.created_at.as_deref()))
        {
            s.deletion_markers.push(marker);
            p.markers_added += 1;
        }
    }
    for c in &incoming.conflict_copies {
        let Some((id, key)) = mapping.get(&c.record_id) else {
            p.conflict_copies_dropped += 1;
            continue;
        };
        let mut snapshot = c.snapshot.clone();
        normalize_photos(&mut s, incoming, key, id, &mut snapshot)?;
        let row = s
            .records
            .iter()
            .find(|r| r.record_id == *id)
            .unwrap()
            .clone();
        if s.conflict_copies
            .iter()
            .any(|x| x.record_id == *id && x.created_at == c.created_at && x.snapshot == snapshot)
        {
            continue;
        }
        let mut copy = c.clone();
        copy.record_id = id.clone();
        copy.snapshot = snapshot;
        if s.conflict_copies
            .iter()
            .any(|x| x.conflict_id == copy.conflict_id)
        {
            copy.conflict_id = allocate(&mut s, "conflict")?;
        }
        // record identity is supplied by the mapped owner, not conflict.createdAt.
        copy.record_id = row.record_id;
        s.conflict_copies.push(copy);
        p.conflict_copies_added += 1;
    }
    // Do not advance seq on a no-op: byte-identical idempotent imports.
    if s.records
        .iter()
        .map(RecordRow::to_json)
        .eq(local.records.iter().map(RecordRow::to_json))
        && s.deletion_markers == local.deletion_markers
        && s.conflict_copies == local.conflict_copies
        && s.merge_origins.len() == local.merge_origins.len()
    {
        s.seq = local.seq;
    }
    let s = State::from_json(&s.to_json("validated-merge"))?;
    Ok((s, p))
}
