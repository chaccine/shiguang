import type { TagAlias, TagDef, TagTombstone, TagInfo, TagImpact, MetaResult, TagMergeResult, TagDeleteResult, TimelineFilter, TimelinePage, MonthCount, CalendarDay, OnThisDayGroup, TimelineItem, SortOrder } from "../domain/types.ts";
import * as tl from "../domain/timeline.ts";
import * as tg from "../domain/tags.ts";
import type { CommitResult, DeletionMarker, Durability, RecordRow, Snapshot, ConflictChoice, ConflictCopy, MediaReport, PhotoStatus, PurgeResult, QuarantinedMedia, StoreStatus, BackupCapabilities, BackupCounts, BackupSummary, ExportBackupOptions, ExportBackupResult, MergeCounts, MergePlan, MergeResult, PickBackupResult, RestoreBackupResult } from "../domain/types.ts";
import { describeError } from "../domain/errors.ts";
import { isValidDate, isValidTime, validateForCommit, validateSnapshotDetails } from "../domain/rules.ts";
import type { ThemePreference } from "../domain/types.ts";
import type { AttachPhotoBytesInput, CreateDraftInput, DiscardResult, SaveDraftInput, SaveResult, ShiguangApi } from "./api.ts";
import { base64, sha256, sniffMediaType } from "./bytes.ts";

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
interface MemoryAsset { dataUrl: string; sha256: string; bytes: number }
interface MemoryState {
  version: 1;
  schemaVersion: 4;
  settings: { theme: ThemePreference; appLock: null };
  seq: number;
  records: RecordRow[];
  assets: Record<string, MemoryAsset>;
  deletionMarkers: DeletionMarker[];
  conflictCopies: ConflictCopy[];
  quarantine: Record<string, MemoryAsset>;
  /** Unit-0.6：被永久删除记录的 createdAt（与删除标记分开存放，供跨备份防复活匹配；不含正文）。 */
  deletedCreatedAt?: Record<string, string>;
  /** Unit-0.6：合并时撞号改号的来源映射（"来源id\u0000createdAt" → 本机id），保证重复导入幂等。 */
  mergeOrigins?: Record<string, string>;
  /** Unit-0.7（schema v3）：标签字典、合并别名、删除墓碑。 */
  tags: TagDef[];
  tagDictRevision: number;
  tagAliases: TagAlias[];
  tagTombstones: TagTombstone[];
}

/** v2 → v3：每条记录补珍藏/标签字段，顶层补标签字典（与 Rust migrate_v2_to_v3 同语义）。 */
export function migrateToV4(state: Omit<MemoryState, "schemaVersion" | "settings" | "tags" | "tagDictRevision" | "tagAliases" | "tagTombstones"> & Partial<Omit<MemoryState, "schemaVersion">> & { schemaVersion?: number }): MemoryState {
  const version = state.schemaVersion ?? 1;
  if (version > 4) fail("SCHEMA_TOO_NEW", "数据来自更新版本，请升级拾光");
  if (version < 3) {
    for (const row of state.records) {
      row.favorite ??= false; row.favoriteRevision ??= 0; row.tagIds ??= []; row.tagRevision ??= 0;
    }
    state.tags ??= []; state.tagDictRevision ??= 0; state.tagAliases ??= []; state.tagTombstones ??= [];
  }
  if (version < 4) {
    for (const snap of state.records.flatMap((r) => [r.formal, r.draft]).concat(state.conflictCopies.map((c) => c.snapshot))) {
      if (snap) { snap.location = ""; snap.mood = null; snap.coverPhotoUseId = snap.photos[0]?.photoUseId ?? null; }
    }
    state.settings = { theme: "system", appLock: null };
  }
  state.schemaVersion = 4;
  return state as MemoryState;
}
type Operation = keyof ShiguangApi;
/** 浏览器预览的备份包：manifest + 完整状态 + 整包哈希（模拟 .sgbak 的校验语义，不是真实文件）。 */
export interface PreviewBackup { magic: "SGBAK-PREVIEW"; body: string; sha256: string; bytes: number; lock?: { salt: string; check: string } }
export type PreviewPickKind = "lastExport" | "corrupt" | "truncated" | "schemaTooNew" | "encrypted" | "notBackup";
const encoder = new TextEncoder();
const copy = <T>(value: T): T => structuredClone(value);
const fail = (code: string, message = code): never => { throw { code, message }; };
const blank = (): Snapshot => ({ title: "", body: "", eventDate: "", eventTime: null, location: "", mood: null, coverPhotoUseId: null, photos: [] });
const normalizeTime = (value: string | null | undefined) => value?.trim() || null;

/** 仅供浏览器合成数据预览；storage 由调用方注入。 */
export class MemoryAdapter implements ShiguangApi {
  durabilityMode: Durability = "durable";
  private state: MemoryState = { version: 1, schemaVersion: 4, settings: { theme: "system", appLock: null }, seq: 0, records: [], assets: {}, deletionMarkers: [], conflictCopies: [], quarantine: {},
    tags: [], tagDictRevision: 0, tagAliases: [], tagTombstones: [] };
  private failures = new Map<Operation, string>();
  private pendingConflicts = new Map<string, { snapshot: Snapshot; baseRevision: number }>();
  private simulatedPhotos = new Map<string, PhotoStatus>();
  private simulateAllPhotos: PhotoStatus = "available";
  private startupError?: { code: string; message: string };
  private lastMediaReport: MediaReport | null = null;
  private storage?: StorageLike;
  private lastExport: PreviewBackup | null = null;
  private picked = new Map<string, { pkg: PreviewBackup; state: MemoryState | null }>();
  private injected: PreviewBackup | null = null;
  private pickSeq = 0;
  private nextPick: PreviewPickKind = "lastExport";
  private key: string;
  private now: () => string;

