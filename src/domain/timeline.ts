/**
 * Unit-0.7 衍生视图（纯函数，与 Rust core query 同语义）：时光轴分页、年月导航、日历计数、当天、那年今日。
 * 只读正式记录（status=active 且 formal 存在）；草稿永不参与（M02-T09 / M03-C07）。
 * 排序 = M02 B02：发生日期按方向；同日有时刻组在前、无时刻组在后（两个方向都如此）；
 * 有时刻组按时刻（同方向）；同时刻/无时刻按 createdAt（同方向），最后 recordId（同方向）。
 */
import type { CalendarDay, MonthCount, OnThisDayGroup, RecordRow, Snapshot, SortOrder, TimelineFilter, TimelineItem, TimelinePage } from "./types.ts";

type FormalRow = RecordRow & { formal: Snapshot };

export function isFormalActive(row: RecordRow): row is FormalRow {
  return row.status === "active" && row.formal !== null;
}

interface SortKey { date: string; hasTime: boolean; time: string; createdAt: string; id: string }

function keyOf(row: FormalRow): SortKey {
  const time = row.formal.eventTime?.trim() ?? "";
  return { date: row.formal.eventDate, hasTime: time.length > 0, time, createdAt: row.createdAt, id: row.recordId };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 负数 = a 排在 b 前。 */
export function compareKeys(a: SortKey, b: SortKey, order: SortOrder): number {
  const dir = order === "asc" ? 1 : -1;
  const d = cmp(a.date, b.date);
  if (d !== 0) return d * dir;
  if (a.hasTime !== b.hasTime) return a.hasTime ? -1 : 1; // 有时刻组永远在前
  if (a.hasTime) {
    const t = cmp(a.time, b.time);
    if (t !== 0) return t * dir;
  }
  const c = cmp(a.createdAt, b.createdAt);
  if (c !== 0) return c * dir;
  return cmp(a.id, b.id) * dir;
}

export function compareRows(a: FormalRow, b: FormalRow, order: SortOrder = "desc"): number {
  return compareKeys(keyOf(a), keyOf(b), order);
}

export function excerptOf(body: string, limit = 80): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export function toItem(row: FormalRow, today: string): TimelineItem {
  const f = row.formal;
  return {
    recordId: row.recordId, eventDate: f.eventDate, eventTime: f.eventTime?.trim() ? f.eventTime : null,
    title: f.title.trim(), excerpt: excerptOf(f.body), cover: f.photos[0] ?? null, photoCount: f.photos.length,
    favorite: row.favorite ?? false, favoriteRevision: row.favoriteRevision ?? 0,
    tagIds: [...(row.tagIds ?? [])], tagRevision: row.tagRevision ?? 0, createdAt: row.createdAt,
    isFuture: f.eventDate > today,
  };
}

export function matchesFilter(row: FormalRow, filter: TimelineFilter): boolean {
  const date = row.formal.eventDate;
  if (filter.from && date < filter.from) return false;
  if (filter.to && date > filter.to) return false;
  if (filter.favoriteOnly && !row.favorite) return false;
  if (filter.tagIds && filter.tagIds.length > 0 && !(row.tagIds ?? []).some((t) => filter.tagIds!.includes(t))) return false;
  if (filter.hasPhoto === true && row.formal.photos.length === 0) return false;
  if (filter.hasPhoto === false && row.formal.photos.length > 0) return false;
  return true;
}

export function sortedFormal(rows: readonly RecordRow[], filter: TimelineFilter = {}): FormalRow[] {
  const order = filter.order ?? "desc";
  return rows.filter(isFormalActive).filter((r) => matchesFilter(r, filter)).sort((a, b) => compareRows(a, b, order));
}

/** 游标 = 最后一项完整排序键（不透明字符串）；数据变化后续翻也不重复、不跳过尚未经过的项。 */
export function encodeCursor(k: SortKey): string {
  return JSON.stringify([k.date, k.hasTime ? 1 : 0, k.time, k.createdAt, k.id]);
}
export function decodeCursor(cursor: string): SortKey {
  let v: unknown;
  try { v = JSON.parse(cursor); } catch { throw { code: "INVALID_CURSOR", message: "翻页位置无效，请回到顶部重新加载" }; }
  if (!Array.isArray(v) || v.length !== 5 || typeof v[0] !== "string" || (v[1] !== 0 && v[1] !== 1)
    || typeof v[2] !== "string" || typeof v[3] !== "string" || typeof v[4] !== "string") {
    throw { code: "INVALID_CURSOR", message: "翻页位置无效，请回到顶部重新加载" };
  }
  return { date: v[0], hasTime: v[1] === 1, time: v[2], createdAt: v[3], id: v[4] };
}

export function timelinePage(rows: readonly RecordRow[], filter: TimelineFilter, cursor: string | null, limit: number, today: string): TimelinePage {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw { code: "INVALID_LIMIT", message: "每页条数需在 1–500 之间" };
  const order = filter.order ?? "desc";
  const all = sortedFormal(rows, filter);
  let start = 0;
  if (cursor) {
    const after = decodeCursor(cursor);
    // 二分：第一个严格排在游标之后的位置。
    let lo = 0, hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareKeys(keyOf(all[mid]!), after, order) <= 0) lo = mid + 1; else hi = mid;
    }
    start = lo;
  }
  const slice = all.slice(start, start + limit);
  const last = slice[slice.length - 1];
  const nextCursor = last && start + limit < all.length ? encodeCursor(keyOf(last)) : null;
  return { items: slice.map((r) => toItem(r, today)), nextCursor, total: all.length };
}

