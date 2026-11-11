/** 与 Rust 核心 state.json 对齐的领域类型。 */

export interface PhotoUse {
  photoUseId: string;
  assetId: string;
  caption: string;
  sha256: string;
  bytes: number;
  mediaType: string;
}

export const MOODS = ["开心", "平静", "感动", "想念", "疲惫", "难过"] as const;
export type Mood = typeof MOODS[number];
export type ThemePreference = "light" | "dark" | "system";

export interface Snapshot {
  title: string;
  body: string;
  eventDate: string;
  /** 可空；展示层不得为缺失时刻伪造时间。 */
  eventTime: string | null;
  location: string;
  mood: Mood | null;
  coverPhotoUseId: string | null;
  /** 唯一权威顺序，重排整个使用位及其说明。 */
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
  /** Unit-0.7（schema v3）：珍藏是独立元数据，有独立修订号，不随草稿提交（G01）。 */
  favorite: boolean;
  favoriteRevision: number;
  /** Unit-0.7：标签关联（tagId 列表）与其修订号；只经标签操作修改。 */
  tagIds: string[];
  tagRevision: number;
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
  /** Unit-0.7：旧包缺省为 0。 */
  tags?: number; favorites?: number;
}
/** 来自备份包 manifest 的摘要；encryption：none = 明文包，argon2id-xchacha20poly1305 = 口令加密包（解锁后才有摘要）。 */
export interface BackupSummary {
  formatVersion: number; schemaVersion: number; appVersion: string; exportedAt: string;
  bytes: number; encryption: "none" | "argon2id-xchacha20poly1305"; counts: BackupCounts;
}
export type BackupPlatform = "desktop" | "android" | "preview";
/** 本单元只实现覆盖恢复；以下能力如实报告为未实现。 */
export interface BackupCapabilities {
  platform: BackupPlatform; overwriteRestore: true;
  merge: boolean; encryption: boolean; antiResurrection: boolean;
  /** android: "saf"=系统文件选择器；"appDir"=仅应用专属目录（退路） */
  fileAccess: "dialog" | "saf" | "appDir" | "preview";
}
export type ExportBackupResult =
  | { cancelled: true }
  | { cancelled: false; fileName: string; location: string; sha256: string; summary: BackupSummary; missingMedia: string[] };
/** encrypted=true 时 summary 为 null，需先 unlockBackup 输入口令。 */
export type PickBackupResult =
  | { cancelled: true }
  | { cancelled: false; token: string; fileName: string; encrypted: boolean; summary: BackupSummary | null };
export interface ExportBackupOptions { /** 非空即用口令加密（Argon2id + XChaCha20-Poly1305）；拾光不保存口令。 */ password?: string }
// ---- Unit-0.6 安全合并 + 防复活 ----
export interface MergeCounts {
  added: number; updated: number; unchanged: number; conflicts: number;
  keptTrashed: number; keptActive: number; skippedDeleted: number; deletedInBackup: number;
  markersAdded: number; conflictCopiesAdded: number; conflictCopiesDropped: number; mediaAdded: number; mediaMissing: number; mediaConflicts: number;
  /** Unit-0.7：标签与珍藏的合并统计（旧版本缺省 0）。 */
  tagsAdded?: number; tagsRemapped?: number; tagsSkippedDeleted?: number; tagsDeletedInBackup?: number;
  favoritesUpdated?: number; tagLinksUpdated?: number;
}
/** 合并计划：只读预演；skippedDeleted = 本机已永久删除、旧备份里仍有的记录（不复活）。 */
export interface MergePlan { counts: MergeCounts; skippedDeleted: string[]; deletedInBackup: string[] }
export interface MergeResult { plan: MergePlan; safetyBackup: string; mediaReport: MediaReport; durability: Durability }
export interface RestoreBackupResult {
  restored: BackupCounts; safetyBackup: string; mediaReport: MediaReport; durability: Durability;
}

// ---- Unit-0.7 时光轴 / 日历 / 珍藏 / 标签 ----
export interface TagDef { tagId: string; name: string; normName: string; createdAt: string }
export interface TagAlias { fromTagId: string; fromCreatedAt: string; toTagId: string; mergedAt: string }
export interface TagTombstone { tagId: string; createdAt: string; deletedAt: string }
export interface TagInfo { tagId: string; name: string; createdAt: string; activeCount: number; trashedCount: number }
export interface TagImpact { active: number; trashed: number }
export interface MetaResult {
  recordId: string; favorite: boolean; favoriteRevision: number; tagIds: string[]; tagRevision: number; durability: Durability;
}
export interface TagMergeResult { into: TagInfo; affectedRecords: number; durability: Durability }
export interface TagDeleteResult { affectedRecords: number; durability: Durability }
export type SortOrder = "desc" | "asc";
/** 不同条件 AND；tagIds 内部 OR（M05-S07）。日期闭区间 YYYY-MM-DD。 */
export interface TimelineFilter {
  from?: string | null; to?: string | null; favoriteOnly?: boolean; tagIds?: string[]; hasPhoto?: boolean | null; order?: SortOrder;
}
export interface TimelineItem {
  recordId: string; eventDate: string; eventTime: string | null; title: string; excerpt: string;
  cover: PhotoUse | null; photoCount: number; favorite: boolean; favoriteRevision: number;
  tagIds: string[]; tagRevision: number; createdAt: string; isFuture: boolean;
}
export interface TimelinePage { items: TimelineItem[]; nextCursor: string | null; total: number }
export interface MonthCount { year: number; month: number; count: number }
export interface CalendarDay { date: string; count: number; photoCount: number; hasFavorite: boolean }
export interface OnThisDayGroup { year: number; items: TimelineItem[] }
