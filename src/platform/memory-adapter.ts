import type { CommitResult, DeletionMarker, Durability, RecordRow, Snapshot, ConflictChoice, ConflictCopy, MediaReport, PhotoStatus, PurgeResult, QuarantinedMedia, StoreStatus, BackupCapabilities, BackupCounts, BackupSummary, ExportBackupResult, PickBackupResult, RestoreBackupResult } from "../domain/types.ts";
import { describeError } from "../domain/errors.ts";
import { isValidDate, isValidTime, validateForCommit } from "../domain/rules.ts";
import type { AttachPhotoBytesInput, CreateDraftInput, DiscardResult, SaveDraftInput, SaveResult, ShiguangApi } from "./api.ts";
import { base64, sha256, sniffMediaType } from "./bytes.ts";

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
interface MemoryAsset { dataUrl: string; sha256: string; bytes: number }
interface MemoryState {
  version: 1;
  schemaVersion: 2;
  seq: number;
  records: RecordRow[];
  assets: Record<string, MemoryAsset>;
  deletionMarkers: DeletionMarker[];
  conflictCopies: ConflictCopy[];
  quarantine: Record<string, MemoryAsset>;
}
type Operation = keyof ShiguangApi;
/** 浏览器预览的备份包：manifest + 完整状态 + 整包哈希（模拟 .sgbak 的校验语义，不是真实文件）。 */
interface PreviewBackup { magic: "SGBAK-PREVIEW"; body: string; sha256: string; bytes: number }
export type PreviewPickKind = "lastExport" | "corrupt" | "truncated" | "schemaTooNew" | "encrypted" | "notBackup";
const encoder = new TextEncoder();
const copy = <T>(value: T): T => structuredClone(value);
const fail = (code: string, message = code): never => { throw { code, message }; };
const blank = (): Snapshot => ({ title: "", body: "", eventDate: "", eventTime: null, photos: [] });
const normalizeTime = (value: string | null | undefined) => value?.trim() || null;

