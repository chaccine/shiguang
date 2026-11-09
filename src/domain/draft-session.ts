import type { AttachPhotoBytesInput, DraftFields, ShiguangApi, SaveResult } from "../platform/api.ts";
import type { CommitResult, Durability, RecordRow, Snapshot } from "./types.ts";
import { describeError } from "./errors.ts";
import type { ErrorDescription } from "./errors.ts";
import { validateForCommit } from "./rules.ts";

export type DraftStatus = "idle" | "dirty" | "saving" | "saved" | "savedUncertain" | "error" | "conflict";
export interface DraftSessionSnapshot {
  status: DraftStatus;
  recordId: string | null;
  snapshot: Snapshot;
  lastError?: ErrorDescription;
  lastSavedAt?: string;
}
export interface DraftSessionOptions<Handle> {
  api: ShiguangApi;
  schedule(fn: () => void, ms: number): Handle;
  cancel(handle: Handle): void;
  debounceMs?: number;
}
const copy = <T>(value: T): T => structuredClone(value);
const blank = (): Snapshot => ({ title: "", body: "", eventDate: "", eventTime: null, photos: [] });
const problem = (code: string, message: string) => ({ code, message });

/**
 * 一个会话只拥有一条记录。切换前 await flush()，再 open(row)。
 * 所有写入串行；版本号只用于识别本地编辑，绝不用于裁决跨实例冲突。
 * 窗口关闭由宿主先阻止关闭、await flush() 后再关闭；本模块不依赖 DOM。
 */
