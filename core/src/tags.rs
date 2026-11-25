//! Independent record metadata and atomic dictionary/link transactions.
use crate::{
    fault::{self, FaultPoint},
    json::Json,
    model::req_str,
    persist::Durability,
    store::write_lock,
    time, CoreError, RecordRow, RecordStatus, State, Store,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tag {
    pub tag_id: String,
    pub name: String,
    pub norm_name: String,
    pub created_at: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagAlias {
    pub from_tag_id: String,
    pub from_created_at: String,
    pub to_tag_id: String,
    pub merged_at: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagTombstone {
    pub tag_id: String,
    pub created_at: String,
    pub deleted_at: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MetaOutcome {
    pub record_id: String,
    pub favorite: bool,
    pub favorite_revision: u32,
    pub tag_ids: Vec<String>,
    pub tag_revision: u32,
    pub durability: Durability,
}
#[derive(Clone, Debug)]
pub struct TagMergeOutcome {
    pub into: Tag,
    pub affected_records: usize,
    pub durability: Durability,
}
#[derive(Clone, Debug)]
pub struct TagDeleteOutcome {
    pub affected_records: usize,
    pub durability: Durability,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagInfo {
    pub tag_id: String,
    pub name: String,
    pub created_at: String,
    pub active_count: usize,
    pub trashed_count: usize,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TagImpact {
    pub active: usize,
    pub trashed: usize,
}
impl Tag {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("tagId", Json::str(&self.tag_id)),
            ("name", Json::str(&self.name)),
            ("normName", Json::str(&self.norm_name)),
            ("createdAt", Json::str(&self.created_at)),
        ])
    }
    pub fn from_json(v: &Json) -> Result<Self, String> {
        Ok(Self {
            tag_id: req_str(v, "tagId")?,
            name: req_str(v, "name")?,
            norm_name: req_str(v, "normName")?,
            created_at: req_str(v, "createdAt")?,
        })
    }
}
impl TagAlias {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("fromTagId", Json::str(&self.from_tag_id)),
            ("fromCreatedAt", Json::str(&self.from_created_at)),
            ("toTagId", Json::str(&self.to_tag_id)),
            ("mergedAt", Json::str(&self.merged_at)),
        ])
    }
    pub fn from_json(v: &Json) -> Result<Self, String> {
        Ok(Self {
            from_tag_id: req_str(v, "fromTagId")?,
            from_created_at: req_str(v, "fromCreatedAt")?,
            to_tag_id: req_str(v, "toTagId")?,
            merged_at: req_str(v, "mergedAt")?,
        })
    }
}
impl TagTombstone {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("tagId", Json::str(&self.tag_id)),
            ("createdAt", Json::str(&self.created_at)),
            ("deletedAt", Json::str(&self.deleted_at)),
        ])
    }
    pub fn from_json(v: &Json) -> Result<Self, String> {
        Ok(Self {
            tag_id: req_str(v, "tagId")?,
            created_at: req_str(v, "createdAt")?,
            deleted_at: req_str(v, "deletedAt")?,
        })
    }
}
impl MetaOutcome {
    fn new(r: &RecordRow, durability: Durability) -> Self {
        Self {
            record_id: r.record_id.clone(),
            favorite: r.favorite,
            favorite_revision: r.favorite_revision,
            tag_ids: r.tag_ids.clone(),
            tag_revision: r.tag_revision,
            durability,
        }
    }
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("recordId", Json::str(&self.record_id)),
            ("favorite", Json::Bool(self.favorite)),
            ("favoriteRevision", Json::Num(self.favorite_revision as i64)),
            (
                "tagIds",
                Json::Arr(self.tag_ids.iter().map(Json::str).collect()),
            ),
            ("tagRevision", Json::Num(self.tag_revision as i64)),
            ("durability", Json::str(self.durability.as_str())),
        ])
    }
}
impl TagMergeOutcome {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("into", self.into.to_json()),
            ("affectedRecords", Json::Num(self.affected_records as i64)),
            ("durability", Json::str(self.durability.as_str())),
        ])
    }
}
impl TagDeleteOutcome {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("affectedRecords", Json::Num(self.affected_records as i64)),
            ("durability", Json::str(self.durability.as_str())),
        ])
    }
}
impl TagInfo {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("tagId", Json::str(&self.tag_id)),
            ("name", Json::str(&self.name)),
            ("createdAt", Json::str(&self.created_at)),
            ("activeCount", Json::Num(self.active_count as i64)),
            ("trashedCount", Json::Num(self.trashed_count as i64)),
        ])
    }
}
impl TagImpact {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("active", Json::Num(self.active as i64)),
            ("trashed", Json::Num(self.trashed as i64)),
        ])
    }
}

