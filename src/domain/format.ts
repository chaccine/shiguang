import type { Durability, Snapshot } from "./types.ts";

export function durabilityLabel(d: Durability): string {
  switch (d) {
    case "durable": return "已保存";
    case "parentSyncUnsupported": return "已保存（系统未提供目录同步确认）";
    case "uncertain": return "已保存，但系统未确认写入磁盘";
  }
}

/** 时刻缺失时只输出日期，绝不补 00:00 或任何伪造时刻。 */
export function formatEventWhen(snapshot: Pick<Snapshot, "eventDate" | "eventTime">): string {
  const date = snapshot.eventDate.trim();
  if (date.length === 0) return "日期未填写";
  const time = snapshot.eventTime?.trim() ?? "";
  return time.length > 0 ? `${date} ${time}` : date;
}

/** 正式列表/时间轴使用的展示文案；草稿不参与。 */
export function formalHeadline(snapshot: Pick<Snapshot, "title" | "body">): string {
  const title = snapshot.title.trim();
  if (title.length > 0) return title;
  const body = snapshot.body.trim().replace(/\s+/g, " ");
  if (body.length === 0) return "（无题）";
  return body.length > 40 ? `${body.slice(0, 40)}…` : body;
}