export function timelineMonths(rows: readonly RecordRow[], filter: TimelineFilter = {}): MonthCount[] {
  const map = new Map<string, number>();
  for (const r of sortedFormal(rows, filter)) {
    const ym = r.formal.eventDate.slice(0, 7);
    map.set(ym, (map.get(ym) ?? 0) + 1);
  }
  const out = [...map.entries()].map(([ym, count]) => ({ year: Number(ym.slice(0, 4)), month: Number(ym.slice(5, 7)), count }));
  return (filter.order ?? "desc") === "asc" ? out.sort((a, b) => a.year - b.year || a.month - b.month)
    : out.sort((a, b) => b.year - a.year || b.month - a.month);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function validYearMonth(year: number, month: number): boolean {
  return Number.isInteger(year) && year >= 1 && year <= 9999 && Number.isInteger(month) && month >= 1 && month <= 12;
}

export function calendarMonth(rows: readonly RecordRow[], year: number, month: number, filter: TimelineFilter = {}): CalendarDay[] {
  if (!validYearMonth(year, month)) throw { code: "INVALID_EVENT_DATE", message: "年月无效" };
  const prefix = `${pad(year, 4)}-${pad(month)}-`;
  const map = new Map<string, CalendarDay>();
  for (const r of rows) {
    if (!isFormalActive(r) || !r.formal.eventDate.startsWith(prefix) || !matchesFilter(r, filter)) continue;
    const d = map.get(r.formal.eventDate) ?? { date: r.formal.eventDate, count: 0, photoCount: 0, hasFavorite: false };
    d.count += 1; d.photoCount += r.formal.photos.length; d.hasFavorite ||= Boolean(r.favorite);
    map.set(r.formal.eventDate, d);
  }
  return [...map.values()].sort((a, b) => cmp(a.date, b.date));
}

export function dayEntries(rows: readonly RecordRow[], date: string, order: SortOrder, today: string): TimelineItem[] {
  return sortedFormal(rows, { from: date, to: date, order }).map((r) => toItem(r, today));
}

/** 往年同月同日；2-29 只匹配闰年 2-29（不挪到 2-28）。按年倒序。 */
export function onThisDay(rows: readonly RecordRow[], month: number, day: number, today: string): OnThisDayGroup[] {
  const md = `-${pad(month)}-${pad(day)}`;
  const thisYear = Number(today.slice(0, 4));
  const groups = new Map<number, TimelineItem[]>();
  for (const r of sortedFormal(rows, { order: "desc" })) {
    const y = Number(r.formal.eventDate.slice(0, 4));
    if (!r.formal.eventDate.endsWith(md) || y >= thisYear) continue;
    const list = groups.get(y) ?? [];
    list.push(toItem(r, today));
    groups.set(y, list);
  }
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([year, items]) => ({ year, items }));
}

// ---- 纯 UI 辅助 ----
export interface DayGroup { date: string; items: TimelineItem[] }
export interface MonthGroup { year: number; month: number; days: DayGroup[] }
export interface YearGroup { year: number; months: MonthGroup[] }

/** 已按顺序排好的条目 → 年 / 月 / 日分组（保持输入顺序，不重排）。 */
export function groupByYmd(items: readonly TimelineItem[]): YearGroup[] {
  const years: YearGroup[] = [];
  for (const item of items) {
    const y = Number(item.eventDate.slice(0, 4)), m = Number(item.eventDate.slice(5, 7));
    let yg = years[years.length - 1];
    if (!yg || yg.year !== y) { yg = { year: y, months: [] }; years.push(yg); }
    let mg = yg.months[yg.months.length - 1];
    if (!mg || mg.month !== m) { mg = { year: y, month: m, days: [] }; yg.months.push(mg); }
    let dg = mg.days[mg.days.length - 1];
    if (!dg || dg.date !== item.eventDate) { dg = { date: item.eventDate, items: [] }; mg.days.push(dg); }
    dg.items.push(item);
  }
  return years;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 周一起始的月历网格：42 格（6 周），不在本月的格子为 null。纯日历运算，不涉及时区。 */
export function calendarGrid(year: number, month: number): Array<string | null> {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=周日
  const lead = (first + 6) % 7;
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= daysInMonth(year, month); d++) cells.push(`${pad(year, 4)}-${pad(month)}-${pad(d)}`);
  while (cells.length < 42) cells.push(null);
  return cells;
}

export function countLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/** 设备本地日期 YYYY-MM-DD（按发生日期的日历日期投影，不做 UTC 转换）。 */
export function localToday(now: Date = new Date()): string {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
