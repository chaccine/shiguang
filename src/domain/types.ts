/** 与 Rust 核心 state.json 对齐的领域类型。 */

export interface PhotoUse {
  photoUseId: string;
  assetId: string;
  caption: string;
  sha256: string;
  bytes: number;
  mediaType: string;
}

export interface Snapshot {
  title: string;
  body: string;
  eventDate: string;
  /** 可空；展示层不得为缺失时刻伪造时间。 */
  eventTime: string | null;
  photos: PhotoUse[];
}

export interface RecordRow {
  status: "active" | "trashed";
  trashedAt: string | null;
  recordId: string;
  contentRevision: number;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
  baseRevision: number;
  formal: Snapshot | null;
  draft: Snapshot | null;
}

export interface FieldIssue {
  code: string;
  message: string;
}

export type Durability = "durable" | "parentSyncUnsupported" | "uncertain";

export interface CoreErrorPayload {
  code: string;
  stage?: string;
  message: string;
}

export interface CommitResult {
  recordId: string;
  contentRevision: number;
  committedAt: string;
  durability: Durability;
}

export interface DeletionMarker { recordId: string; deletedAt: string; lastContentRevision: number }
export interface ConflictCopy {
  conflictId: string; recordId: string; baseRevision: number;
  snapshot: Snapshot; createdAt: string; reason: string;
}
export type ConflictChoice = "keepMine" | "keepFormal";
export interface QuarantinedMedia { assetId?: string | null; file: string; movedTo: string }
export interface MediaIssue { recordId: string; photoUseId: string; assetId: string }
export interface MediaReport {
  quarantined: QuarantinedMedia[]; missing: MediaIssue[]; corrupt: MediaIssue[]; checkedAt: string;
}
export type PhotoStatus = "available" | "missing" | "corrupt";
export interface PurgeResult { deletionMarkers: DeletionMarker[]; quarantined: QuarantinedMedia[]; durability: Durability }
export type StoreStatus = { ok: true } | { ok: false; code: string; message: string };
