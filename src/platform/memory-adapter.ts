import type { CommitResult, Durability, RecordRow, Snapshot, ConflictChoice, ConflictCopy, MediaReport, PhotoStatus, PurgeResult, StoreStatus } from "../domain/types.ts";
import { isValidDate, isValidTime, validateForCommit } from "../domain/rules.ts";
import type { AttachPhotoBytesInput, CreateDraftInput, DiscardResult, SaveDraftInput, SaveResult, ShiguangApi } from "./api.ts";
import { base64, sha256, sniffMediaType } from "./bytes.ts";

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
interface MemoryState {
  version: 1;
  seq: number;
  records: RecordRow[];
  assets: Record<string, { dataUrl: string; sha256: string; bytes: number }>;
}
type Operation = keyof ShiguangApi;
const copy = <T>(value: T): T => structuredClone(value);
const fail = (code: string, message = code): never => { throw { code, message }; };
const blank = (): Snapshot => ({ title: "", body: "", eventDate: "", eventTime: null, photos: [] });
const normalizeTime = (value: string | null | undefined) => value?.trim() || null;

/** 仅供浏览器合成数据预览；storage 由调用方注入，不接触 DOM 全局。 */
export class MemoryAdapter implements ShiguangApi {
  // Unit-0.4 phase 1: typed stubs, intentionally failing behavioral tests.
  async trashRecord(_recordId: string): Promise<SaveResult> { return fail("NOT_IMPLEMENTED"); }
  async restoreRecord(_recordId: string): Promise<SaveResult> { return fail("NOT_IMPLEMENTED"); }
  async purgeRecord(_recordId: string): Promise<PurgeResult> { return fail("NOT_IMPLEMENTED"); }
  async emptyTrash(): Promise<PurgeResult> { return fail("NOT_IMPLEMENTED"); }
  async listTrash(): Promise<RecordRow[]> { return fail("NOT_IMPLEMENTED"); }
  async resolveConflict(_recordId: string, _choice: ConflictChoice): Promise<SaveResult> { return fail("NOT_IMPLEMENTED"); }
  async listConflictCopies(): Promise<ConflictCopy[]> { return fail("NOT_IMPLEMENTED"); }
  async restoreConflictCopy(_conflictId: string): Promise<SaveResult> { return fail("NOT_IMPLEMENTED"); }
  async mediaReport(): Promise<MediaReport> { return fail("NOT_IMPLEMENTED"); }
  async photoStatus(_assetId: string): Promise<PhotoStatus> { return fail("NOT_IMPLEMENTED"); }
  async storeStatus(): Promise<StoreStatus> { return fail("NOT_IMPLEMENTED"); }
  durabilityMode: Durability = "durable";
  private state: MemoryState = { version: 1, seq: 0, records: [], assets: {} };
  private failures = new Map<Operation, string>();
  private storage?: StorageLike;
  private key: string;
  private now: () => string;