export class DraftSession<Handle = unknown> {
  private api: ShiguangApi;
  private options: DraftSessionOptions<Handle>;
  private timer: { handle: Handle } | null = null;
  private listeners = new Set<(state: DraftSessionSnapshot) => void>();
  private data: DraftSessionSnapshot = { status: "idle", recordId: null, snapshot: blank() };
  private baseRevision = 0;
  private version = 0;
  private savedVersion = 0;
  private failure: unknown;
  private conflicted = false;
  private failureGeneration = 0;
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(options: DraftSessionOptions<Handle>) { this.api = options.api; this.options = options; }
  get state(): DraftSessionSnapshot { return copy(this.data); }
  onChange(listener: (state: DraftSessionSnapshot) => void): () => void {
    this.listeners.add(listener); listener(this.state);
    return () => { this.listeners.delete(listener); };
  }
  private emit(): void { for (const listener of this.listeners) listener(this.state); }
  private stopTimer(): void {
    if (this.timer) this.options.cancel(this.timer.handle);
    this.timer = null;
  }
  private arm(): void {
    this.stopTimer();
    if (this.conflicted) return;
    this.timer = { handle: this.options.schedule(() => {
      this.timer = null;
      // 自动保存没有 Promise 调用方；失败已进入可观察状态并保留输入。
      void this.flush().catch(() => {});
    }, this.options.debounceMs ?? 800) };
  }
  private clearError(): void { delete this.data.lastError; }
  private failed(error: unknown): void {
    this.failureGeneration++;
    this.failure = error;
    this.data.lastError = describeError(error);
    this.conflicted ||= this.data.lastError.kind === "conflict";
    this.data.status = this.conflicted ? "conflict" : "error";
    this.stopTimer(); this.emit();
  }
  private saved(durability: Durability, updatedAt: string): void {
    this.clearError(); this.data.lastSavedAt = updatedAt;
    this.data.status = durability === "uncertain" ? "savedUncertain" : "saved";
    if (durability === "uncertain") this.data.lastError = describeError(durability);
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.queued++;
    // 已排队的操作不能在前一次写入失败后悄悄重试；新发起的 retry/flush 可重试。
    const generation = this.failureGeneration;
    const result = this.tail.then(async () => {
      try {
        if (this.conflicted || generation !== this.failureGeneration) throw this.failure;
        return await work();
      } catch (error) { this.failed(error); throw error; }
      finally { this.queued--; }
    });
    // 队列自身永不拒绝，原 result 仍将错误交给调用方。
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  open(row: RecordRow | null): void {
    if (this.queued || this.version !== this.savedVersion || this.conflicted) {
      throw problem("SESSION_BUSY", "请先保存当前编辑；发生冲突时请保留本地副本并新建会话核对版本。");
    }
    this.stopTimer(); this.clearError(); this.version = this.savedVersion = 0;
    this.baseRevision = row?.baseRevision ?? 0;
    this.data = { status: row ? "saved" : "idle", recordId: row?.recordId ?? null,
      snapshot: copy(row?.draft ?? row?.formal ?? blank()), ...(row ? { lastSavedAt: row.updatedAt } : {}) };
    this.emit();
  }
  edit(patch: DraftFields): void {
    for (const field of ["title", "body", "eventDate", "eventTime"] as const) {
      const value = patch[field];
      if (value !== undefined) {
        if (field === "eventTime") this.data.snapshot.eventTime = value;
        else this.data.snapshot[field] = value as string;
      }
    }
    this.version++;
    if (!this.conflicted) {
      this.clearError(); this.data.status = this.queued ? "saving" : "dirty"; this.arm();
    }
    this.emit();
  }
  private hasInput(): boolean {
    const s = this.data.snapshot;
    return [s.title, s.body, s.eventDate, s.eventTime ?? ""].some((v) => v.trim().length > 0) || s.photos.length > 0;
  }
  private async drain(): Promise<void> {
    while (this.version !== this.savedVersion) {
      this.stopTimer();
      if (this.data.recordId === null && !this.hasInput()) {
        this.savedVersion = this.version; this.clearError(); this.data.status = "idle"; this.emit(); return;
      }
      const sentVersion = this.version, snapshot = copy(this.data.snapshot);
      this.data.status = "saving"; this.clearError(); this.emit();
      let result: SaveResult;
      if (this.data.recordId === null) {
        result = await this.api.createDraft(snapshot);
        this.data.recordId = result.row.recordId;
        this.baseRevision = result.row.baseRevision;
      } else {
        result = await this.api.saveDraft({ recordId: this.data.recordId, title: snapshot.title,
          body: snapshot.body, eventDate: snapshot.eventDate, eventTime: snapshot.eventTime });
      }
      this.savedVersion = sentVersion;
      // 不能把响应中的旧字段写回本地：在途期间的输入仍是权威的本地内容。
      this.data.snapshot.photos = copy(result.row.draft?.photos ?? snapshot.photos);
      this.saved(result.durability, result.row.updatedAt);
      if (this.version !== this.savedVersion) this.data.status = "saving";
      this.emit();
    }
    this.stopTimer();
  }
  flush(): Promise<void> {
    this.stopTimer();
    return this.exclusive(() => this.drain());
  }
  retry(): Promise<void> {
    if (this.conflicted) return Promise.reject(this.failure);
    // uncertain 已生效；显式重试会重新写入，而不是假装恢复了目录同步确认。
    if (this.data.status === "savedUncertain") this.version++;
    return this.flush();
  }
  attachPhoto(input: Omit<AttachPhotoBytesInput, "recordId">): Promise<SaveResult> {
    this.stopTimer();
    return this.exclusive(async () => {
      await this.drain();
      if (this.data.recordId === null) {
        // 照片本身是非空输入；允许从全空编辑区开始附加照片。
        if (!input.bytes.length) throw problem("EMPTY_ASSET", "图片文件为空");
        if (input.bytes.length > 25 * 1024 * 1024) throw problem("ASSET_TOO_LARGE", "图片超过 25MB");
        if (!input.fileName || [".", ".."].includes(input.fileName) || /[/\\:\0]/.test(input.fileName)) {
          throw problem("INVALID_ASSET_NAME", "请只提供图片文件名");
        }
        const created = await this.api.createDraft(this.data.snapshot);
        this.data.recordId = created.row.recordId; this.baseRevision = created.row.baseRevision;
        this.saved(created.durability, created.row.updatedAt);
      }
      const result = await this.api.attachPhotoBytes({ ...input, recordId: this.data.recordId });
      this.data.snapshot.photos = copy(result.row.draft!.photos);
      this.saved(result.durability, result.row.updatedAt);
      if (this.version !== this.savedVersion) this.data.status = "dirty";
      this.emit();
      if (this.version !== this.savedVersion) this.arm();
      return result;
    });
  }
  removePhoto(photoUseId: string): Promise<SaveResult> {
    this.stopTimer();
    return this.exclusive(async () => {
      await this.drain();
      if (!this.data.recordId) throw problem("PHOTO_USE_NOT_FOUND", "草稿中没有这张照片");
      const result = await this.api.removeDraftPhoto(this.data.recordId, photoUseId);
      this.data.snapshot.photos = copy(result.row.draft!.photos);
      this.saved(result.durability, result.row.updatedAt);
      if (this.version !== this.savedVersion) { this.data.status = "dirty"; this.arm(); }
      this.emit(); return result;
    });
  }
  commit(): Promise<CommitResult> {
    this.stopTimer();
    return this.exclusive(async () => {
      await this.drain();
      const issue = validateForCommit(this.data.snapshot);
      if (issue) throw issue;
      if (!this.data.recordId) throw problem("NO_DRAFT", "没有待提交的草稿");
      const sentVersion = this.version;
      this.data.status = "saving"; this.emit();
      const result = await this.api.commitRecord(this.data.recordId, this.baseRevision);
      this.baseRevision = result.contentRevision;
      this.saved(result.durability, result.committedAt);
      // 提交等待期间的新输入保留为下一份草稿，不并入已提交版本。
      if (this.version !== sentVersion) { this.data.status = "dirty"; this.arm(); }
      this.emit(); return result;
    });
  }
}

export async function recoverLastDraft(api: ShiguangApi, preferredRecordId?: string): Promise<RecordRow | null> {
  const rows = (await api.listDrafts()).filter((r) => r.draft !== null);
  return rows.find((r) => r.recordId === preferredRecordId)
    ?? rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.recordId.localeCompare(a.recordId))[0]
    ?? null;
}