  constructor(options: { storage?: StorageLike; storageKey?: string; now?: () => string;
    search?: string; missingAssets?: readonly string[]; corruptAssets?: readonly string[] } = {}) {
    this.storage = options.storage;
    this.key = options.storageKey ?? "shiguang.synthetic.unit02";
    this.now = options.now ?? (() => new Date().toISOString());
    const params = new URLSearchParams(options.search ?? (typeof window === "undefined" ? "" : window.location.search));
    const code = params.get("fail") === "locked" ? "STORE_LOCKED" : params.get("fail") === "schema" ? "SCHEMA_TOO_NEW" : null;
    if (code) this.startupError = { code, message: describeError({ code }).detail };
    if (params.get("missing") === "1" || params.get("media") === "missing") this.simulateAllPhotos = "missing";
    if (params.get("media") === "corrupt") this.simulateAllPhotos = "corrupt";
    const pick = params.get("backup");
    if (pick && ["corrupt", "truncated", "schemaTooNew", "encrypted", "notBackup"].includes(pick)) this.nextPick = pick as PreviewPickKind;
    for (const id of options.missingAssets ?? []) this.simulatedPhotos.set(id, "missing");
    for (const id of options.corruptAssets ?? []) this.simulatedPhotos.set(id, "corrupt");
    if (!this.startupError) this.state = this.reload();
  }
  failNext(code: string, op: Operation): void { this.failures.set(op, code); }
  private check(op: Operation): void {
    if (this.startupError) throw copy(this.startupError);
    const code = this.failures.get(op);
    if (code) { this.failures.delete(op); fail(code); }
  }
  private reload(): MemoryState {
    let raw: string | null;
    try { raw = this.storage?.getItem(this.key) ?? null; }
    catch (error) { return fail("IO_ERROR", String(error)); }
    if (raw === null) return copy(this.state);
    try {
      const state = JSON.parse(raw) as MemoryState;
      if (state.schemaVersion !== undefined && (!Number.isInteger(state.schemaVersion) || state.schemaVersion < 1)) throw new Error("结构版本无效");
      if (state.schemaVersion > 4) return fail("SCHEMA_TOO_NEW", describeError({ code: "SCHEMA_TOO_NEW" }).detail);
      if (state.version !== 1 || !Number.isSafeInteger(state.seq) || state.seq < 0
        || !Array.isArray(state.records) || !state.assets || typeof state.assets !== "object" || Array.isArray(state.assets)) throw new Error("状态结构无效");
      const legacy = state.schemaVersion === undefined || Number(state.schemaVersion) === 1;
      if (legacy) {
        state.deletionMarkers = []; state.conflictCopies = [];
        for (const row of state.records) { row.status = "active"; row.trashedAt = null; }
      }
      migrateToV4(state);
      state.quarantine ??= {};
      if (state.deletedCreatedAt !== undefined && (typeof state.deletedCreatedAt !== "object" || state.deletedCreatedAt === null || Array.isArray(state.deletedCreatedAt))) throw new Error("删除记录信息无效");
      if (!Array.isArray(state.deletionMarkers) || !Array.isArray(state.conflictCopies)
        || !state.quarantine || typeof state.quarantine !== "object" || Array.isArray(state.quarantine)) throw new Error("安全状态结构无效");
      const ids = new Set<string>();
      for (const marker of state.deletionMarkers) {
        if (!marker || typeof marker.recordId !== "string" || typeof marker.deletedAt !== "string"
          || !Number.isInteger(marker.lastContentRevision) || marker.lastContentRevision < 0
          || Object.keys(marker).sort().join(",") !== "deletedAt,lastContentRevision,recordId" || ids.has(marker.recordId)) throw new Error("删除标记无效");
        ids.add(marker.recordId);
      }
      for (const row of state.records) {
        if (typeof row.recordId !== "string" || !Number.isInteger(row.contentRevision) || row.contentRevision < 0
          || !Number.isInteger(row.baseRevision) || row.baseRevision < 0
          || typeof row.createdAt !== "string" || typeof row.updatedAt !== "string"
          || !(row.committedAt === null || typeof row.committedAt === "string")
          || (row.draft === null && row.formal === null) || ids.has(row.recordId)
          || !["active", "trashed"].includes(row.status)
          || (row.status === "active" ? row.trashedAt !== null : typeof row.trashedAt !== "string" || row.formal === null)) throw new Error("记录结构无效");
        ids.add(row.recordId);
      }
      const conflictIds = new Set<string>();
      for (const c of state.conflictCopies) {
        if (!c || typeof c.conflictId !== "string" || conflictIds.has(c.conflictId)
          || typeof c.recordId !== "string" || !Number.isInteger(c.baseRevision) || c.baseRevision < 0
          || typeof c.createdAt !== "string" || typeof c.reason !== "string" || !c.snapshot) throw new Error("冲突副本无效");
        conflictIds.add(c.conflictId);
      }
      const snapshots = state.records.flatMap((r) => [r.draft, r.formal]).concat(state.conflictCopies.map((c) => c.snapshot));
      for (const snap of snapshots) {
        if (snap === null) continue;
        if (!snap || ![snap.title, snap.body, snap.eventDate].every((v) => typeof v === "string")
          || !(snap.eventTime === null || typeof snap.eventTime === "string") || !Array.isArray(snap.photos)) throw new Error("快照结构无效");
        for (const p of snap.photos) {
          if (![p.photoUseId, p.assetId, p.caption, p.mediaType].every((v) => typeof v === "string")
            || !/^[a-f0-9]{64}$/.test(p.sha256) || !Number.isSafeInteger(p.bytes) || p.bytes < 0) throw new Error("照片结构无效");
        }
        if (validateSnapshotDetails(snap)) throw new Error("快照扩展字段无效");
      }
      for (const asset of [...Object.values(state.assets), ...Object.values(state.quarantine)]) {
        if (!asset || typeof asset.dataUrl !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)
          || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0) throw new Error("原图结构无效");
      }
      tg.validateTagState(state);
      if (!state.settings || !["light", "dark", "system"].includes(state.settings.theme) || state.settings.appLock !== null) throw new Error("偏好状态无效");
      return state;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "SCHEMA_TOO_NEW") throw error;
      return fail("STATE_CORRUPT", `预览状态无法读取：${String(error)}`);
    }
  }
  private persist(next: MemoryState): void {
    try { this.storage?.setItem(this.key, JSON.stringify(next)); }
    catch (error) { fail("PERSIST_REPLACE_FAILED", String(error)); }
    this.state = next;
    this.lastMediaReport = null;
  }
  private row(state: MemoryState, id: string): RecordRow {
    return state.records.find((r) => r.recordId === id)
      ?? fail(state.deletionMarkers.some((m) => m.recordId === id) ? "RECORD_DELETED" : "NOT_FOUND");
  }
  private active(row: RecordRow): RecordRow {
    if (row.status === "trashed") fail("RECORD_TRASHED");
    return row;
  }
  private draft(row: RecordRow): Snapshot {
    this.active(row);
    if (row.draft === null) {
      row.draft = copy(row.formal ?? fail("NO_DRAFT"));
      row.baseRevision = row.contentRevision;
    }
    return row.draft;
  }
  private result(row: RecordRow): SaveResult { return { row: copy(row), durability: this.durabilityMode }; }
  private id(state: MemoryState, prefix: string): string { return `${prefix}-${String(++state.seq).padStart(6, "0")}`; }

  async storeStatus(): Promise<StoreStatus> {
    if (this.startupError) return { ok: false, ...copy(this.startupError) };
    this.check("storeStatus");
    try { this.reload(); return { ok: true }; }
    catch (error) {
      const value = error as { code: string; message: string };
      return { ok: false, code: value.code, message: value.message };
    }
  }
  async trashRecord(recordId: string): Promise<SaveResult> {
    this.check("trashRecord");
    const next = this.reload(), row = this.active(this.row(next, recordId));
    if (!row.formal) fail("RECORD_NOT_FORMAL");
    row.status = "trashed"; row.trashedAt = this.now();
    this.persist(next); return this.result(row);
  }
  async restoreRecord(recordId: string): Promise<SaveResult> {
    this.check("restoreRecord");
    const next = this.reload(), row = this.row(next, recordId);
    if (row.status !== "trashed") fail("RECORD_NOT_TRASHED");
    row.status = "active"; row.trashedAt = null;
    this.persist(next); return this.result(row);
  }
  async listTrash(): Promise<RecordRow[]> {
    this.check("listTrash");
    return copy(this.reload().records.filter((r) => r.status === "trashed").sort((a, b) =>
      b.trashedAt!.localeCompare(a.trashedAt!) || b.recordId.localeCompare(a.recordId)));
  }
  private purge(next: MemoryState, rows: RecordRow[]): PurgeResult {
    const ids = new Set(rows.map((r) => r.recordId)), deletedAt = this.now();
    const assets = new Set(rows.flatMap((r) => [r.formal, r.draft].flatMap((s) => s?.photos.map((p) => p.assetId) ?? [])));
    const deletionMarkers = rows.map((r) => ({ recordId: r.recordId, deletedAt, lastContentRevision: r.contentRevision }));
    next.records = next.records.filter((r) => !ids.has(r.recordId));
    next.deletionMarkers.push(...deletionMarkers);
    next.deletedCreatedAt ??= {};
    for (const r of rows) next.deletedCreatedAt[r.recordId] = r.createdAt;
    const quarantined = this.quarantineOrphans(next, assets);
    this.persist(next);
    for (const id of ids) this.pendingConflicts.delete(id);
    return { deletionMarkers: copy(deletionMarkers), quarantined, durability: this.durabilityMode };
  }
  async purgeRecord(recordId: string): Promise<PurgeResult> {
    this.check("purgeRecord");
    const next = this.reload(), row = this.row(next, recordId);
    if (row.status !== "trashed") fail("RECORD_NOT_TRASHED");
    return this.purge(next, [row]);
  }
  async emptyTrash(): Promise<PurgeResult> {
    this.check("emptyTrash");
    const next = this.reload(), rows = next.records.filter((r) => r.status === "trashed");
    if (!rows.length) return { deletionMarkers: [], quarantined: [], durability: this.durabilityMode };
    return this.purge(next, rows);
  }
  private sameSnapshot(a: Snapshot | null, b: Snapshot): boolean { return JSON.stringify(a) === JSON.stringify(b); }
  private addConflict(state: MemoryState, recordId: string, snapshot: Snapshot, baseRevision: number, reason: string): void {
    if (state.conflictCopies.some((c) => c.recordId === recordId && c.baseRevision === baseRevision && this.sameSnapshot(c.snapshot, snapshot))) return;
    state.conflictCopies.push({ conflictId: this.id(state, "conflict"), recordId, snapshot: copy(snapshot), baseRevision, createdAt: this.now(), reason });
  }
  async resolveConflict(recordId: string, choice: ConflictChoice): Promise<SaveResult> {
    this.check("resolveConflict");
    if (choice !== "keepMine" && choice !== "keepFormal") fail("INVALID_CONFLICT_CHOICE");
    const next = this.reload(), row = this.active(this.row(next, recordId));
    if (row.formal === null) fail("RECORD_NOT_FORMAL", "这条记录还没有正式版，不存在需要选择的冲突");
    const pending = this.pendingConflicts.get(recordId);
    const snapshot = pending?.snapshot ?? row.draft ?? fail("NO_DRAFT");
    const baseRevision = pending?.baseRevision ?? row.baseRevision;
    if (pending && row.draft && !this.sameSnapshot(row.draft, snapshot)) {
      this.addConflict(next, recordId, row.draft, row.baseRevision, choice === "keepMine" ? "resolve_keep_mine" : "resolve_keep_formal_occupied");
    }
    if (choice === "keepMine") row.draft = copy(snapshot);
    else { this.addConflict(next, recordId, snapshot, baseRevision, "resolve_keep_formal"); row.draft = null; }
    row.baseRevision = row.contentRevision;
    this.persist(next); this.pendingConflicts.delete(recordId); return this.result(row);
  }
  async listConflictCopies(): Promise<ConflictCopy[]> {
    this.check("listConflictCopies");
    return copy(this.reload().conflictCopies.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.conflictId.localeCompare(a.conflictId)));
  }
  async restoreConflictCopy(conflictId: string): Promise<SaveResult> {
    this.check("restoreConflictCopy");
    const next = this.reload(), conflict = next.conflictCopies.find((c) => c.conflictId === conflictId) ?? fail("CONFLICT_NOT_FOUND");
    const row = this.active(this.row(next, conflict.recordId));
    if (row.draft) fail("DRAFT_OCCUPIED");
    row.draft = copy(conflict.snapshot); row.baseRevision = row.contentRevision;
    next.conflictCopies = next.conflictCopies.filter((c) => c.conflictId !== conflictId);
    this.persist(next); this.pendingConflicts.delete(row.recordId); return this.result(row);
  }
  private references(state: MemoryState) {
    return state.records.flatMap((r) => [r.formal, r.draft].flatMap((s) =>
      s?.photos.map((p) => ({ recordId: r.recordId, photo: p })) ?? []))
      .concat(state.conflictCopies.flatMap((c) => c.snapshot.photos.map((p) => ({ recordId: c.recordId, photo: p }))));
  }
  private quarantineOrphans(next: MemoryState, candidates?: ReadonlySet<string>): QuarantinedMedia[] {
    const referenced = new Set(this.references(next).map((r) => r.photo.assetId));
    const quarantined: QuarantinedMedia[] = [], stamp = this.now().replace(/[-:.]/g, "").replace(/Z$/, "");
    for (const [assetId, asset] of Object.entries(next.assets)) {
      if (referenced.has(assetId) || (candidates && !candidates.has(assetId))) continue;
      const file = `media/${assetId}`, base = `media-quarantine/${stamp}/${assetId}`;
      let movedTo = base, suffix = 0;
      while (next.quarantine[movedTo]) movedTo = `${base}-${++suffix}`;
      // 原图内容完整保存在隔离区，没有自动清理入口。
      next.quarantine[movedTo] = asset; delete next.assets[assetId];
      quarantined.push({ assetId, file, movedTo });
    }
    return quarantined;
  }
  /** 浏览器截图可模拟原图状态；不改写照片内容和记录。 */
  setPhotoStatus(assetId: string, status: PhotoStatus): void {
    this.simulatedPhotos.set(assetId, status); this.lastMediaReport = null;
  }
  private assetStatus(state: MemoryState, assetId: string): PhotoStatus {
    const simulated = this.simulatedPhotos.get(assetId) ?? this.simulateAllPhotos;
    if (simulated !== "available") return simulated;
    const asset = state.assets[assetId];
    if (!asset) return "missing";
    for (const { photo } of this.references(state)) {
      if (photo.assetId === assetId && (photo.bytes !== asset.bytes || photo.sha256 !== asset.sha256)) return "corrupt";
    }
    return "available";
  }
  async photoStatus(assetId: string): Promise<PhotoStatus> {
    this.check("photoStatus"); return this.assetStatus(this.reload(), assetId);
  }
  async mediaReport(): Promise<MediaReport> {
    this.check("mediaReport");
    // 与桌面启动检查一致；缓存结果，避免重复请求丢失首次隔离清单。
    if (this.lastMediaReport) return copy(this.lastMediaReport);
    const next = this.reload(), report: MediaReport = { quarantined: this.quarantineOrphans(next), missing: [], corrupt: [], checkedAt: this.now() };
    const seen = new Set<string>();
    for (const { recordId, photo } of this.references(next)) {
      const key = `${recordId}:${photo.photoUseId}:${photo.assetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const status = this.assetStatus(next, photo.assetId);
      if (status !== "available") report[status].push({ recordId, photoUseId: photo.photoUseId, assetId: photo.assetId });
    }
    if (report.quarantined.length) this.persist(next);
    this.lastMediaReport = report; return copy(report);
  }

  async listDrafts(): Promise<RecordRow[]> {
    this.check("listDrafts");
    return copy(this.reload().records.filter((r) => r.status === "active" && r.draft !== null).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || b.recordId.localeCompare(a.recordId)));
  }
  async listFormalRecords(): Promise<RecordRow[]> {
    this.check("listFormalRecords");
    return copy(this.reload().records.filter((r) => r.status === "active" && r.formal !== null).sort((a, b) =>
      b.formal!.eventDate.localeCompare(a.formal!.eventDate)
      || (b.committedAt ?? "").localeCompare(a.committedAt ?? "") || b.recordId.localeCompare(a.recordId)));
  }
  async getRecord(recordId: string): Promise<RecordRow> {
    this.check("getRecord"); this.state = this.reload();
    return copy(this.row(this.state, recordId));
  }
  async createDraft(input: CreateDraftInput): Promise<SaveResult> {
    this.check("createDraft");
    const next = this.reload(), now = this.now();
    let row: RecordRow;
    if (input.baseRecordId) {
      row = this.active(this.row(next, input.baseRecordId));
      if (!row.formal) fail("BASE_NOT_FORMAL");
      this.draft(row); row.updatedAt = now;
    } else {
      row = { status: "active", trashedAt: null, recordId: this.id(next, "rec"), contentRevision: 0, baseRevision: 0, createdAt: now, updatedAt: now,
        committedAt: null, formal: null, draft: { ...blank(), title: input.title ?? "", body: input.body ?? "",
          eventDate: input.eventDate ?? "", eventTime: normalizeTime(input.eventTime), location: input.location ?? "", mood: input.mood ?? null },
        favorite: false, favoriteRevision: 0, tagIds: [], tagRevision: 0 };
      next.records.push(row);
      const issue = validateSnapshotDetails(row.draft!); if (issue) throw issue;
    }
    this.persist(next); return this.result(row);
  }
  async saveDraft(input: SaveDraftInput): Promise<SaveResult> {
    this.check("saveDraft");
    const next = this.reload(), row = this.active(this.row(next, input.recordId));
    if (input.eventDate !== undefined && input.eventDate.trim() && !isValidDate(input.eventDate)) fail("INVALID_EVENT_DATE");
    if (!input.clearEventTime && input.eventTime?.trim() && !isValidTime(input.eventTime)) fail("INVALID_EVENT_TIME");
    const draft = this.draft(row);
    for (const field of ["title", "body", "eventDate"] as const) {
      if (input[field] !== undefined) draft[field] = input[field];
    }
    if (input.clearEventTime || input.eventTime !== undefined) draft.eventTime = input.clearEventTime ? null : normalizeTime(input.eventTime);
    if (input.location !== undefined) draft.location = input.location;
    if (input.clearMood || input.mood !== undefined) draft.mood = input.clearMood ? null : input.mood!;
    const issue = validateSnapshotDetails(draft); if (issue) throw issue;
    row.updatedAt = this.now(); this.persist(next); return this.result(row);
  }
  async attachPhotoBytes(input: AttachPhotoBytesInput): Promise<SaveResult> {
    this.check("attachPhotoBytes");
    const next = this.reload(), row = this.active(this.row(next, input.recordId));
    if (!input.fileName || [".", ".."].includes(input.fileName) || /[/\\:\0]/.test(input.fileName)) fail("INVALID_ASSET_NAME");
    if (!input.bytes.length) fail("EMPTY_ASSET");
    if (input.bytes.length > 25 * 1024 * 1024) fail("ASSET_TOO_LARGE");
    for (const b of input.bytes) { if (!Number.isInteger(b) || b < 0 || b > 255) fail("INVALID_ASSET_BYTES"); }
    const draft = this.draft(row);
    const bytes = Uint8Array.from(input.bytes), hash = sha256(bytes), assetId = `ast-${hash.slice(0, 16)}`;
    const mediaType = input.mediaType?.trim() ? input.mediaType : sniffMediaType(input.fileName, bytes);
    const existing = next.assets[assetId];
    if (existing && existing.sha256 !== hash) fail("ASSET_CONFLICT");
    next.assets[assetId] ??= { dataUrl: `data:${mediaType};base64,${base64(bytes)}`, sha256: hash, bytes: bytes.length };
    draft.photos.push({ photoUseId: this.id(next, "pu"), assetId, caption: input.caption, sha256: hash, bytes: bytes.length, mediaType });
    draft.coverPhotoUseId ??= draft.photos[0]!.photoUseId;
    row.updatedAt = this.now(); this.persist(next); return this.result(row);
  }
  async removeDraftPhoto(recordId: string, photoUseId: string): Promise<SaveResult> {
    this.check("removeDraftPhoto");
    const next = this.reload(), row = this.active(this.row(next, recordId));
    const index = row.draft?.photos.findIndex((p) => p.photoUseId === photoUseId) ?? -1;
    if (index < 0) fail("PHOTO_USE_NOT_FOUND");
    row.draft!.photos.splice(index, 1); row.updatedAt = this.now();
    if (row.draft!.coverPhotoUseId === photoUseId) row.draft!.coverPhotoUseId = row.draft!.photos[0]?.photoUseId ?? null;
    this.persist(next); return this.result(row);
  }
  private editDraftPhotos(recordId: string, op: (draft: Snapshot) => void): SaveResult {
    const next = this.reload(), row = this.active(this.row(next, recordId)), draft = this.draft(row);
    op(draft);
    const issue = validateSnapshotDetails(draft); if (issue) throw issue;
    row.updatedAt = this.now(); this.persist(next); return this.result(row);
  }
  async setDraftPhotoCaption(recordId: string, photoUseId: string, caption: string): Promise<SaveResult> {
    this.check("setDraftPhotoCaption");
    return this.editDraftPhotos(recordId, (draft) => {
      if (typeof caption !== "string") fail("CAPTION_INVALID", "照片说明必须是纯文本");
      const photo = draft.photos.find((p) => p.photoUseId === photoUseId) ?? fail("PHOTO_USE_NOT_FOUND");
      photo.caption = caption;
    });
  }
  async setDraftCover(recordId: string, photoUseId: string): Promise<SaveResult> {
    this.check("setDraftCover");
    return this.editDraftPhotos(recordId, (draft) => { draft.coverPhotoUseId = photoUseId; });
  }
  async reorderDraftPhotos(recordId: string, photoUseIds: string[]): Promise<SaveResult> {
    this.check("reorderDraftPhotos");
    return this.editDraftPhotos(recordId, (draft) => {
      const byId = new Map(draft.photos.map((p) => [p.photoUseId, p]));
      if (photoUseIds.length !== byId.size || new Set(photoUseIds).size !== byId.size || photoUseIds.some((id) => !byId.has(id))) fail("PHOTO_ORDER_INVALID");
      draft.photos = photoUseIds.map((id) => byId.get(id)!);
    });
  }
  async discardDraft(recordId: string): Promise<DiscardResult> {
    this.check("discardDraft");
    const next = this.reload(), row = this.active(this.row(next, recordId));
    if (!row.formal) next.records = next.records.filter((r) => r.recordId !== recordId);
    else { row.draft = null; row.baseRevision = row.contentRevision; row.updatedAt = this.now(); }
    this.persist(next); return { row: row.formal ? copy(row) : null, durability: this.durabilityMode };
  }
  async commitRecord(recordId: string, expectedBaseRevision: number): Promise<CommitResult> {
    this.check("commitRecord");
    const next = this.reload(), row = this.active(this.row(next, recordId));
    const local = this.state.records.find((r) => r.recordId === recordId) ?? row, pending = this.pendingConflicts.get(recordId);
    const draft = copy(pending?.snapshot ?? local.draft ?? fail("NO_DRAFT"));
    const baseRevision = pending?.baseRevision ?? local.baseRevision;
    const issue = validateForCommit(draft); if (issue) throw issue;
    for (const photo of draft.photos) {
      const asset = next.assets[photo.assetId] ?? fail("ASSET_MISSING");
      if (asset.bytes !== photo.bytes) fail("ASSET_SIZE_MISMATCH");
      if (asset.sha256 !== photo.sha256) fail("ASSET_HASH_MISMATCH");
    }
    if (row.contentRevision !== expectedBaseRevision || baseRevision !== row.contentRevision) {
      this.pendingConflicts.set(recordId, { snapshot: draft, baseRevision });
      if (!row.draft) { row.draft = draft; row.baseRevision = baseRevision; this.persist(next); }
      else if (!this.sameSnapshot(row.draft, draft) && !this.sameSnapshot(row.formal, draft)) {
        const count = next.conflictCopies.length;
        this.addConflict(next, recordId, draft, baseRevision, "REVISION_CONFLICT");
        if (count !== next.conflictCopies.length) this.persist(next);
      }
      fail("REVISION_CONFLICT", "正式版已更新，本地草稿已保留");
    }
    row.contentRevision++; row.baseRevision = row.contentRevision; row.formal = draft; row.draft = null;
    row.updatedAt = row.committedAt = this.now(); this.persist(next);
    this.pendingConflicts.delete(recordId);
    return { recordId, contentRevision: row.contentRevision, committedAt: row.committedAt, durability: this.durabilityMode };
  }
  private thumbs = new Map<string, Promise<string>>();
  async photoThumbUrl(assetId: string): Promise<string> {
    this.check("photoThumbUrl");
    const state = this.reload();
    const status = this.assetStatus(state, assetId);
    if (status === "missing") fail("ASSET_MISSING", "原图缺失");
    if (status === "corrupt") fail("ASSET_HASH_MISMATCH", "原图校验失败");
    const asset = state.assets[assetId] ?? fail("ASSET_MISSING");
    if (/^data:image\/hei[cf]/.test(asset.dataUrl)) fail("HEIC_UNSUPPORTED", "无法预览 HEIC 图片");
    const cached = this.thumbs.get(assetId);
    if (cached) return cached;
    const pending = (async () => {
      if (typeof createImageBitmap === "undefined") fail("PREVIEW_UNSUPPORTED", "当前环境无法生成缩略图");
      const blob = await (await fetch(asset.dataUrl)).blob();
      // Some browsers cannot create ImageBitmap from SVG demo fixtures; Image.decode can.
      const bitmap = await createImageBitmap(blob).catch(async () => {
        const img = new Image();
        img.src = asset.dataUrl;
        await Promise.race([img.decode(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("图片解码超时")), 5000))]);
        return img;
      });
      try {
        const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d") ?? fail("PREVIEW_UNSUPPORTED");
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
      } finally { if ("close" in bitmap) bitmap.close(); }
    })();
    this.thumbs.set(assetId, pending);
    try { return await pending; } catch (error) { this.thumbs.delete(assetId); throw error; }
  }
  async photoDataUrl(assetId: string): Promise<string> {
    this.check("photoDataUrl");
    const status = this.assetStatus(this.reload(), assetId);
    if (status === "missing") fail("ASSET_MISSING", "原图缺失");
    if (status === "corrupt") fail("ASSET_HASH_MISMATCH", "原图校验失败");
    const asset = this.reload().assets[assetId] ?? fail("ASSET_MISSING");
    if (asset.bytes > 8 * 1024 * 1024) fail("PREVIEW_TOO_LARGE");
    return asset.dataUrl;
  }
  async exportManifest(outPath: string): Promise<{ out: string; records: number }> {
    this.check("exportManifest");
    // 预览环境没有文件系统，明确报告无法导出，避免假装写入成功。
    return fail("IO_ERROR", `浏览器预览无法写入文件：${outPath}`);
  }

  // ---- Unit-0.5/0.6 备份/恢复/合并（预览：同语义的内存实现，供截图与 TS 测试）----
  // 注意：预览里的“加密”只是用口令派生的校验值门禁 + 混淆，用来演示交互；真实加密在 Rust core（Argon2id + XChaCha20-Poly1305）。
  /** 预览中模拟“用户选中的文件”。默认选最近一次导出的包。 */
  setNextPickedBackup(kind: PreviewPickKind): void { this.nextPick = kind; }
  /** 预览/测试用：直接把一个包设为“下一次选中的文件”。 */
  setNextPickedPackage(pkg: PreviewBackup): void { this.injected = copy(pkg); }
  lastExportedPackage(): PreviewBackup | null { return this.lastExport ? copy(this.lastExport) : null; }
  private counts(state: MemoryState): BackupCounts {
    const referenced = new Set(this.references(state).map((r) => r.photo.assetId));
    const present = [...referenced].filter((id) => state.assets[id]);
    const favorites = state.records.filter((r) => r.favorite && r.formal !== null).length;
    return {
      formal: state.records.filter((r) => r.status === "active" && r.formal !== null).length,
      drafts: state.records.filter((r) => r.draft !== null).length,
      trashed: state.records.filter((r) => r.status === "trashed").length,
      deletionMarkers: state.deletionMarkers.length,
      conflictCopies: state.conflictCopies.length,
      mediaFiles: present.length,
      missingMedia: referenced.size - present.length,
      // Unit-0.7：为 0 时省略（与旧包摘要形状一致；缺省即 0）。
      ...(state.tags.length > 0 ? { tags: state.tags.length } : {}),
      ...(favorites > 0 ? { favorites } : {}),
    };
  }
  private packBackup(state: MemoryState, overrides: Record<string, unknown> = {}, password?: string): PreviewBackup {
    const referenced = new Set(this.references(state).map((r) => r.photo.assetId));
    const assets: Record<string, MemoryAsset> = {};
    for (const id of referenced) if (state.assets[id]) assets[id] = state.assets[id]!;
    const packed = { ...copy(state), settings: { ...state.settings, appLock: null }, assets, quarantine: {} };
    const manifest = {
      format: "shiguang-backup", formatVersion: 1, schemaVersion: 4, appVersion: "preview",
      exportedAt: this.now(), encryption: { mode: "none" }, compression: "none", counts: this.counts(state), ...overrides,
    };
    let body = JSON.stringify({ manifest, state: packed });
    let lock: PreviewBackup["lock"];
    if (password) {
      const salt = sha256(encoder.encode(`${this.now()}:${Math.random()}`)).slice(0, 32);
      lock = { salt, check: sha256(encoder.encode(`${salt}\u0000${password}`)) };
      body = xorText(body, sha256(encoder.encode(`${password}\u0001${salt}`)));
    }
    const bytes = encoder.encode(body);
    return { magic: "SGBAK-PREVIEW", body, sha256: sha256(bytes), bytes: bytes.length, lock };
  }
  private verifyPreview(pkg: PreviewBackup, password?: string): { summary: BackupSummary; state: MemoryState } {
    if (!pkg || pkg.magic !== "SGBAK-PREVIEW" || typeof pkg.body !== "string") fail("BACKUP_INVALID", "这不是拾光备份文件，或文件已损坏");
    const bytes = encoder.encode(pkg.body);
    if (bytes.length !== pkg.bytes) fail("BACKUP_TRUNCATED", "备份文件不完整（可能拷贝中断）");
    let body = pkg.body;
    if (pkg.lock) {
      if (!password) fail("BACKUP_PASSWORD_REQUIRED", "这是加密备份，请输入口令");
      if (sha256(encoder.encode(`${pkg.lock.salt}\u0000${password}`)) !== pkg.lock.check) fail("BACKUP_PASSWORD_WRONG", "口令不正确，或文件已损坏");
      if (sha256(bytes) !== pkg.sha256) fail("BACKUP_CORRUPT", "备份文件内容被修改或损坏");
      body = xorText(body, sha256(encoder.encode(`${password}\u0001${pkg.lock.salt}`)));
    } else if (sha256(bytes) !== pkg.sha256) fail("BACKUP_CORRUPT", "备份文件内容被修改或损坏");
    let parsed: { manifest: Record<string, unknown> & { counts: BackupCounts; encryption: { mode: string } }; state: MemoryState };
    try { parsed = JSON.parse(body); } catch { return fail("BACKUP_CORRUPT", "备份清单无法解析"); }
    const m = parsed.manifest;
    if (m.format !== "shiguang-backup") fail("BACKUP_INVALID", "这不是拾光备份文件");
    if (Number(m.formatVersion) > 1) fail("BACKUP_FORMAT_TOO_NEW", "备份格式来自更新版本的拾光");
    if (m.encryption?.mode !== "none") fail("BACKUP_ENCRYPTED_UNSUPPORTED", "未知的加密方式");
    if (Number(m.schemaVersion) > 4) fail("BACKUP_SCHEMA_TOO_NEW", "备份来自更新版本的拾光，请先升级");
    const summary: BackupSummary = {
      formatVersion: Number(m.formatVersion), schemaVersion: Number(m.schemaVersion), appVersion: String(m.appVersion),
      exportedAt: String(m.exportedAt), bytes: pkg.bytes, encryption: pkg.lock ? "argon2id-xchacha20poly1305" : "none", counts: m.counts,
    };
    let state: MemoryState;
    try {
      if (parsed.state.schemaVersion !== m.schemaVersion) fail("BACKUP_CORRUPT");
      state = migrateToV4(parsed.state);
      tg.validateTagState(state);
      for (const snap of state.records.flatMap((r) => [r.formal, r.draft]).concat(state.conflictCopies.map((c) => c.snapshot))) {
        if (snap && validateSnapshotDetails(snap)) fail("BACKUP_CORRUPT");
      }
      if (!state.settings || !["light", "dark", "system"].includes(state.settings.theme)) fail("BACKUP_CORRUPT");
    } catch { return fail("BACKUP_CORRUPT", "备份中的状态数据无效"); }
    return { summary, state };
  }
  async backupCapabilities(): Promise<BackupCapabilities> {
    return { platform: "preview", overwriteRestore: true, merge: true, encryption: true, antiResurrection: true, fileAccess: "preview" };
  }
  async exportBackup(options: ExportBackupOptions = {}): Promise<ExportBackupResult> {
    this.check("exportBackup");
    if (options.password !== undefined && options.password.length === 0) fail("BACKUP_PASSWORD_EMPTY", "请设置口令，或不勾选加密");
    const state = this.reload(), pkg = this.packBackup(state, {}, options.password);
    // 导出只读：不改动当前状态与存储。
    this.lastExport = pkg;
    const { summary } = this.verifyPreview(pkg, options.password);
    const referenced = new Set(this.references(state).map((r) => r.photo.assetId));
    const missingMedia = [...referenced].filter((id) => !state.assets[id] || this.assetStatus(state, id) === "missing").sort();
    const stamp = this.now().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-").replace(/Z$/, "");
    return { cancelled: false, fileName: `拾光备份-${stamp}${pkg.lock ? "-加密" : ""}.sgbak`, location: "浏览器预览（内存，未写入文件）", sha256: pkg.sha256, summary, missingMedia };
  }
  async pickBackup(): Promise<PickBackupResult> {
    this.check("pickBackup");
    let pkg: PreviewBackup | null = this.injected ?? (this.lastExport ? copy(this.lastExport) : null);
    this.injected = null;
    const base = () => pkg ?? this.packBackup(this.reload());
    switch (this.nextPick) {
      case "lastExport": break;
      case "corrupt": { const b = base(); pkg = { ...b, body: b.body.replace("合成", "篡改") }; if (pkg.body === b.body) pkg.sha256 = "0".repeat(64); break; }
      case "truncated": { const b = base(); pkg = { ...b, body: b.body.slice(0, Math.floor(b.body.length / 2)) }; break; }
      case "schemaTooNew": pkg = this.packBackup(this.reload(), { schemaVersion: 99 }); break;
      case "encrypted": pkg = this.packBackup(this.reload(), { encryption: { mode: "aead-preview" } }); break;
      case "notBackup": pkg = { magic: "PNG" as "SGBAK-PREVIEW", body: "", sha256: "", bytes: 0 }; break;
    }
    if (!pkg) return { cancelled: true };
    const token = `pick-${++this.pickSeq}`;
    if (pkg.lock) {
      if (encoder.encode(pkg.body).length !== pkg.bytes) fail("BACKUP_TRUNCATED", "备份文件不完整（可能拷贝中断）");
      this.picked.set(token, { pkg, state: null });
      return { cancelled: false, token, fileName: "拾光备份-预览-加密.sgbak", encrypted: true, summary: null };
    }
    const { summary, state } = this.verifyPreview(pkg);
    this.picked.set(token, { pkg, state });
    return { cancelled: false, token, fileName: "拾光备份-预览.sgbak", encrypted: false, summary };
  }
  async unlockBackup(token: string, password: string): Promise<{ summary: BackupSummary }> {
    this.check("unlockBackup");
    const entry = this.picked.get(token) ?? fail("BACKUP_TOKEN_INVALID", "请重新选择备份文件");
    const { summary, state } = this.verifyPreview(entry.pkg, password);
    entry.state = state;
    return { summary };
  }
  private pickedState(token: string): MemoryState {
    const entry = this.picked.get(token) ?? fail("BACKUP_TOKEN_INVALID", "请重新选择备份文件");
    return entry.state ?? fail("BACKUP_PASSWORD_REQUIRED", "这是加密备份，请先输入口令");
  }
  async restoreBackup(token: string): Promise<RestoreBackupResult> {
    this.check("restoreBackup");
    const incoming = this.pickedState(token);
    const current = this.reload();
    const stamp = this.now().replace(/[-:.]/g, "");
    const safetyKey = `${this.key}.pre-restore.${stamp}`;
    // 先留安全副本；写入失败则整体中止，当前数据不变。
    try { this.storage?.setItem(safetyKey, JSON.stringify(current)); }
    catch (error) { fail("RESTORE_SAFETY_BACKUP_FAILED", String(error)); }
    const next: MemoryState = { ...copy(incoming), settings: { ...incoming.settings, appLock: current.settings.appLock }, quarantine: copy(current.quarantine) };
    this.persist(next);
    this.picked.delete(token);
    const mediaReport = await this.mediaReport();
    return { restored: this.counts(next), safetyBackup: `backups/pre-restore-${stamp}`, mediaReport, durability: this.durabilityMode };
  }
  async planMerge(token: string): Promise<MergePlan> {
    this.check("planMerge");
    return mergeStates(this.reload(), this.pickedState(token), this.now()).plan;
  }
  async mergeBackup(token: string): Promise<MergeResult> {
    this.check("mergeBackup");
    const current = this.reload();
    const { state: next, plan } = mergeStates(current, this.pickedState(token), this.now());
    const stamp = this.now().replace(/[-:.]/g, "");
    try { this.storage?.setItem(`${this.key}.pre-merge.${stamp}`, JSON.stringify(current)); }
    catch (error) { fail("RESTORE_SAFETY_BACKUP_FAILED", String(error)); }
    this.persist(next);
    this.picked.delete(token);
    const mediaReport = await this.mediaReport();
    return { plan, safetyBackup: `backups/pre-merge-${stamp}`, mediaReport, durability: this.durabilityMode };
  }
  async discardPickedBackup(token: string): Promise<void> { this.picked.delete(token); }

  // ---- Unit-0.7：珍藏 / 标签（独立元数据，不触碰草稿与正文修订；CAS） ----
  /** “今天”（本地日期）；预览测试可注入。 */
  today: () => string = () => tl.localToday();
  private metaRow(next: MemoryState, recordId: string, requireFormal = true): RecordRow {
    const row = this.row(next, recordId);
    if (row.status === "trashed") fail("RECORD_TRASHED", "记录在回收站中，请先恢复");
    if (requireFormal && row.formal === null) fail("RECORD_NOT_FORMAL", "草稿还没有存入时光，暂不能珍藏");
    return row;
  }
  private meta(row: RecordRow): MetaResult {
    return { recordId: row.recordId, favorite: row.favorite, favoriteRevision: row.favoriteRevision, tagIds: [...row.tagIds], tagRevision: row.tagRevision, durability: this.durabilityMode };
  }
  async setFavorite(recordId: string, favorite: boolean, expectedRevision?: number | null): Promise<MetaResult> {
    this.check("setFavorite");
    const next = this.reload(), row = this.metaRow(next, recordId);
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== row.favoriteRevision) {
      fail("META_REVISION_CONFLICT", "珍藏状态已在别处改变，请刷新后重试");
    }
    if (row.favorite === favorite) return this.meta(row);
    row.favorite = favorite; row.favoriteRevision += 1;
    this.persist(next); return this.meta(row);
  }
  async setRecordTags(recordId: string, tagIds: string[], expectedRevision?: number | null): Promise<MetaResult> {
    this.check("setRecordTags");
    const next = this.reload(), row = this.metaRow(next, recordId, false);
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== row.tagRevision) {
      fail("META_REVISION_CONFLICT", "标签已在别处改变，请刷新后重试");
    }
    const wanted: string[] = [];
    for (const id of tagIds) { tg.findTag(next, id); if (!wanted.includes(id)) wanted.push(id); }
    if (sameJson([...wanted].sort(), [...row.tagIds].sort())) return this.meta(row);
    row.tagIds = wanted; row.tagRevision += 1;
    this.persist(next); return this.meta(row);
  }
  private tagInfo(state: MemoryState, tagId: string): TagInfo {
    return tg.listTags(state).find((t) => t.tagId === tagId) ?? fail("TAG_NOT_FOUND", "标签不存在");
  }
  async listTags(): Promise<TagInfo[]> { this.check("listTags"); return tg.listTags(this.reload()); }
  async createTag(name: string): Promise<TagInfo> {
    this.check("createTag");
    const next = this.reload(), tag = tg.createTag(next, name, this.now());
    this.persist(next); return this.tagInfo(next, tag.tagId);
  }
  async renameTag(tagId: string, name: string): Promise<TagInfo> {
    this.check("renameTag");
    const next = this.reload(), before = next.tagDictRevision;
    tg.renameTag(next, tagId, name);
    if (next.tagDictRevision !== before) this.persist(next);
    return this.tagInfo(next, tagId);
  }
  async mergeTags(fromTagId: string, intoTagId: string): Promise<TagMergeResult> {
    this.check("mergeTags");
    const next = this.reload(), affectedRecords = tg.mergeTags(next, fromTagId, intoTagId, this.now());
    tg.validateTagState(next);
    this.persist(next);
    return { into: this.tagInfo(next, intoTagId), affectedRecords, durability: this.durabilityMode };
  }
  async deleteTag(tagId: string): Promise<TagDeleteResult> {
    this.check("deleteTag");
    const next = this.reload(), affectedRecords = tg.deleteTag(next, tagId, this.now());
    tg.validateTagState(next);
    this.persist(next);
    return { affectedRecords, durability: this.durabilityMode };
  }
  async tagImpact(tagId: string): Promise<TagImpact> { this.check("tagImpact"); return tg.tagImpact(this.reload(), tagId); }
  // ---- Unit-0.7：时光轴 / 日历 / 那年今日（只读衍生视图） ----
  async timelinePage(filter: TimelineFilter, cursor: string | null, limit: number): Promise<TimelinePage> {
    this.check("timelinePage"); return tl.timelinePage(this.reload().records, filter, cursor, limit, this.today());
  }
  async timelineMonths(filter: TimelineFilter): Promise<MonthCount[]> {
    this.check("timelineMonths"); return tl.timelineMonths(this.reload().records, filter);
  }
  async calendarMonth(year: number, month: number, filter: TimelineFilter = {}): Promise<CalendarDay[]> {
    this.check("calendarMonth"); return tl.calendarMonth(this.reload().records, year, month, filter);
  }
  async dayEntries(date: string, order: SortOrder = "desc"): Promise<TimelineItem[]> {
    this.check("dayEntries");
    if (!isValidDate(date)) fail("INVALID_EVENT_DATE", "日期无效");
    return tl.dayEntries(this.reload().records, date, order, this.today());
  }
  async onThisDay(month: number, day: number, today?: string): Promise<OnThisDayGroup[]> {
    this.check("onThisDay"); return tl.onThisDay(this.reload().records, month, day, today ?? this.today());
  }
}

function xorText(text: string, keyHex: string): string {
  // 仅预览混淆（不是加密）：按 UTF-16 码元与口令派生值异或，保证无口令时看不出原文。
  let out = "";
  for (let i = 0; i < text.length; i++) out += String.fromCharCode(text.charCodeAt(i) ^ (keyHex.charCodeAt(i % keyHex.length) & 0x1f));
  return out;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** 比较快照内容时忽略 photoUseId（合并撞号时会被改号）。 */
const comparableContent = (s: Snapshot | null) => s && ({ ...s, coverPhotoUseId: s.photos.findIndex((p) => p.photoUseId === s.coverPhotoUseId), photos: s.photos.map(({ photoUseId: _u, ...rest }) => rest) });
const sameContent = (a: Snapshot | null, b: Snapshot | null) => sameJson(comparableContent(a), comparableContent(b));

/** 与 Rust core merge_states 同语义的预览实现（身份 = recordId + createdAt；时间戳不参与胜负）。 */
export function mergeStates(local: MemoryState, incoming: MemoryState, now: string): { state: MemoryState; plan: MergePlan } {
  const next = copy(local);
  next.deletedCreatedAt ??= {};
  next.mergeOrigins ??= {};
  const counts: MergeCounts = { added: 0, updated: 0, unchanged: 0, conflicts: 0, keptTrashed: 0, keptActive: 0, skippedDeleted: 0,
    deletedInBackup: 0, markersAdded: 0, conflictCopiesAdded: 0, conflictCopiesDropped: 0, mediaAdded: 0, mediaMissing: 0, mediaConflicts: 0 };
  const skippedDeleted: string[] = [], deletedInBackup: string[] = [];
  const usedIds = new Set<string>([...next.records.map((r) => r.recordId), ...next.deletionMarkers.map((m) => m.recordId)]);
  const usedConflict = new Set(next.conflictCopies.map((c) => c.conflictId));
  const usedPhotoUse = new Set<string>();
  for (const r of next.records) for (const s of [r.formal, r.draft]) for (const p of s?.photos ?? []) usedPhotoUse.add(p.photoUseId);
  for (const c of next.conflictCopies) for (const p of c.snapshot.photos) usedPhotoUse.add(p.photoUseId);
  const maxSeq = (ids: Iterable<string>) => Math.max(0, ...[...ids].map((id) => Number(/-(\d+)$/.exec(id)?.[1] ?? 0)));
  next.seq = Math.max(next.seq, incoming.seq);
  const alloc = (prefix: string) => `${prefix}-${String(++next.seq).padStart(6, "0")}`;
  const idMap = new Map<string, string>();
  const remapPhotos = (snap: Snapshot): Snapshot => {
    const mapping = new Map<string, string>();
    const photos = snap.photos.map((p) => {
      let id = p.photoUseId;
      if (usedPhotoUse.has(id)) id = alloc("pu");
      usedPhotoUse.add(id); mapping.set(p.photoUseId, id); return { ...p, photoUseId: id };
    });
    return { ...snap, photos, coverPhotoUseId: snap.coverPhotoUseId === null ? null : mapping.get(snap.coverPhotoUseId)! };
  };
  const addCopy = (recordId: string, snapshot: Snapshot, baseRevision: number, reason: string) => {
    const exists = next.conflictCopies.some((c) => c.recordId === recordId && sameContent(c.snapshot, snapshot));
    if (exists) return;
    let conflictId = alloc("cc"); while (usedConflict.has(conflictId)) conflictId = alloc("cc");
    usedConflict.add(conflictId);
    next.conflictCopies.push({ conflictId, recordId, baseRevision, snapshot: remapPhotos(snapshot), createdAt: now, reason });
    counts.conflictCopiesAdded++;
  };
  const markerMatches = (recordId: string, createdAt: string) => next.deletionMarkers.some((m) => m.recordId === recordId
    && (next.deletedCreatedAt?.[recordId] === undefined || next.deletedCreatedAt[recordId] === createdAt));
  migrateToV4(next); migrateToV4(incoming);
  const tagCounts = { tagsAdded: 0, tagsRemapped: 0, tagsSkippedDeleted: 0, tagsDeletedInBackup: 0 };
  const tagMap = tg.mergeTagDictionaries(next, incoming, tagCounts);
  let favoritesUpdated = 0, tagLinksUpdated = 0;
  const mergeMeta = (local: RecordRow, r: RecordRow) => {
    if (r.favoriteRevision > local.favoriteRevision) {
      if (r.favorite !== local.favorite) favoritesUpdated++;
      local.favorite = r.favorite; local.favoriteRevision = r.favoriteRevision;
    }
    const mapped = tg.mapTagIds(r.tagIds, tagMap);
    if (r.tagRevision > local.tagRevision) {
      if (!sameJson([...mapped].sort(), [...local.tagIds].sort())) tagLinksUpdated++;
      local.tagIds = mapped; local.tagRevision = r.tagRevision;
    }
  };
  for (const r of incoming.records) {
    if (markerMatches(r.recordId, r.createdAt)) { counts.skippedDeleted++; skippedDeleted.push(r.recordId); continue; }
    const originKey = r.recordId + "\u0000" + r.createdAt;
    const mapped = next.mergeOrigins[originKey];
    const local = next.records.find((l) => l.recordId === (mapped ?? r.recordId) && l.createdAt === r.createdAt)
      ?? next.records.find((l) => l.recordId === r.recordId);
    if (mapped !== undefined && !local) { counts.skippedDeleted++; skippedDeleted.push(mapped); continue; }
    if (!local || local.createdAt !== r.createdAt) {
      const row = copy(r);
      if (usedIds.has(row.recordId)) { row.recordId = alloc("rec"); next.mergeOrigins[originKey] = row.recordId; }
      idMap.set(r.recordId + "\u0000" + r.createdAt, row.recordId);
      usedIds.add(row.recordId);
      row.formal = row.formal && remapPhotos(row.formal); row.draft = row.draft && remapPhotos(row.draft);
      row.tagIds = tg.mapTagIds(row.tagIds, tagMap);
      next.records.push(row); counts.added++;
      continue;
    }
    idMap.set(r.recordId + "\u0000" + r.createdAt, local.recordId);
    mergeMeta(local, r);
    if (local.status === "trashed" && r.status === "active") counts.keptTrashed++;
    if (local.status === "active" && r.status === "trashed") counts.keptActive++;
    if (r.formal && local.formal && !sameContent(r.formal, local.formal)) {
      if (r.contentRevision > local.contentRevision && local.status === "active") {
        addCopy(local.recordId, local.formal, local.contentRevision, "merge-replaced-local");
        local.formal = remapPhotos(r.formal); local.contentRevision = r.contentRevision; local.committedAt = r.committedAt; counts.updated++;
      } else { addCopy(local.recordId, r.formal, r.contentRevision, "merge-incoming"); counts.conflicts++; }
    } else if (r.formal && !local.formal && local.status === "active") {
      local.formal = remapPhotos(r.formal); local.contentRevision = Math.max(local.contentRevision, r.contentRevision); counts.updated++;
    } else {
      local.contentRevision = Math.max(local.contentRevision, r.contentRevision); counts.unchanged++;
    }
    if (r.draft) {
      if (local.draft) { if (!sameContent(local.draft, r.draft)) addCopy(local.recordId, r.draft, r.baseRevision, "merge-incoming-draft"); }
      else if (local.status === "active" && r.baseRevision >= local.contentRevision) { local.draft = remapPhotos(r.draft); local.baseRevision = local.contentRevision; }
      else addCopy(local.recordId, r.draft, r.baseRevision, "merge-incoming-draft");
    }
  }
  for (const m of incoming.deletionMarkers) {
    const createdAt = incoming.deletedCreatedAt?.[m.recordId];
    const local = next.records.find((l) => l.recordId === m.recordId && (createdAt === undefined || l.createdAt === createdAt));
    if (local) { counts.deletedInBackup++; deletedInBackup.push(local.recordId); continue; }
    if (next.deletionMarkers.some((x) => x.recordId === m.recordId)) continue;
    if (next.records.some((l) => l.recordId === m.recordId)) continue; // 同号不同记录：不能写入会误伤本机的标记
    next.deletionMarkers.push(copy(m));
    if (createdAt !== undefined) next.deletedCreatedAt[m.recordId] = createdAt;
    counts.markersAdded++;
  }
  for (const c of incoming.conflictCopies) {
    const target = [...idMap.entries()].find(([k]) => k.startsWith(c.recordId + "\u0000"))?.[1];
    if (!target) continue;
    addCopy(target, c.snapshot, c.baseRevision, c.reason);
  }
  const needed = new Set<string>();
  for (const r of next.records) for (const s of [r.formal, r.draft]) for (const p of s?.photos ?? []) needed.add(p.assetId);
  for (const c of next.conflictCopies) for (const p of c.snapshot.photos) needed.add(p.assetId);
  for (const id of needed) {
    if (next.assets[id]) { if (incoming.assets[id] && incoming.assets[id]!.sha256 !== next.assets[id]!.sha256) counts.mediaConflicts++; continue; }
    if (incoming.assets[id]) { next.assets[id] = copy(incoming.assets[id]!); counts.mediaAdded++; }
    else if (!local.assets[id]) counts.mediaMissing++;
  }
  next.seq = Math.max(next.seq, maxSeq(usedIds), maxSeq(usedConflict), maxSeq(usedPhotoUse));
  Object.assign(counts, tagCounts, { favoritesUpdated, tagLinksUpdated });
  tg.validateTagState(next);
  return { state: next, plan: { counts, skippedDeleted, deletedInBackup } };
}

export function createMemoryApi(options: ConstructorParameters<typeof MemoryAdapter>[0] = {}): MemoryAdapter {
  return new MemoryAdapter(options);
}
