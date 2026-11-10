/**
 * Unit-0.7 标签字典与关联事务（G06 / M05-S05、B01、B02），与 Rust core 同语义；供浏览器预览 MemoryAdapter 使用。
 * 每个函数在调用方给出的候选状态上就地修改；调用方负责“全部成功才持久化”（原子边界）。
 */
import type { RecordRow, TagAlias, TagDef, TagInfo, TagTombstone } from "./types.ts";

export interface TagState {
  seq: number;
  records: RecordRow[];
  tags: TagDef[];
  tagDictRevision: number;
  tagAliases: TagAlias[];
  tagTombstones: TagTombstone[];
}

const err = (code: string, message: string, extra: Record<string, unknown> = {}): never => { throw { code, message, ...extra }; };

/** 去首尾空白；内部连续空白折叠；英文小写化 → 规范名（同名判断用）。 */
export function normalizeTagName(raw: string): { name: string; normName: string } {
  const name = raw.trim().replace(/\s+/g, " ");
  return { name, normName: name.toLowerCase() };
}

export function validateTagName(raw: string): { name: string; normName: string } {
  const out = normalizeTagName(raw);
  // eslint-disable-next-line no-control-regex
  if (out.name.length === 0 || [...out.name].length > 40 || /[\u0000-\u001f\u007f]/.test(raw.trim())) {
    err("TAG_NAME_INVALID", "标签名需为 1–40 个字符，且不能为空或包含换行");
  }
  return out;
}

export function findTag(state: TagState, tagId: string): TagDef {
  return state.tags.find((t) => t.tagId === tagId) ?? err("TAG_NOT_FOUND", "标签不存在或已被合并/删除");
}

function allocTagId(state: TagState): string {
  let id: string;
  const used = new Set(state.tags.map((t) => t.tagId).concat(state.tagTombstones.map((t) => t.tagId), state.tagAliases.map((a) => a.fromTagId)));
  do { id = `tag-${String(++state.seq).padStart(6, "0")}`; } while (used.has(id));
  return id;
}

export function createTag(state: TagState, raw: string, now: string): TagDef {
  const { name, normName } = validateTagName(raw);
  const existing = state.tags.find((t) => t.normName === normName);
  if (existing) err("TAG_NAME_CONFLICT", `已有同名标签「${existing.name}」，可直接使用`, { tagId: existing.tagId });
  const tag: TagDef = { tagId: allocTagId(state), name, normName, createdAt: now };
  state.tags.push(tag);
  state.tagDictRevision += 1;
  return tag;
}

export function renameTag(state: TagState, tagId: string, raw: string): TagDef {
  const tag = findTag(state, tagId);
  const { name, normName } = validateTagName(raw);
  const other = state.tags.find((t) => t.normName === normName && t.tagId !== tagId);
  if (other) err("TAG_NAME_CONFLICT", `已有同名标签「${other.name}」。可以选择“合并”到它，或取消`, { tagId: other.tagId });
  if (tag.name === name) return tag;
  tag.name = name; tag.normName = normName;
  state.tagDictRevision += 1;
  return tag;
}

/** 合并：同一次变更里改写关联（去重）、删除来源、留别名、改指旧别名。返回受影响记录数。 */
export function mergeTags(state: TagState, fromId: string, intoId: string, now: string): number {
  if (fromId === intoId) err("TAG_MERGE_SAME", "不能把标签合并到它自己");
  const from = findTag(state, fromId);
  findTag(state, intoId);
  let affected = 0;
  for (const r of state.records) {
    if (!r.tagIds.includes(fromId)) continue;
    const next: string[] = [];
    for (const t of r.tagIds) { const v = t === fromId ? intoId : t; if (!next.includes(v)) next.push(v); }
    r.tagIds = next; r.tagRevision += 1; affected += 1;
  }
  state.tags = state.tags.filter((t) => t.tagId !== fromId);
  for (const a of state.tagAliases) if (a.toTagId === fromId) a.toTagId = intoId;
  state.tagAliases.push({ fromTagId: fromId, fromCreatedAt: from.createdAt, toTagId: intoId, mergedAt: now });
  state.tagDictRevision += 1;
  return affected;
}

/** 删除：只解除关联（不删记录/照片/文字），留墓碑；指向它的别名也转为墓碑。 */
export function deleteTag(state: TagState, tagId: string, now: string): number {
  const tag = findTag(state, tagId);
  let affected = 0;
  for (const r of state.records) {
    if (!r.tagIds.includes(tagId)) continue;
    r.tagIds = r.tagIds.filter((t) => t !== tagId); r.tagRevision += 1; affected += 1;
  }
  state.tags = state.tags.filter((t) => t.tagId !== tagId);
  state.tagTombstones.push({ tagId, createdAt: tag.createdAt, deletedAt: now });
  for (const a of state.tagAliases.filter((x) => x.toTagId === tagId)) {
    state.tagTombstones.push({ tagId: a.fromTagId, createdAt: a.fromCreatedAt, deletedAt: now });
  }
  state.tagAliases = state.tagAliases.filter((a) => a.toTagId !== tagId);
  state.tagDictRevision += 1;
  return affected;
}

export function tagImpact(state: TagState, tagId: string): { active: number; trashed: number } {
  findTag(state, tagId);
  let active = 0, trashed = 0;
  for (const r of state.records) {
    if (!r.tagIds.includes(tagId)) continue;
    if (r.status === "trashed") trashed += 1; else if (r.formal) active += 1;
  }
  return { active, trashed };
}

