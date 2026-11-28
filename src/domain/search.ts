/** M05 disposable projection. Cursor fingerprints are derived from authoritative
 * formal content, never draft snapshots, indexes, clocks or revision counters alone. */
import type { RecordRow, SearchFilter, SearchPage, TagDef } from "./types.ts";
import { isSimple } from "./story.ts";
import { isValidDate } from "./rules.ts";
import { decodeCursor, isFormalActive, pageRows, sortedFormal } from "./timeline.ts";
import { sha256 } from "../platform/bytes.ts";

const encoder = new TextEncoder();
const hash = (text: string) => sha256(encoder.encode(text));
const asciiLower = (text: string) => text.replace(/[A-Z]/g, c => c.toLowerCase());
const fail = (code: string, message: string): never => { throw { code, message }; };
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function normalizeSearchFilter(filter: SearchFilter): Required<SearchFilter> {
  const f = { keyword: asciiLower((filter.keyword ?? "").trim()), from: filter.from || null, to: filter.to || null,
    favoriteOnly: filter.favoriteOnly ?? false, tagIds: [...new Set(filter.tagIds ?? [])].sort(),
    hasPhoto: filter.hasPhoto ?? null, order: filter.order ?? "desc" };
  if ((f.from !== null && !isValidDate(f.from)) || (f.to !== null && !isValidDate(f.to)) || (f.from && f.to && f.from > f.to)) {
    fail("INVALID_EVENT_DATE", "请使用真实日期，开始日期不能晚于结束日期");
  }
  if (f.order !== "asc" && f.order !== "desc") fail("INVALID_SEARCH_FILTER", "排序需为 asc 或 desc");
  return f;
}

/** All search-visible data, including nonmatching rows (which may start matching
 * after mutation). Draft/hidden changes are irrelevant to this projection. */
function sourceGeneration(rows: readonly RecordRow[], tags: readonly TagDef[]): string {
  const chunks = rows.filter(isFormalActive).sort((a,b) => cmp(a.recordId,b.recordId)).map(r => {
    const f = r.formal;
    const source: unknown[] = [r.recordId,r.createdAt,r.contentRevision,r.favorite,r.favoriteRevision,r.tagIds,r.tagRevision,
      [f.title,f.body,f.eventDate,f.eventTime,f.location,f.mood,f.coverPhotoUseId,
        f.photos.map(p => [p.photoUseId,p.assetId,p.caption,p.sha256,p.bytes,p.mediaType])]];
    if (f.story && (!isSimple(f.story) || f.story.blocks.some(b =>
      b.kind === "paragraph" && (b.runs.length !== 1 || !b.runs[0].text)))) source.push(f.story);
    return JSON.stringify(source) + "\n";
  });
  chunks.push(JSON.stringify([...tags].sort((a,b) => cmp(a.tagId,b.tagId)).map(t => [t.tagId,t.name])));
  return hash(chunks.join(""));
}

export function searchPage(rows: readonly RecordRow[], tags: readonly TagDef[], filter: SearchFilter,
  cursor: string | null, limit: number, today: string): SearchPage {
  const f = normalizeSearchFilter(filter);
  if (!isValidDate(today)) fail("INVALID_EVENT_DATE", "日期无效");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail("INVALID_LIMIT", "每页条数需在 1–500 之间");
  const queryKey = hash(JSON.stringify([f.keyword,f.from,f.to,f.favoriteOnly,f.tagIds,f.hasPhoto,f.order,today]));
  let inner: string | null = null, generation: string | null = null;
  if (cursor !== null) {
    let decoded: unknown;
    try { if (cursor.length > 32768) throw new Error(); decoded = JSON.parse(cursor); }
    catch { fail("INVALID_CURSOR", "分页位置无效，请从第一页重新查找"); }
    if (!Array.isArray(decoded) || decoded.length !== 4 || decoded[0] !== "sg12" || decoded.some(v => typeof v !== "string")) {
      fail("INVALID_CURSOR", "分页位置无效，请从第一页重新查找");
    }
    const data = decoded as string[];
    if (data[1] !== queryKey) fail("SEARCH_CURSOR_MISMATCH", "查找条件已改变，请从第一页重新查找");
    generation = data[2]!; inner = data[3]!;
    decodeCursor(inner);
  }
  const source = sourceGeneration(rows, tags);
  if (generation !== null && generation !== source) fail("SEARCH_CURSOR_STALE", "正式内容或标签已更新，请从第一页重新查找");
  const names = new Map(tags.map(t => [t.tagId,asciiLower(t.name)]));
  const contains = (text: string) => asciiLower(text).includes(f.keyword);
  const seen = new Set<string>();
  const matched = sortedFormal(rows, f).filter(r => {
    const s = r.formal;
    if (f.keyword && !(contains(s.title) || contains(s.body) || contains(s.location)
      || s.photos.some(p => contains(p.caption)) || r.tagIds.some(id => names.get(id)?.includes(f.keyword)))) return false;
    if (seen.has(r.recordId)) return false;
    seen.add(r.recordId); return true;
  });
  const page = pageRows(matched, f.order, inner, limit, today);
  return { ...page, nextCursor: page.nextCursor === null ? null : JSON.stringify(["sg12",queryKey,source,page.nextCursor]),
    queryKey, sourceGeneration: source };
}
