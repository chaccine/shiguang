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

// ---- Unit-0.5 备份/恢复（G03 最小版）----
export interface BackupCounts {
  formal: number; drafts: number; trashed: number; deletionMarkers: number;
  conflictCopies: number; mediaFiles: number; missingMedia: number;
}
/** 来自备份包 manifest 的摘要；encryption 目前只有 "none"（口令加密未实现）。 */
export interface BackupSummary {
  formatVersion: number; schemaVersion: number; appVersion: string; exportedAt: string;
  bytes: number; encryption: "none"; counts: BackupCounts;
}
export type BackupPlatform = "desktop" | "android" | "preview";
/** 本单元只实现覆盖恢复；以下能力如实报告为未实现。 */
export interface BackupCapabilities {
  platform: BackupPlatform; overwriteRestore: true;
  merge: false; encryption: false; antiResurrection: false;
  /** android: "saf"=系统文件选择器；"appDir"=仅应用专属目录（退路） */
  fileAccess: "dialog" | "saf" | "appDir" | "preview";
}
export type ExportBackupResult =
  | { cancelled: true }
  | { cancelled: false; fileName: string; location: string; sha256: string; summary: BackupSummary; missingMedia: string[] };
export type PickBackupResult =
  | { cancelled: true }
  | { cancelled: false; token: string; fileName: string; summary: BackupSummary };
export interface RestoreBackupResult {
  restored: BackupCounts; safetyBackup: string; mediaReport: MediaReport; durability: Durability;
}