  constructor(options: { storage?: StorageLike; storageKey?: string; now?: () => string } = {}) {
    this.storage = options.storage;
    this.key = options.storageKey ?? "shiguang.synthetic.unit02";
    this.now = options.now ?? (() => new Date().toISOString());
    this.state = this.reload();
  }
  failNext(code: string, op: Operation): void { this.failures.set(op, code); }
  private check(op: Operation): void {
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
      if (state.version !== 1 || !Number.isSafeInteger(state.seq) || state.seq < 0
        || !Array.isArray(state.records) || !state.assets || typeof state.assets !== "object" || Array.isArray(state.assets)) throw new Error("状态结构无效");
      for (const row of state.records) {
        if (typeof row.recordId !== "string" || !Number.isInteger(row.contentRevision) || row.contentRevision < 0
          || !Number.isInteger(row.baseRevision) || row.baseRevision < 0
          || typeof row.createdAt !== "string" || typeof row.updatedAt !== "string"
          || !(row.committedAt === null || typeof row.committedAt === "string")
          || (row.draft === null && row.formal === null)) throw new Error("记录结构无效");
        for (const snap of [row.draft, row.formal]) {
          if (snap === null) continue;
          if (!snap || ![snap.title, snap.body, snap.eventDate].every((v) => typeof v === "string")
            || !(snap.eventTime === null || typeof snap.eventTime === "string") || !Array.isArray(snap.photos)) throw new Error("快照结构无效");
          for (const p of snap.photos) {
            if (![p.photoUseId, p.assetId, p.caption, p.mediaType].every((v) => typeof v === "string")
              || !/^[a-f0-9]{64}$/.test(p.sha256) || !Number.isSafeInteger(p.bytes) || p.bytes < 0) throw new Error("照片结构无效");
          }
        }
      }
      for (const asset of Object.values(state.assets)) {
        if (!asset || typeof asset.dataUrl !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)
          || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0) throw new Error("原图结构无效");
      }
      return state;
    } catch (error) { return fail("STATE_CORRUPT", `预览状态无法读取：${String(error)}`); }
  }
  private persist(next: MemoryState): void {
    try { this.storage?.setItem(this.key, JSON.stringify(next)); }
    catch (error) { fail("PERSIST_REPLACE_FAILED", String(error)); }
    this.state = next;
  }
  private row(state: MemoryState, id: string): RecordRow {
    return state.records.find((r) => r.recordId === id) ?? fail("NOT_FOUND");
  }
  private draft(row: RecordRow): Snapshot {
    if (row.draft === null) {
      row.draft = copy(row.formal ?? fail("NO_DRAFT"));
      row.baseRevision = row.contentRevision;
    }
    return row.draft;
  }
  private result(row: RecordRow): SaveResult { return { row: copy(row), durability: this.durabilityMode }; }
  private id(state: MemoryState, prefix: string): string { return `${prefix}-${String(++state.seq).padStart(6, "0")}`; }

  async listDrafts(): Promise<RecordRow[]> {
    this.check("listDrafts");
    return copy(this.reload().records.filter((r) => r.draft !== null).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || b.recordId.localeCompare(a.recordId)));
  }
  async listFormalRecords(): Promise<RecordRow[]> {
    this.check("listFormalRecords");
    return copy(this.reload().records.filter((r) => r.formal !== null).sort((a, b) =>
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
      row = this.row(next, input.baseRecordId);
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
    if (input.eventDate !== undefined && input.eventDate.trim() && !isValidDate(input.eventDate)) fail("INVALID_EVENT_DATE");
    if (!input.clearEventTime && input.eventTime?.trim() && !isValidTime(input.eventTime)) fail("INVALID_EVENT_TIME");
    const next = this.reload(), row = this.row(next, input.recordId), draft = this.draft(row);
    for (const field of ["title", "body", "eventDate"] as const) {
      if (input[field] !== undefined) draft[field] = input[field];
    }
    if (input.clearEventTime || input.eventTime !== undefined) draft.eventTime = input.clearEventTime ? null : normalizeTime(input.eventTime);
    row.updatedAt = this.now(); this.persist(next); return this.result(row);
  }
  async attachPhotoBytes(input: AttachPhotoBytesInput): Promise<SaveResult> {
    this.check("attachPhotoBytes");
    if (!input.fileName || [".", ".."].includes(input.fileName) || /[/\\:\0]/.test(input.fileName)) fail("INVALID_ASSET_NAME");
    if (!input.bytes.length) fail("EMPTY_ASSET");
    if (input.bytes.length > 25 * 1024 * 1024) fail("ASSET_TOO_LARGE");
    for (const b of input.bytes) { if (!Number.isInteger(b) || b < 0 || b > 255) fail("INVALID_ASSET_BYTES"); }
    const next = this.reload(), row = this.row(next, input.recordId), draft = this.draft(row);
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
    const next = this.reload(), row = this.row(next, recordId);
    const index = row.draft?.photos.findIndex((p) => p.photoUseId === photoUseId) ?? -1;
    if (index < 0) fail("PHOTO_USE_NOT_FOUND");
    row.draft!.photos.splice(index, 1); row.updatedAt = this.now();
    this.persist(next); return this.result(row);
  }
  async discardDraft(recordId: string): Promise<DiscardResult> {
    this.check("discardDraft");
    const next = this.reload(), row = this.row(next, recordId);
    if (!row.formal) next.records = next.records.filter((r) => r.recordId !== recordId);
    else { row.draft = null; row.baseRevision = row.contentRevision; row.updatedAt = this.now(); }
    this.persist(next); return { row: row.formal ? copy(row) : null, durability: this.durabilityMode };
  }
  async commitRecord(recordId: string, expectedBaseRevision: number): Promise<CommitResult> {
    this.check("commitRecord");
    const local = this.row(this.state, recordId), draft = copy(local.draft ?? fail("NO_DRAFT"));
    const issue = validateForCommit(draft); if (issue) throw issue;
    const next = this.reload(), row = this.row(next, recordId);
    for (const photo of draft.photos) {
      const asset = next.assets[photo.assetId] ?? fail("ASSET_MISSING");
      if (asset.bytes !== photo.bytes) fail("ASSET_SIZE_MISMATCH");
      if (asset.sha256 !== photo.sha256) fail("ASSET_HASH_MISMATCH");
    }
    if (row.contentRevision !== expectedBaseRevision || local.baseRevision !== row.contentRevision) {
      if (!row.draft) { row.draft = draft; row.baseRevision = local.baseRevision; this.persist(next); }
      fail("REVISION_CONFLICT", "正式版已更新，本地草稿已保留");
    }
    row.contentRevision++; row.baseRevision = row.contentRevision; row.formal = draft; row.draft = null;
    row.updatedAt = row.committedAt = this.now(); this.persist(next);
    return { recordId, contentRevision: row.contentRevision, committedAt: row.committedAt, durability: this.durabilityMode };
  }
  async photoDataUrl(assetId: string): Promise<string> {
    this.check("photoDataUrl");
    const asset = this.reload().assets[assetId] ?? fail("ASSET_MISSING");
    if (asset.bytes > 8 * 1024 * 1024) fail("PREVIEW_TOO_LARGE");
    return asset.dataUrl;
  }
  async exportManifest(outPath: string): Promise<{ out: string; records: number }> {
    this.check("exportManifest");
    // 预览环境没有文件系统，明确报告无法导出，避免假装写入成功。
    return fail("IO_ERROR", `浏览器预览无法写入文件：${outPath}`);
  }
}

export function createMemoryApi(options: ConstructorParameters<typeof MemoryAdapter>[0] = {}): MemoryAdapter {
  return new MemoryAdapter(options);
}
