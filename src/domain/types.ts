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

export interface CommitResult {
  recordId: string;
  contentRevision: number;
  committedAt: string;
}
