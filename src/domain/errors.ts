export interface ErrorDescription {
  title: string;
  detail: string;
  kind: "conflict" | "durability" | "validation" | "io" | "unknown";
}

const validation: Record<string, string> = {
  EMPTY_CONTENT: "写下一点正文，或附上一张照片后，就可以存入时光。仅填写标题还不够。",
  MISSING_EVENT_DATE: "请填写这段回忆发生的日期。时刻可以留空。",
  INVALID_EVENT_DATE: "请填写真实的日期，格式为 YYYY-MM-DD。当前输入仍保留在本地编辑区。",
  INVALID_EVENT_TIME: "请使用 HH:MM 格式填写时刻，也可以留空。当前输入仍保留在本地编辑区。",
  EMPTY_ASSET: "这张照片没有内容，请重新选择。",
  ASSET_TOO_LARGE: "这张照片超过 25MB，请选择较小的文件。",
  PREVIEW_TOO_LARGE: "原图超过 8MB，暂时无法显示内嵌预览，原图仍保留。",
  INVALID_ASSET_BYTES: "照片字节无效，请重新选择照片。",
  SESSION_BUSY: "当前草稿仍有未保存的内容，请先保存；发生冲突时请先保留本地副本并核对版本。",
  INVALID_ASSET_NAME: "请提供照片文件名，文件名中不能包含路径。",
  PHOTO_USE_NOT_FOUND: "草稿中已没有这张照片，请重新查看草稿。",
  NOT_FOUND: "找不到这条记录，请重新打开草稿列表。当前编辑内容仍保留。",
  NO_DRAFT: "没有待保存或提交的草稿，请先打开或编辑一条草稿。",
  BASE_NOT_FORMAL: "只能基于已存入时光的记录创建修改草稿。",
};

/** 保留原始错误码/阶段以便排查；未知错误也明确展示，绝不转为成功。 */
export function describeError(error: unknown): ErrorDescription {
  const value = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const code = typeof value.code === "string" ? value.code : typeof error === "string" ? error : "";
  if (code === "uncertain" || value.durability === "uncertain") {
    return { kind: "durability", title: "写入已完成，落盘尚未确认", detail: "已写入，但系统没有确认落盘；请暂时不要断电，稍后可再次保存。" };
  }
  if (code === "parentSyncUnsupported" || value.durability === "parentSyncUnsupported") {
    return { kind: "durability", title: "已保存", detail: "系统未提供目录同步确认。" };
  }
  const raw = typeof value.message === "string" ? value.message : error instanceof Error ? error.message : String(error);
  const diagnostic = code ? `（${code}${typeof value.stage === "string" ? ` / ${value.stage}` : ""}）` : "";
  if (code === "REVISION_CONFLICT") {
    return { kind: "conflict", title: "这段回忆已在别处更新", detail: `本地草稿已保留，未覆盖正式版。请核对两个版本后再决定如何处理。${diagnostic}` };
  }
  if (validation[code]) return { kind: "validation", title: "还需要调整一下", detail: validation[code] + diagnostic };
  if (code === "STATE_CORRUPT" || code === "STATE_VERSION_UNSUPPORTED") {
    return { kind: "io", title: "暂时无法读取保存的数据", detail: `原文件没有被覆盖，请保留数据目录以便检查。当前编辑内容仍保留。${diagnostic}` };
  }
  if (/^PERSIST_.*_FAILED$/.test(code) || code === "STATE_SERIALIZE_FAILED") {
    return { kind: "io", title: "这次保存没有完成", detail: `当前编辑内容仍保留，请检查可用空间与目录权限后重试。${diagnostic} ${raw}` };
  }
  if (code.startsWith("ASSET_")) {
    return { kind: "io", title: "暂时无法使用这张照片", detail: `原图可能缺失、无法读取或与记录不一致。正式记录未被覆盖，请检查原图后重试。${diagnostic} ${raw}` };
  }
  if (code === "IO_ERROR" || code === "STORE_LOCK_FAILED") {
    return { kind: "io", title: "读写暂时没有完成", detail: `当前编辑内容仍保留，请稍后重试。${diagnostic} ${raw}` };
  }
  return { kind: "unknown", title: "操作未完成", detail: `请保留当前编辑内容并重试。${diagnostic} ${raw}` };
}
