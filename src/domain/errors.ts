export interface ErrorDescription {
  title: string;
  detail: string;
  kind: "conflict" | "durability" | "validation" | "io" | "unknown";
}

const validation: Record<string, string> = {
  LOCATION_TOO_LONG: "地点最多 200 个字符，当前输入仍保留。",
  MOOD_INVALID: "请选择列表中的心情，或留空。",
  COVER_PHOTO_INVALID: "封面必须是当前记录中的照片，请重新选择。",
  PHOTO_ORDER_INVALID: "请提供所有照片的顺序，不能重复或遗漏。",
  THEME_INVALID: "主题必须为 light、dark 或 system。",
  APP_LOCK_CODE_INVALID: "应用锁密码须为 4–8 位数字。",
  APP_LOCK_WRONG: "应用锁密码不正确，请重试。",
  APP_LOCK_THROTTLED: "尝试次数过多，请等待后再试。关闭和重新打开应用不会清除等待。",
  APP_LOCK_ALREADY_SET: "应用锁已启用，更改密码需要当前密码。",
  APP_LOCK_NOT_SET: "应用锁尚未启用。",
  APP_LOCK_CHANGED: "应用锁状态已改变，请重新尝试。",
  APP_LOCK_CRYPTO_FAILED: "应用锁操作未完成，请重试。",
  APP_LOCK_INTERNAL: "应用锁或设置操作未完成，请重试。",
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
  RECORD_TRASHED: "这条记录已在回收站，请先恢复后再编辑或存入时光。",
  RECORD_DELETED: "这条记录已被永久删除，不能再次编辑或恢复。",
  RECORD_NOT_TRASHED: "只有回收站中的记录可以永久删除，请先移到回收站。",
  RECORD_NOT_FORMAL: "这条记录还是草稿，只有存入时光的正式记录可以移到回收站。",
  DRAFT_OCCUPIED: "这条记录已有草稿，请先处理现有草稿，再恢复冲突副本。",
  CONFLICT_NOT_FOUND: "找不到这份冲突副本，请重新打开冲突副本列表。",
  INVALID_CONFLICT_CHOICE: "请选择以我的草稿为准，或保留当前正式版。",
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
  const storeErrors: Record<string, string> = {
    STORE_LOCKED: "拾光已在另一个窗口或程序中打开。为保护你的数据，这里暂不能写入，请先关闭另一个窗口再重新打开。",
    STORE_BUSY: "另一个拾光窗口正在写入，请稍后重试；你的输入未丢失。",
    SCHEMA_TOO_NEW: "这份数据由更新版本的拾光写入，当前版本无法安全读取。请升级拾光；原数据未改动。",
    SCHEMA_CHANGED_ON_DISK: "数据结构已被另一个程序更改，请重新打开拾光；原数据未改动。",
    STORE_NOT_EXCLUSIVE: "请先关闭其他拾光窗口，再重新打开以检查照片；原数据未改动。",
  };
  if (storeErrors[code]) return { kind: "io", title: "暂时无法打开或写入数据", detail: storeErrors[code] + diagnostic };
  const backupErrors: Record<string, [string, string]> = {
    BACKUP_INVALID: ["这不是可用的拾光备份", "所选文件不是拾光备份，或文件结构已损坏。当前数据没有任何改动。"],
    BACKUP_TRUNCATED: ["备份文件不完整", "文件可能在拷贝或下载时中断，请重新拷贝完整的备份文件。当前数据没有任何改动。"],
    BACKUP_CORRUPT: ["备份文件已损坏或被修改", "校验和不一致，为保护你的数据已拒绝恢复。当前数据没有任何改动。"],
    BACKUP_SCHEMA_TOO_NEW: ["备份来自更新版本的拾光", "请先把拾光升级到新版本再恢复这份备份。当前数据没有任何改动。"],
    BACKUP_FORMAT_TOO_NEW: ["备份格式来自更新版本的拾光", "请先升级拾光再恢复。当前数据没有任何改动。"],
    BACKUP_ENCRYPTED_UNSUPPORTED: ["不支持的加密方式", "这份备份使用了当前版本不认识的加密方式。当前数据没有任何改动。"],
    BACKUP_PASSWORD_REQUIRED: ["需要口令", "这是加密备份，请输入导出时设置的口令。当前数据没有任何改动。"],
    BACKUP_PASSWORD_WRONG: ["口令不正确，或文件已损坏", "无法解开这份加密备份：口令错误，或文件被修改/损坏。当前数据没有任何改动。"],
    BACKUP_PASSWORD_EMPTY: ["请设置口令", "勾选了加密就需要设置口令；不想加密请取消勾选。"],
    BACKUP_KDF_PARAMS_INVALID: ["备份的加密参数无效", "这份加密备份的参数超出安全范围或已损坏，已拒绝打开。当前数据没有任何改动。"],
    MERGE_FAILED: ["合并没有完成", "合并过程中出错，已回到合并前的状态。当前数据没有任何改动。"],
    BACKUP_TOKEN_INVALID: ["请重新选择备份文件", "之前选择的备份已失效（可能应用重启过）。当前数据没有任何改动。"],
    BACKUP_DEST_EXISTS: ["目标位置已有同名文件", "请换一个文件名或位置再导出。"],
    BACKUP_SOURCE_CHANGED: ["导出时数据发生了变化", "为保证备份一致，这次导出已取消，请重试。当前数据没有任何改动。"],
    BACKUP_WRITE_FAILED: ["备份没有写完", "可能是空间不足或没有写入权限；未生成不完整的备份文件，当前数据没有任何改动。"],
    BACKUP_IO_FAILED: ["备份文件读写失败", "请检查所选位置是否可访问、空间是否充足后重试。当前数据没有任何改动。"],
    RESTORE_SAFETY_BACKUP_FAILED: ["无法先保存当前数据的安全副本", "为了不丢数据，恢复已取消。请检查可用空间后重试。当前数据没有任何改动。"],
    RESTORE_FAILED: ["恢复没有完成，已回到恢复前的数据", "切换过程中出错，已整体回滚，现有数据保持原样。"],
  };
  if (backupErrors[code]) {
    const [title, detail] = backupErrors[code]!;
    return { kind: "io", title, detail: `${detail}${diagnostic}` };
  }
  if (code.startsWith("MIGRATION_")) {
    const detail = code === "MIGRATION_BACKUP_FAILED"
      ? "迁移前备份未完成，原数据未改动。请检查可用空间与目录权限后重新打开。"
      : "数据迁移未完成，原数据未改动。请保留数据目录与迁移备份，检查后重新打开。";
    return { kind: "io", title: "数据升级没有完成", detail: `${detail}${diagnostic} ${raw}` };
  }
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
