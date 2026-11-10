import type { RecordRow } from "../domain/types.ts";
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
      input: { ...input, clearEventTime: input.clearEventTime || input.eventTime === null },
    }),
    attachPhoto: (input) => invoke("attach_photo", { input }),
    attachPhotoBytes: (input) => invoke("attach_photo_bytes", { input: { ...input, bytes: Array.from(input.bytes) } }),
    removeDraftPhoto: (recordId, photoUseId) => invoke("remove_draft_photo", { recordId, photoUseId }),
    discardDraft: (recordId) => invoke("discard_draft", { recordId }),
    commitRecord: (recordId, expectedBaseRevision) => invoke("commit_record", { recordId, expectedBaseRevision }),
    listDrafts: () => invoke("list_drafts"),
    listFormalRecords: () => invoke("list_formal_records"),
    getRecord: (recordId) => invoke("get_record", { recordId }),
    photoDataUrl: (assetId) => invoke("photo_data_url", { assetId }),
    exportManifest: (outPath) => invoke("export_manifest", { outPath }),
  };
}

export function tauriInvokeFromWindow(): InvokeFn | null {
  const w = window as unknown as { __TAURI__?: { core?: { invoke?: InvokeFn } } };
  return w.__TAURI__?.core?.invoke ?? null;
}
