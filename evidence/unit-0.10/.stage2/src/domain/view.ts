import type { CommitResult, RecordRow, Snapshot } from "./types.ts";

export interface FormalListItem {
  recordId: string;
  contentRevision: number;
  title: string;
  body: string;
  eventDate: string;
  eventTime: string | null;
  photos: Snapshot["photos"];
  location: Snapshot["location"];
  mood: Snapshot["mood"];
  coverPhotoUseId: Snapshot["coverPhotoUseId"];
  /** 存在未提交修改草稿时为 true；列表仍显示旧正式内容。 */
  hasPendingDraft: boolean;
}

/**
 * 正式列表投影：只读取 formal 快照，草稿永不可见。
 * 排序：eventDate 倒序 → committedAt 倒序 → recordId 倒序。
 */
export function formalItems(rows: readonly RecordRow[]): FormalListItem[] {
  return rows
    .filter((row): row is RecordRow & { formal: Snapshot } => row.status === "active" && row.formal !== null)
    .sort((a, b) => {
      if (a.formal.eventDate !== b.formal.eventDate) {
        return b.formal.eventDate.localeCompare(a.formal.eventDate);
      }
      const left = a.committedAt ?? "";
      const right = b.committedAt ?? "";
      if (left !== right) return right.localeCompare(left);
      return b.recordId.localeCompare(a.recordId);
    })
    .map((row) => ({
      recordId: row.recordId,
      contentRevision: row.contentRevision,
      title: row.formal.title,
      body: row.formal.body,
      eventDate: row.formal.eventDate,
      eventTime: row.formal.eventTime,
      photos: row.formal.photos,
      location: row.formal.location,
      mood: row.formal.mood,
      coverPhotoUseId: row.formal.coverPhotoUseId,
      hasPendingDraft: row.draft !== null,
    }));
}

/** 阅读正式版：即使存在修改草稿，也只返回已提交快照。 */
export function readFormal(row: RecordRow): Snapshot | null {
  return row.formal;
}

/** 提交后 revision 递增；前端只做展示推演，权威值来自 Rust 返回。 */
export function nextRevision(row: Pick<RecordRow, "contentRevision">): number {
  return row.contentRevision + 1;
}

export function applyCommit(row: RecordRow, result: CommitResult): RecordRow {
  const committed = row.draft;
  if (committed === null) {
    throw new Error("没有待提交的草稿");
  }
  return {
    ...row,
    contentRevision: result.contentRevision,
    committedAt: result.committedAt,
    updatedAt: result.committedAt,
    baseRevision: result.contentRevision,
    formal: committed,
    draft: null,
  };
}
