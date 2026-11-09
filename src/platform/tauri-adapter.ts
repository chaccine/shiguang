import type { CommitResult, RecordRow } from "../domain/types.ts";

/** Tauri v2 命令契约；命令实现在 src-tauri/src/lib.rs，领域权威在 Rust core。 */
export interface ShiguangApi {
  createDraft(input: {
    title?: string;
    body?: string;
    eventDate?: string;
    eventTime?: string | null;
    baseRecordId?: string | null;
  }): Promise<RecordRow>;
  saveDraft(input: {
    recordId: string;
    title?: string;
    body?: string;
    eventDate?: string;
    eventTime?: string | null;
    clearEventTime?: boolean;
  }): Promise<RecordRow>;
  attachPhoto(input: {
    recordId: string;
    sourcePath: string;
    caption: string;
    mediaType?: string | null;
  }): Promise<RecordRow>;
  commitRecord(recordId: string): Promise<CommitResult>;
  listFormalRecords(): Promise<RecordRow[]>;
  getRecord(recordId: string): Promise<RecordRow>;
  exportManifest(outPath: string): Promise<{ out: string; records: number }>;
}

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createTauriApi(invoke: InvokeFn): ShiguangApi {
  return {
    createDraft: (input) => invoke<RecordRow>("create_draft", { input }),
    saveDraft: (input) => invoke<RecordRow>("save_draft", { input }),
    attachPhoto: (input) => invoke<RecordRow>("attach_photo", { input }),
    commitRecord: (recordId) => invoke<CommitResult>("commit_record", { recordId }),
    listFormalRecords: () => invoke<RecordRow[]>("list_formal_records"),
    getRecord: (recordId) => invoke<RecordRow>("get_record", { recordId }),
    exportManifest: (outPath) => invoke("export_manifest", { outPath }),
  };
}

/** 从 window 上解析 Tauri v2 注入的 invoke；不存在则表示桌面壳未运行。 */
export function tauriInvokeFromWindow(): InvokeFn | null {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: InvokeFn } };
  };
  return w.__TAURI__?.core?.invoke ?? null;
}
