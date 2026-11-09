import type { CommitResult, Durability, RecordRow } from "../domain/types.ts";

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
