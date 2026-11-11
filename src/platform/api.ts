import type { TagInfo, TagImpact, MetaResult, TagMergeResult, TagDeleteResult, TimelineFilter, TimelinePage, MonthCount, CalendarDay, OnThisDayGroup, TimelineItem, SortOrder } from "../domain/types.ts";
import type { CommitResult, Durability, RecordRow, ConflictChoice, ConflictCopy, MediaReport, PhotoStatus, PurgeResult, StoreStatus, BackupCapabilities, ExportBackupOptions, ExportBackupResult, MergePlan, MergeResult, PickBackupResult, RestoreBackupResult, BackupSummary } from "../domain/types.ts";
import type { Mood, AppSettings, SettingsResult, ThemePreference } from "../domain/types.ts";

export interface DraftFields {
  title?: string;
  body?: string;
  eventDate?: string;
  eventTime?: string | null;
  location?: string;
  mood?: Mood | null;
}
export interface CreateDraftInput extends DraftFields { baseRecordId?: string | null }
export interface SaveDraftInput extends DraftFields { recordId: string; clearEventTime?: boolean; clearMood?: boolean }
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
  storageStats(): Promise<import("../domain/types.ts").StorageStats>;
  getSettings(): Promise<AppSettings>;
  setTheme(theme: ThemePreference): Promise<SettingsResult>;
  /** Optional UI gate; the real app uses Rust Argon2id, never file encryption. */
  setAppLock(passcode: string): Promise<SettingsResult>;
  verifyAppLock(passcode: string): Promise<SettingsResult>;
  changeAppLock(currentPasscode: string, newPasscode: string): Promise<SettingsResult>;
  disableAppLock(currentPasscode: string): Promise<SettingsResult>;
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
  setDraftPhotoCaption(recordId: string, photoUseId: string, caption: string): Promise<SaveResult>;
  setDraftCover(recordId: string, photoUseId: string): Promise<SaveResult>;
  reorderDraftPhotos(recordId: string, photoUseIds: string[]): Promise<SaveResult>;
  discardDraft(recordId: string): Promise<DiscardResult>;
  commitRecord(recordId: string, expectedBaseRevision: number): Promise<CommitResult>;
  photoDataUrl(assetId: string): Promise<string>;
  /** Bounded cached cover; HEIC_UNSUPPORTED produces a labeled placeholder. */
  photoThumbUrl(assetId: string): Promise<string>;
  exportManifest(outPath: string): Promise<{ out: string; records: number }>;
  // ---- Unit-0.5 备份/恢复（G03 最小版：导出、完整校验、覆盖恢复）----
  backupCapabilities(): Promise<BackupCapabilities>;
  /** 一致性快照导出单文件 .sgbak；桌面弹原生保存框，Android 走系统文件选择器；用户取消返回 cancelled。 */
  exportBackup(options?: ExportBackupOptions): Promise<ExportBackupResult>;
  /** 选择备份文件并完整校验（哈希/版本/截断/篡改）；无效包以 BACKUP_* 拒绝，且不改动现有数据。 */
  pickBackup(): Promise<PickBackupResult>;
  /** 覆盖恢复：先自动在本机留安全副本，原子切换，失败整体回滚。token 来自 pickBackup。 */
  restoreBackup(token: string): Promise<RestoreBackupResult>;
  /** 加密备份：输入口令解密并完整校验；错误口令 BACKUP_PASSWORD_WRONG，不改动现有数据。 */
  unlockBackup(token: string, password: string): Promise<{ summary: BackupSummary }>;
  /** 安全合并预演（只读）：将新增/更新/保留/跳过（已删除不复活）的数量。 */
  planMerge(token: string): Promise<MergePlan>;
  /** 安全合并：保留现有数据，只添加/更新；冲突留副本；先留安全副本，失败整体回滚。 */
  mergeBackup(token: string): Promise<MergeResult>;
  /** 放弃已选择但未恢复的备份（清理临时副本）。 */
  discardPickedBackup(token: string): Promise<void>;
  // ---- Unit-0.7 珍藏 / 标签（独立元数据：不发布草稿、不改正文修订；expectedRevision 给定时做 CAS） ----
  setFavorite(recordId: string, favorite: boolean, expectedRevision?: number | null): Promise<MetaResult>;
  setRecordTags(recordId: string, tagIds: string[], expectedRevision?: number | null): Promise<MetaResult>;
  listTags(): Promise<TagInfo[]>;
  /** 同名（忽略大小写/首尾空白）→ TAG_NAME_CONFLICT（附 tagId）。 */
  createTag(name: string): Promise<TagInfo>;
  /** 与其他标签重名 → TAG_NAME_CONFLICT；UI 提示“合并或取消”，不默默覆盖。 */
  renameTag(tagId: string, name: string): Promise<TagInfo>;
  /** 原子：改写关联并去重、删除来源、留别名。 */
  mergeTags(fromTagId: string, intoTagId: string): Promise<TagMergeResult>;
  /** 只解除关联，不删除任何记录/照片/文字。 */
  deleteTag(tagId: string): Promise<TagDeleteResult>;
  tagImpact(tagId: string): Promise<TagImpact>;
  // ---- Unit-0.7 时光轴 / 日历（只读，只含正式记录） ----
  timelinePage(filter: TimelineFilter, cursor: string | null, limit: number): Promise<TimelinePage>;
  timelineMonths(filter: TimelineFilter): Promise<MonthCount[]>;
  calendarMonth(year: number, month: number, filter?: TimelineFilter): Promise<CalendarDay[]>;
  dayEntries(date: string, order?: SortOrder): Promise<TimelineItem[]>;
  /** 往年同月同日；today 缺省为设备本地日期。 */
  onThisDay(month: number, day: number, today?: string): Promise<OnThisDayGroup[]>;
}