export function listTags(state: TagState): TagInfo[] {
  return state.tags
    .map((t) => ({ tagId: t.tagId, name: t.name, createdAt: t.createdAt, ...countsFor(state, t.tagId) }))
    .sort((a, b) => normalizeTagName(a.name).normName.localeCompare(normalizeTagName(b.name).normName) || a.tagId.localeCompare(b.tagId));
}

function countsFor(state: TagState, tagId: string): { activeCount: number; trashedCount: number } {
  const { active, trashed } = tagImpact(state, tagId);
  return { activeCount: active, trashedCount: trashed };
}

/** 严格校验：无悬空引用、记录内不重复、tagId/normName 唯一、别名与墓碑不与活跃标签冲突。 */
export function validateTagState(state: TagState): void {
  const ids = new Set<string>(), norms = new Set<string>();
  for (const t of state.tags) {
    if (typeof t.tagId !== "string" || typeof t.name !== "string" || typeof t.createdAt !== "string" || ids.has(t.tagId)) throw new Error("标签结构无效");
    const n = normalizeTagName(t.name);
    if (n.name !== t.name || n.normName !== t.normName || norms.has(t.normName)) throw new Error("标签名无效或重名");
    ids.add(t.tagId); norms.add(t.normName);
  }
  for (const a of state.tagAliases) if (!ids.has(a.toTagId) || ids.has(a.fromTagId)) throw new Error("标签别名无效");
  for (const b of state.tagTombstones) if (ids.has(b.tagId)) throw new Error("标签墓碑与活跃标签冲突");
  for (const r of state.records) {
    if (!Array.isArray(r.tagIds) || new Set(r.tagIds).size !== r.tagIds.length || r.tagIds.some((t) => !ids.has(t))) throw new Error("记录标签引用无效");
    if (typeof r.favorite !== "boolean" || !Number.isInteger(r.favoriteRevision) || r.favoriteRevision < 0
      || !Number.isInteger(r.tagRevision) || r.tagRevision < 0) throw new Error("记录元数据无效");
  }
}

export interface TagMergeCounts { tagsAdded: number; tagsRemapped: number; tagsSkippedDeleted: number; tagsDeletedInBackup: number }

/**
 * 合并导入的标签映射：返回 incoming tagId → 本地 tagId（null = 已删除，丢弃引用）。会把新增标签、别名、墓碑写入 local。
 * 顺序：本地墓碑（不复活）→ 本地别名（重映射到终点）→ 同规范名（同一标签）→ 新增（撞号重编）。
 */
export function mergeTagDictionaries(local: TagState, incoming: TagState, counts: TagMergeCounts): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const resolveAlias = (id: string, createdAt: string): string | null => {
    let a = local.tagAliases.find((x) => x.fromTagId === id && x.fromCreatedAt === createdAt);
    let guard = 0;
    while (a && guard++ < 64) {
      if (local.tags.some((t) => t.tagId === a!.toTagId)) return a.toTagId;
      const to = a.toTagId; a = local.tagAliases.find((x) => x.fromTagId === to);
    }
    return null;
  };
  for (const t of incoming.tags) {
    if (local.tagTombstones.some((b) => b.tagId === t.tagId && b.createdAt === t.createdAt)) { map.set(t.tagId, null); counts.tagsSkippedDeleted++; continue; }
    const aliased = resolveAlias(t.tagId, t.createdAt);
    if (aliased) { map.set(t.tagId, aliased); counts.tagsRemapped++; continue; }
    const same = local.tags.find((x) => x.normName === t.normName);
    if (same) { map.set(t.tagId, same.tagId); continue; }
    const clash = local.tags.some((x) => x.tagId === t.tagId) || local.tagTombstones.some((b) => b.tagId === t.tagId)
      || local.tagAliases.some((a) => a.fromTagId === t.tagId);
    const tagId = clash ? allocTagId(local) : t.tagId;
    local.tags.push({ ...t, tagId });
    local.tagDictRevision += 1;
    map.set(t.tagId, tagId); counts.tagsAdded++;
  }
  // incoming 的别名：本地没有来源 → 记录（指向映射后的终点），防将来复活。
  for (const a of incoming.tagAliases) {
    const to = map.get(a.toTagId);
    if (!to) continue;
    if (local.tags.some((t) => t.tagId === a.fromTagId && t.createdAt === a.fromCreatedAt)) continue; // 本地仍在用：保留本地
    if (local.tagAliases.some((x) => x.fromTagId === a.fromTagId && x.fromCreatedAt === a.fromCreatedAt)) continue;
    if (local.tags.some((t) => t.tagId === a.fromTagId)) continue;
    local.tagAliases.push({ ...a, toTagId: to });
  }
  for (const b of incoming.tagTombstones) {
    if (local.tags.some((t) => t.tagId === b.tagId && t.createdAt === b.createdAt)) { counts.tagsDeletedInBackup++; continue; }
    if (local.tags.some((t) => t.tagId === b.tagId)) continue;
    if (local.tagTombstones.some((x) => x.tagId === b.tagId && x.createdAt === b.createdAt)) continue;
    local.tagTombstones.push({ ...b });
  }
  return map;
}

export function mapTagIds(ids: readonly string[], map: Map<string, string | null>): string[] {
  const out: string[] = [];
  for (const id of ids) { const v = map.get(id); if (v && !out.includes(v)) out.push(v); }
  return out;
}
