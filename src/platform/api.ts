import type { CommitResult, Durability, RecordRow, ConflictChoice, ConflictCopy, MediaReport, PhotoStatus, PurgeResult, StoreStatus } from "../domain/types.ts";

export interface DraftFields {
  title?: string;
  body?: string;
  eventDate?: string;
  eventTime?: string | null;
}
export interface CreateDraftInput extends DraftFields { baseRecordId?: string | null }
export interface SaveDraftInput extends DraftFields { recordId: string; clearEventTime?: boolean }
export interface AttachPhotoBytesInput {
  recordId: string;
  fileName: string;
  bytes: readonly number[] | Uint8Array;
  caption: string;
  mediaType?: string | null;
}
export interface SaveResult { row: RecordRow; durability: Durability }
export interface DiscardResult { row: RecordRow | null; durability: Durability }

/** Rust 命令与浏览器预览共享的契约。所有错误均以 rejection 传给调用方。 */
export interface ShiguangApi {
  /** 回收站保留正式版与草稿；永久删除必须由调用方明确触发。 */
  trashRecord(recordId: string): Promise<SaveResult>;
  restoreRecord(recordId: string): Promise<SaveResult>;
  purgeRecord(recordId: string): Promise<PurgeResult>;
  emptyTrash(): Promise<PurgeResult>;
  listTrash(): Promise<RecordRow[]>;
  /** keepMine 仅更新草稿基线；用户仍需再次调用 commitRecord。 */
  resolveConflict(recordId: string, choice: ConflictChoice): Promise<SaveResult>;
  listConflictCopies(): Promise<ConflictCopy[]>;
  restoreConflictCopy(conflictId: string): Promise<SaveResult>;
  /** 启动核查报告；隔离原图保留在隔离区。 */
  mediaReport(): Promise<MediaReport>;
  photoStatus(assetId: string): Promise<PhotoStatus>;
  /** 启动失败在这里返回 ok:false，其他方法以相同错误拒绝。 */
  storeStatus(): Promise<StoreStatus>;
  listDrafts(): Promise<RecordRow[]>;
  listFormalRecords(): Promise<RecordRow[]>;
  getRecord(recordId: string): Promise<RecordRow>;
  createDraft(input: CreateDraftInput): Promise<SaveResult>;
  saveDraft(input: SaveDraftInput): Promise<SaveResult>;
  attachPhotoBytes(input: AttachPhotoBytesInput): Promise<SaveResult>;
  removeDraftPhoto(recordId: string, photoUseId: string): Promise<SaveResult>;
  discardDraft(recordId: string): Promise<DiscardResult>;
  commitRecord(recordId: string, expectedBaseRevision: number): Promise<CommitResult>;
  photoDataUrl(assetId: string): Promise<string>;
  exportManifest(outPath: string): Promise<{ out: string; records: number }>;
}