pub fn normalize_name(raw: &str) -> Result<(String, String), CoreError> {
    let name = raw.trim();
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
        || name.is_empty()
        || name.chars().count() > 40
    {
        return Err(CoreError::new(
            "TAG_NAME_INVALID",
            "标签名称请填写 1–40 个字符，不能包含换行或控制字符",
        ));
    }
    Ok((
        name.into(),
        name.to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
    ))
}
fn missing() -> CoreError {
    CoreError::new("TAG_NOT_FOUND", "这个标签已不存在，请刷新后重新选择")
}
fn tag(s: &State, id: &str) -> Result<usize, CoreError> {
    s.tags
        .iter()
        .position(|t| t.tag_id == id)
        .ok_or_else(missing)
}
fn name_available(s: &State, norm: &str, except: Option<&str>) -> Result<(), CoreError> {
    if let Some(t) = s
        .tags
        .iter()
        .find(|t| t.norm_name == norm && Some(t.tag_id.as_str()) != except)
    {
        let mut error = CoreError::new(
            "TAG_NAME_CONFLICT",
            format!(
                "已有同名标签（{}），可直接使用；改名时请选择合并或取消",
                t.tag_id
            ),
        );
        error.tag_id = Some(t.tag_id.clone());
        return Err(error);
    }
    Ok(())
}
fn bump(n: &mut u32) -> Result<(), CoreError> {
    *n = n.checked_add(1).ok_or_else(|| {
        CoreError::new(
            "META_REVISION_CONFLICT",
            "修订号已用尽，请导出备份后联系支持",
        )
    })?;
    Ok(())
}
pub(crate) fn bump_dict(s: &mut State) -> Result<(), CoreError> {
    s.tag_dict_revision = s
        .tag_dict_revision
        .checked_add(1)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or_else(|| CoreError::new("STATE_CORRUPT", "标签字典修订号已用尽"))?;
    Ok(())
}
fn check_cas(current: u32, expected: Option<u32>, kind: &str) -> Result<(), CoreError> {
    if expected.is_some_and(|e| e != current) {
        return Err(CoreError::new(
            "META_REVISION_CONFLICT",
            format!("{kind}已在别处改变，请刷新后重试"),
        ));
    }
    Ok(())
}
fn formal<'a>(s: &'a mut State, id: &str) -> Result<&'a mut RecordRow, CoreError> {
    let r = s.row_mut(id)?;
    if r.formal.is_none() {
        return Err(CoreError::new(
            "RECORD_NOT_FORMAL",
            "请先将草稿存入时光，再设置珍藏",
        ));
    }
    Ok(r)
}
pub(crate) fn dedup(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    ids.into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

impl Store {
    /// Uses the same write lock, reload, validation and atomic replacement as content writes.
    /// No-op metadata operations do not touch the state file or visit write fault points.
    pub(crate) fn meta_transact<T>(
        &mut self,
        op: impl FnOnce(&mut State) -> Result<T, CoreError>,
    ) -> Result<(T, Durability), CoreError> {
        let _lock = write_lock(self.root())?;
        let mut candidate = self.candidate_state()?;
        let before = candidate.to_json(self.seed());
        let value = op(&mut candidate)?;
        let durability = if candidate.to_json(self.seed()) == before {
            self.state = candidate;
            self.last_durability().clone()
        } else {
            fault::hit(FaultPoint::TagTxnWrite)?;
            self.apply_candidate(candidate)?
        };
        Ok((value, durability))
    }
    pub fn set_favorite(
        &mut self,
        id: &str,
        favorite: bool,
        expected: Option<u32>,
    ) -> Result<MetaOutcome, CoreError> {
        let (r, d) = self.meta_transact(|s| {
            let r = formal(s, id)?;
            check_cas(r.favorite_revision, expected, "珍藏状态")?;
            if r.favorite != favorite {
                bump(&mut r.favorite_revision)?;
                r.favorite = favorite;
            }
            Ok(r.clone())
        })?;
        Ok(MetaOutcome::new(&r, d))
    }
    pub fn set_record_tags(
        &mut self,
        id: &str,
        ids: &[String],
        expected: Option<u32>,
    ) -> Result<MetaOutcome, CoreError> {
        let (r, d) = self.meta_transact(|s| {
            let r = s.row_mut(id)?;
            check_cas(r.tag_revision, expected, "标签关联")?;
            let ids = dedup(ids.iter().cloned());
            for id in &ids {
                tag(s, id)?;
            }
            let r = s.row_mut(id)?;
            let same = r.tag_ids.iter().collect::<BTreeSet<_>>() == ids.iter().collect();
            if !same {
                bump(&mut r.tag_revision)?;
                r.tag_ids = ids;
            }
            Ok(r.clone())
        })?;
        Ok(MetaOutcome::new(&r, d))
    }
    pub fn create_tag(&mut self, name: &str) -> Result<Tag, CoreError> {
        self.meta_transact(|s| {
            let (name, norm_name) = normalize_name(name)?;
            name_available(s, &norm_name, None)?;
            s.seq = s
                .seq
                .checked_add(1)
                .filter(|n| *n <= i64::MAX as u64)
                .ok_or_else(|| CoreError::new("STATE_CORRUPT", "标签编号已用尽"))?;
            let t = Tag {
                tag_id: format!("tag-{:06}", s.seq),
                name,
                norm_name,
                created_at: time::now_rfc3339(),
            };
            s.tags.push(t.clone());
            bump_dict(s)?;
            Ok(t)
        })
        .map(|(t, _)| t)
    }
    pub fn rename_tag(&mut self, id: &str, name: &str) -> Result<Tag, CoreError> {
        self.meta_transact(|s| {
            let i = tag(s, id)?;
            let (name, norm) = normalize_name(name)?;
            name_available(s, &norm, Some(id))?;
            if s.tags[i].name != name {
                s.tags[i].name = name;
                s.tags[i].norm_name = norm;
                bump_dict(s)?;
            }
            Ok(s.tags[i].clone())
        })
        .map(|(t, _)| t)
    }
    pub fn merge_tags(&mut self, from: &str, into: &str) -> Result<TagMergeOutcome, CoreError> {
        let ((into, affected_records), durability) = self.meta_transact(|s| {
            if from == into {
                return Err(CoreError::new(
                    "TAG_MERGE_SAME",
                    "请选择两个不同的标签进行合并",
                ));
            }
            let f = s.tags[tag(s, from)?].clone();
            let into = s.tags[tag(s, into)?].clone();
            let mut affected = 0;
            for r in &mut s.records {
                if r.tag_ids.iter().any(|id| id == from) {
                    r.tag_ids = dedup(r.tag_ids.iter().map(|id| {
                        if id == from {
                            into.tag_id.clone()
                        } else {
                            id.clone()
                        }
                    }));
                    bump(&mut r.tag_revision)?;
                    affected += 1;
                }
            }
            s.tags.retain(|t| t.tag_id != from);
            for a in &mut s.tag_aliases {
                if a.to_tag_id == from {
                    a.to_tag_id = into.tag_id.clone();
                }
            }
            s.tag_aliases.push(TagAlias {
                from_tag_id: f.tag_id,
                from_created_at: f.created_at,
                to_tag_id: into.tag_id.clone(),
                merged_at: time::now_rfc3339(),
            });
            bump_dict(s)?;
            Ok((into, affected))
        })?;
        Ok(TagMergeOutcome {
            into,
            affected_records,
            durability,
        })
    }
    pub fn delete_tag(&mut self, id: &str) -> Result<TagDeleteOutcome, CoreError> {
        let (affected_records, durability) = self.meta_transact(|s| {
            let t = s.tags[tag(s, id)?].clone();
            let mut affected = 0;
            for r in &mut s.records {
                if r.tag_ids.iter().any(|t| t == id) {
                    r.tag_ids.retain(|t| t != id);
                    bump(&mut r.tag_revision)?;
                    affected += 1;
                }
            }
            s.tags.retain(|t| t.tag_id != id);
            let deleted_at = time::now_rfc3339();
            s.tag_tombstones.push(TagTombstone {
                tag_id: t.tag_id,
                created_at: t.created_at,
                deleted_at: deleted_at.clone(),
            });
            for a in &s.tag_aliases {
                if a.to_tag_id == id {
                    s.tag_tombstones.push(TagTombstone {
                        tag_id: a.from_tag_id.clone(),
                        created_at: a.from_created_at.clone(),
                        deleted_at: deleted_at.clone(),
                    });
                }
            }
            s.tag_aliases.retain(|a| a.to_tag_id != id);
            bump_dict(s)?;
            Ok(affected)
        })?;
        Ok(TagDeleteOutcome {
            affected_records,
            durability,
        })
    }
    pub fn tag_impact(&self, id: &str) -> Result<TagImpact, CoreError> {
        tag(&self.state, id)?;
        Ok(impact(&self.state, id))
    }
    pub fn list_tags(&self) -> Vec<TagInfo> {
        let mut tags: Vec<_> = self.state.tags.iter().collect();
        tags.sort_by(|a, b| a.norm_name.cmp(&b.norm_name));
        tags.into_iter()
            .map(|t| {
                let c = impact(&self.state, &t.tag_id);
                TagInfo {
                    tag_id: t.tag_id.clone(),
                    name: t.name.clone(),
                    created_at: t.created_at.clone(),
                    active_count: c.active,
                    trashed_count: c.trashed,
                }
            })
            .collect()
    }
}
fn impact(s: &State, id: &str) -> TagImpact {
    let mut c = TagImpact::default();
    for r in &s.records {
        if r.tag_ids.iter().any(|t| t == id) {
            if r.status == RecordStatus::Trashed {
                c.trashed += 1;
            } else if r.formal.is_some() {
                c.active += 1;
            }
        }
    }
    c
}

/// Persisted aliases always point directly at a live terminal tag, so cycles and dangling chains cannot exist.
pub(crate) fn validate(s: &State) -> Result<(), CoreError> {
    let bad = || CoreError::new("STATE_CORRUPT", "标签字典、关联、别名或删除标记无效");
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    let check_id = |id: &str| {
        id.strip_prefix("tag-")
            .and_then(|n| n.parse::<u64>().ok())
            .is_some_and(|n| n > 0 && n <= s.seq)
    };
    for t in &s.tags {
        let (name, norm) = normalize_name(&t.name).map_err(|_| bad())?;
        if name != t.name
            || norm != t.norm_name
            || !ids.insert(&t.tag_id)
            || !names.insert(&t.norm_name)
            || !check_id(&t.tag_id)
        {
            return Err(bad());
        }
    }
    for r in &s.records {
        let mut seen = BTreeSet::new();
        for id in &r.tag_ids {
            if !ids.contains(id) || !seen.insert(id) {
                return Err(bad());
            }
        }
    }
    let mut aliases = BTreeMap::new();
    for a in &s.tag_aliases {
        if !check_id(&a.from_tag_id)
            || ids.contains(&a.from_tag_id)
            || !ids.contains(&a.to_tag_id)
            || aliases
                .insert((&a.from_tag_id, &a.from_created_at), &a.to_tag_id)
                .is_some()
        {
            return Err(bad());
        }
    }
    let mut tombs = BTreeSet::new();
    for t in &s.tag_tombstones {
        if !check_id(&t.tag_id)
            || ids.contains(&t.tag_id)
            || !tombs.insert((&t.tag_id, &t.created_at))
            || aliases.contains_key(&(&t.tag_id, &t.created_at))
        {
            return Err(bad());
        }
    }
    Ok(())
}
