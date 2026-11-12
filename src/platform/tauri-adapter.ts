import type { RecordRow, TimelineFilter } from "../domain/types.ts";
import { localToday } from "../domain/timeline.ts";
import type { ShiguangApi } from "./api.ts";
export type { ShiguangApi, SaveResult } from "./api.ts";

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** 保留已有路径附加命令；浏览器预览只支持字节通道。 */
export interface TauriApi extends ShiguangApi {
  attachPhoto(input: {
    recordId: string; sourcePath: string; caption: string; mediaType?: string | null;
  }): Promise<RecordRow>;
}

export function createTauriApi(invoke: InvokeFn): TauriApi {
  return {
    storageStats: () => invoke("storage_stats"),
    getSettings: () => invoke("get_settings"),
    setTheme: (theme) => invoke("set_theme", { theme }),
    setAppLock: (passcode) => invoke("set_app_lock", { passcode }),
    verifyAppLock: (passcode) => invoke("verify_app_lock", { passcode }),
    changeAppLock: (currentPasscode, newPasscode) => invoke("change_app_lock", { currentPasscode, newPasscode }),
    disableAppLock: (currentPasscode) => invoke("disable_app_lock", { currentPasscode }),
    // 原样传递结构化错误及 durability，不把启动/迁移失败转为成功。
    trashRecord: (recordId) => invoke("trash_record", { recordId }),
    restoreRecord: (recordId) => invoke("restore_record", { recordId }),
    purgeRecord: (recordId) => invoke("purge_record", { recordId }),
    emptyTrash: () => invoke("empty_trash"),
    listTrash: () => invoke("list_trash"),
    resolveConflict: (recordId, choice) => invoke("resolve_conflict", { recordId, choice }),
    listConflictCopies: () => invoke("list_conflict_copies"),
    restoreConflictCopy: (conflictId) => invoke("restore_conflict_copy", { conflictId }),
    mediaReport: () => invoke("media_report"),
    photoStatus: (assetId) => invoke("photo_status", { assetId }),
    storeStatus: () => invoke("store_status"),
    createDraft: (input) => invoke("create_draft", { input }),
    saveDraft: (input) => invoke("save_draft", {
      input: { ...input, clearEventTime: input.clearEventTime || input.eventTime === null,
        ...(input.mood !== undefined || input.clearMood ? { clearMood: input.clearMood || input.mood === null } : {}) },
    }),
    attachPhoto: (input) => invoke("attach_photo", { input }),
    attachPhotoBytes: (input) => invoke("attach_photo_bytes", { input: { ...input, bytes: Array.from(input.bytes) } }),
    removeDraftPhoto: (recordId, photoUseId) => invoke("remove_draft_photo", { recordId, photoUseId }),
    setDraftPhotoCaption: (recordId, photoUseId, caption) => invoke("set_draft_photo_caption", { recordId, photoUseId, caption }),
    setDraftCover: (recordId, photoUseId) => invoke("set_draft_cover", { recordId, photoUseId }),
    reorderDraftPhotos: (recordId, photoUseIds) => invoke("reorder_draft_photos", { recordId, photoUseIds }),
    discardDraft: (recordId) => invoke("discard_draft", { recordId }),
    commitRecord: (recordId, expectedBaseRevision) => invoke("commit_record", { recordId, expectedBaseRevision }),
    listDrafts: () => invoke("list_drafts"),
    listFormalRecords: () => invoke("list_formal_records"),
    getRecord: (recordId) => invoke("get_record", { recordId }),
    photoThumbUrl: (assetId) => invoke("photo_thumb_url", { assetId }),
    photoDataUrl: (assetId) => invoke("photo_data_url", { assetId }),
    exportManifest: (outPath) => invoke("export_manifest", { outPath }),
    backupCapabilities: () => invoke("backup_capabilities"),
    exportBackup: (options) => invoke("export_backup", { password: options?.password ?? null }),
    unlockBackup: (token, password) => invoke("unlock_backup", { token, password }),
    planMerge: (token) => invoke("plan_merge", { token }),
    mergeBackup: (token) => invoke("merge_backup", { token }),
    pickBackup: () => invoke("pick_backup"),
    restoreBackup: (token) => invoke("restore_backup", { token }),
    discardPickedBackup: (token) => invoke("discard_picked_backup", { token }),
    setFavorite: (recordId, favorite, expectedRevision) => invoke("set_favorite", { recordId, favorite, expectedRevision: expectedRevision ?? null }),
    setRecordTags: (recordId, tagIds, expectedRevision) => invoke("set_record_tags", { recordId, tagIds, expectedRevision: expectedRevision ?? null }),
    listTags: () => invoke("list_tags"),
    createTag: (name) => invoke("create_tag", { name }),
    renameTag: (tagId, name) => invoke("rename_tag", { tagId, name }),
    mergeTags: (fromTagId, intoTagId) => invoke("merge_tags", { fromTagId, intoTagId }),
    deleteTag: (tagId) => invoke("delete_tag", { tagId }),
    tagImpact: (tagId) => invoke("tag_impact", { tagId }),
    timelinePage: (filter, cursor, limit) => invoke("timeline_page", { filter: wireFilter(filter), cursor, limit, today: localToday() }),
    timelineMonths: (filter) => invoke("timeline_months", { filter: wireFilter(filter) }),
    calendarMonth: (year, month, filter) => invoke("calendar_month", { year, month, filter: wireFilter(filter ?? {}) }),
    dayEntries: (date, order) => invoke("day_entries", { date, order: order ?? "desc", today: localToday() }),
    onThisDay: (month, day, today) => invoke("on_this_day", { month, day, today: today ?? localToday() }),
  };
}

/** 统一成 Rust 端固定形状（缺省字段补齐）。 */
function wireFilter(f: TimelineFilter): Required<Omit<TimelineFilter, "from" | "to" | "hasPhoto">> & Pick<TimelineFilter, "from" | "to" | "hasPhoto"> {
  return { from: f.from ?? null, to: f.to ?? null, favoriteOnly: f.favoriteOnly ?? false, tagIds: f.tagIds ?? [], hasPhoto: f.hasPhoto ?? null, order: f.order ?? "desc" };
}

export function tauriInvokeFromWindow(): InvokeFn | null {
  const w = window as unknown as { __TAURI__?: { core?: { invoke?: InvokeFn } } };
  return w.__TAURI__?.core?.invoke ?? null;
}