/** 仅供浏览器合成数据预览；storage 由调用方注入。 */
export class MemoryAdapter implements ShiguangApi {
  durabilityMode: Durability = "durable";
  private state: MemoryState = { version: 1, schemaVersion: 2, seq: 0, records: [], assets: {}, deletionMarkers: [], conflictCopies: [], quarantine: {} };
  private failures = new Map<Operation, string>();
  private pendingConflicts = new Map<string, { snapshot: Snapshot; baseRevision: number }>();
  private simulatedPhotos = new Map<string, PhotoStatus>();
  private simulateAllPhotos: PhotoStatus = "available";
  private startupError?: { code: string; message: string };
  private lastMediaReport: MediaReport | null = null;
  private storage?: StorageLike;
  private lastExport: PreviewBackup | null = null;
  private picked = new Map<string, MemoryState>();
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
      if (state.schemaVersion > 2) return fail("SCHEMA_TOO_NEW", describeError({ code: "SCHEMA_TOO_NEW" }).detail);
      if (state.version !== 1 || !Number.isSafeInteger(state.seq) || state.seq < 0
        || !Array.isArray(state.records) || !state.assets || typeof state.assets !== "object" || Array.isArray(state.assets)) throw new Error("状态结构无效");
      const legacy = state.schemaVersion === undefined || Number(state.schemaVersion) === 1;
      if (legacy) {
        state.deletionMarkers = []; state.conflictCopies = [];
        for (const row of state.records) { row.status = "active"; row.trashedAt = null; }
      }
      state.schemaVersion = 2;
      state.quarantine ??= {};
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
      }
      for (const asset of [...Object.values(state.assets), ...Object.values(state.quarantine)]) {
        if (!asset || typeof asset.dataUrl !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)
          || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0) throw new Error("原图结构无效");
      }
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
          eventDate: input.eventDate ?? "", eventTime: normalizeTime(input.eventTime) } };
      next.records.push(row);
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
    row.updatedAt = this.now(); this.persist(next); return this.result(row);
  }
  async removeDraftPhoto(recordId: string, photoUseId: string): Promise<SaveResult> {
    this.check("removeDraftPhoto");
    const next = this.reload(), row = this.active(this.row(next, recordId));
    const index = row.draft?.photos.findIndex((p) => p.photoUseId === photoUseId) ?? -1;
    if (index < 0) fail("PHOTO_USE_NOT_FOUND");
    row.draft!.photos.splice(index, 1); row.updatedAt = this.now();
    this.persist(next); return this.result(row);
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

  // ---- Unit-0.5 备份/恢复（预览：同语义的内存实现，供截图与 TS 测试）----
  /** 预览中模拟“用户选中的文件”。默认选最近一次导出的包。 */
  setNextPickedBackup(kind: PreviewPickKind): void { this.nextPick = kind; }
  private counts(state: MemoryState): BackupCounts {
    const referenced = new Set(this.references(state).map((r) => r.photo.assetId));
    const present = [...referenced].filter((id) => state.assets[id]);
    return {
      formal: state.records.filter((r) => r.status === "active" && r.formal !== null).length,
      drafts: state.records.filter((r) => r.draft !== null).length,
      trashed: state.records.filter((r) => r.status === "trashed").length,
      deletionMarkers: state.deletionMarkers.length,
      conflictCopies: state.conflictCopies.length,
      mediaFiles: present.length,
      missingMedia: referenced.size - present.length,
    };
  }
  private packBackup(state: MemoryState, overrides: Partial<BackupSummary> = {}): PreviewBackup {
    const referenced = new Set(this.references(state).map((r) => r.photo.assetId));
    const assets: Record<string, MemoryAsset> = {};
    for (const id of referenced) if (state.assets[id]) assets[id] = state.assets[id]!;
    const packed = { ...copy(state), assets, quarantine: {} };
    const manifest = {
      format: "shiguang-backup", formatVersion: 1, schemaVersion: 2, appVersion: "preview",
      exportedAt: this.now(), encryption: { mode: "none" }, compression: "none", counts: this.counts(state), ...overrides,
    };
    const body = JSON.stringify({ manifest, state: packed });
    const bytes = encoder.encode(body);
    return { magic: "SGBAK-PREVIEW", body, sha256: sha256(bytes), bytes: bytes.length };
  }
  private verifyPreview(pkg: PreviewBackup): { summary: BackupSummary; state: MemoryState } {
    if (!pkg || pkg.magic !== "SGBAK-PREVIEW" || typeof pkg.body !== "string") fail("BACKUP_INVALID", "这不是拾光备份文件，或文件已损坏");
    const bytes = encoder.encode(pkg.body);
    if (bytes.length !== pkg.bytes) fail("BACKUP_TRUNCATED", "备份文件不完整（可能拷贝中断）");
    if (sha256(bytes) !== pkg.sha256) fail("BACKUP_CORRUPT", "备份文件内容被修改或损坏");
    let parsed: { manifest: Record<string, unknown> & { counts: BackupCounts; encryption: { mode: string } }; state: MemoryState };
    try { parsed = JSON.parse(pkg.body); } catch { return fail("BACKUP_CORRUPT", "备份清单无法解析"); }
    const m = parsed.manifest;
    if (m.format !== "shiguang-backup") fail("BACKUP_INVALID", "这不是拾光备份文件");
    if (Number(m.formatVersion) > 1) fail("BACKUP_FORMAT_TOO_NEW", "备份格式来自更新版本的拾光");
    if (m.encryption?.mode !== "none") fail("BACKUP_ENCRYPTED_UNSUPPORTED", "此备份已加密，当前版本尚不支持口令解密");
    if (Number(m.schemaVersion) > 2) fail("BACKUP_SCHEMA_TOO_NEW", "备份来自更新版本的拾光，请先升级");
    const summary: BackupSummary = {
      formatVersion: Number(m.formatVersion), schemaVersion: Number(m.schemaVersion), appVersion: String(m.appVersion),
      exportedAt: String(m.exportedAt), bytes: pkg.bytes, encryption: "none", counts: m.counts,
    };
    return { summary, state: parsed.state };
  }
  async backupCapabilities(): Promise<BackupCapabilities> {
    return { platform: "preview", overwriteRestore: true, merge: false, encryption: false, antiResurrection: false, fileAccess: "preview" };
  }
  async exportBackup(): Promise<ExportBackupResult> {
    this.check("exportBackup");
    const state = this.reload(), pkg = this.packBackup(state);
    // 导出只读：不改动当前状态与存储。
    this.lastExport = pkg;
    const { summary } = this.verifyPreview(pkg);
    const referenced = new Set(this.references(state).map((r) => r.photo.assetId));
    const missingMedia = [...referenced].filter((id) => !state.assets[id] || this.assetStatus(state, id) === "missing").sort();
    const stamp = this.now().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-").replace(/Z$/, "");
    return { cancelled: false, fileName: `拾光备份-${stamp}.sgbak`, location: "浏览器预览（内存，未写入文件）", sha256: pkg.sha256, summary, missingMedia };
  }
  async pickBackup(): Promise<PickBackupResult> {
    this.check("pickBackup");
    let pkg: PreviewBackup | null = this.lastExport ? copy(this.lastExport) : null;
    const base = () => pkg ?? this.packBackup(this.reload());
    switch (this.nextPick) {
      case "lastExport": break;
      case "corrupt": { const b = base(); pkg = { ...b, body: b.body.replace("合成", "篡改") }; if (pkg.body === b.body) pkg.sha256 = "0".repeat(64); break; }
      case "truncated": { const b = base(); pkg = { ...b, body: b.body.slice(0, Math.floor(b.body.length / 2)) }; break; }
      case "schemaTooNew": pkg = this.packBackup(this.reload(), { schemaVersion: 99 }); break;
      case "encrypted": pkg = this.packBackup(this.reload(), { encryption: { mode: "aead-preview" } } as unknown as Partial<BackupSummary>); break;
      case "notBackup": pkg = { magic: "PNG" as "SGBAK-PREVIEW", body: "", sha256: "", bytes: 0 }; break;
    }
    if (!pkg) return { cancelled: true };
    const { summary, state } = this.verifyPreview(pkg);
    const token = `pick-${this.picked.size + 1}-${Date.now()}`;
    this.picked.set(token, state);
    return { cancelled: false, token, fileName: "拾光备份-预览.sgbak", summary };
  }
  async restoreBackup(token: string): Promise<RestoreBackupResult> {
    this.check("restoreBackup");
    const incoming = this.picked.get(token) ?? fail("BACKUP_TOKEN_INVALID", "请重新选择备份文件");
    const current = this.reload();
    const stamp = this.now().replace(/[-:.]/g, "");
    const safetyKey = `${this.key}.pre-restore.${stamp}`;
    // 先留安全副本；写入失败则整体中止，当前数据不变。
    try { this.storage?.setItem(safetyKey, JSON.stringify(current)); }
    catch (error) { fail("RESTORE_SAFETY_BACKUP_FAILED", String(error)); }
    const next: MemoryState = { ...copy(incoming), quarantine: copy(current.quarantine) };
    this.persist(next);
    this.picked.delete(token);
    const mediaReport = await this.mediaReport();
    return { restored: this.counts(next), safetyBackup: `backups/pre-restore-${stamp}`, mediaReport, durability: this.durabilityMode };
  }
  async discardPickedBackup(token: string): Promise<void> { this.picked.delete(token); }
}

export function createMemoryApi(options: ConstructorParameters<typeof MemoryAdapter>[0] = {}): MemoryAdapter {
  return new MemoryAdapter(options);
}
