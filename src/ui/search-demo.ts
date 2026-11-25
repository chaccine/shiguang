import type { DraftFields } from "../platform/api.ts";
import type { MemoryAdapter } from "../platform/memory-adapter.ts";
import { MINT_SVG, ORANGE_SVG, RAIN_SVG } from "../platform/synthetic-media.ts";

/** Explicit developer preview only; never share or clear the ordinary preview store. */
export const SEARCH_DEMO_STORAGE_KEY = "shiguang.preview.unit012.search";
export type SearchDemoMode = "mixed" | "empty";
export const SEARCH_DEMO_LITERAL = '<script>alert("search-demo")</script>';

export function searchDemoMode(params: URLSearchParams, native: boolean): SearchDemoMode | null {
  const mode = params.get("searchDemo");
  return !native && (mode === "mixed" || mode === "empty") ? mode : null;
}

/** Fixed, advancing audit timestamps make IDs, ties and fixture contents reproducible. */
export function searchDemoClock(): () => string {
  let tick = Date.UTC(2026, 10, 25);
  return () => new Date(tick += 1000).toISOString();
}

export interface SearchDemoManifest {
  records: Record<string, string>;
  tags: Record<string, string>;
  formalCount: number;
}

/**
 * Entirely fictional text and locally authored SVG bytes, through the normal preview API.
 * The caller must opt in through searchDemoMode and provide an empty isolated MemoryAdapter.
 * This function does not touch localStorage directly, inspect files or call a native API.
 */
export async function seedSearchDemo(adapter: MemoryAdapter, mode: SearchDemoMode): Promise<SearchDemoManifest> {
  const [formal, drafts, trash, tags] = await Promise.all([
    adapter.listFormalRecords(), adapter.listDrafts(), adapter.listTrash(), adapter.listTags(),
  ]);
  if (formal.length || drafts.length || trash.length || tags.length) {
    throw new Error("搜索演示只可写入空的独立合成预览库");
  }
  const manifest: SearchDemoManifest = { records: {}, tags: {}, formalCount: 0 };
  if (mode === "empty") return manifest;

  for (const name of ["旅行", "朋友", "星河主题"]) {
    manifest.tags[name] = (await adapter.createTag(name)).tagId;
  }
  const encoder = new TextEncoder();
  const create = async (key: string, fields: DraftFields, options: {
    photos?: Array<{ svg: string; caption: string }>;
    tags?: string[];
    favorite?: boolean;
    hidden?: boolean;
  } = {}): Promise<string> => {
    const row = (await adapter.createDraft(fields)).row;
    manifest.records[key] = row.recordId;
    for (const [index, photo] of (options.photos ?? []).entries()) {
      await adapter.attachPhotoBytes({ recordId: row.recordId, fileName: `synthetic-search-${index}.svg`,
        bytes: encoder.encode(photo.svg), caption: photo.caption, mediaType: "image/svg+xml" });
    }
    await adapter.commitRecord(row.recordId, row.baseRevision);
    if (options.tags?.length) await adapter.setRecordTags(row.recordId, options.tags.map(name => manifest.tags[name]!), 0);
    if (options.favorite) await adapter.setFavorite(row.recordId, true, 0);
    if (options.hidden) await adapter.setMuseumHidden(row.recordId, true);
    manifest.formalCount++;
    return row.recordId;
  };

  const title = await create("title", {
    title: "合成：海边旅行的青苔书签", body: "这是一条虚构的正式记录。把小小的纸片夹进书里，留住温柔的午后。",
    eventDate: "2024-02-29", eventTime: "09:20",
  }, { tags: ["旅行"], favorite: true, photos: [{ svg: MINT_SVG, caption: "合成：窗边绿意" }] });
  await adapter.saveDraft({ recordId: title, body: "草稿专属未发布：这段修改不能被搜索或珍藏快捷操作发布。", location: "草稿专属地点" });

  await create("body", {
    title: "", body: "这是虚构的旅途手记。".repeat(24) + "慢车经过最后一站，旅行的故事写在这一段正文深处。",
    eventDate: "2024-03-01", eventTime: null,
  }, { tags: ["朋友"], favorite: true });
  await create("caption", {
    title: "", body: "", eventDate: "2024-03-02", eventTime: "18:30",
  }, { tags: ["旅行", "朋友"], favorite: true, photos: [
    { svg: ORANGE_SVG, caption: "合成：橘色窗影（封面）" },
    { svg: RAIN_SVG, caption: "玻璃倒影中的旅行纸票（第二张图片的说明）" },
  ] });
  await create("location", {
    title: "合成：等风来", body: "旅行途中，停下来等一阵风。", location: "海风车站",
    eventDate: "2024-03-03", eventTime: null,
  }, { tags: ["旅行"], photos: [{ svg: RAIN_SVG, caption: "合成：静静的街口" }] });
  await create("tag", {
    title: "合成：旧日灯影", body: "这是一段只通过主题标签找到的虚构回忆。", eventDate: "2023-12-01",
  }, { tags: ["星河主题"] });
  await create("literal", {
    title: "合成：字面字符卡",
    body: `以下字符只是合成正文：${SEARCH_DEMO_LITERAL} [a-z]+ .* ^$ \\d (x|y) %_ <img src=x onerror=alert(1)>。`,
    eventDate: "2024-04-01",
  });
  await create("hidden", {
    title: "合成：暂时不推荐的回忆", body: "旅行时的隐蔽小径。此条已设为博物馆暂时不看，主动查找仍可找到。",
    eventDate: "2024-03-04",
  }, { tags: ["旅行"], favorite: true, hidden: true });
  await create("outsideDate", {
    title: "合成：旧时旅行", body: "旅行旧事留在日期范围之外。", eventDate: "2023-01-01",
  }, { tags: ["旅行"], favorite: true, photos: [{ svg: MINT_SVG, caption: "合成：旧时绿意" }] });
  await create("notFavorite", {
    title: "合成：不含照片的旅行", body: "旅行回来，只用文字写下一小段记忆。", eventDate: "2024-03-05",
  }, { tags: ["朋友"] });
  await create("future", {
    title: "合成：未来时光", body: "写给未来的合成约定。", eventDate: "2099-01-01",
  });

  for (let i = 1; i <= 22; i++) {
    const n = String(i).padStart(2, "0");
    await create(`page${n}`, { title: `合成：分页札记 ${n}`, body: `分页集合 ${n}。一页一页翻阅合成的日常片段。`, eventDate: `2022-01-${n}` },
      i % 4 === 0 ? { photos: [{ svg: ORANGE_SVG, caption: `合成：分页插图 ${n}` }] } : {});
  }
  manifest.records.draftOnly = (await adapter.createDraft({ title: "合成：只在草稿箱", body: "纯草稿线索不能出现在正式搜索结果。", eventDate: "2024-03-02" })).row.recordId;
  const trashed = await create("trash", { title: "合成：回收站里的纸片", body: "回收站线索不应进入有效正式结果。", eventDate: "2024-03-02" });
  await adapter.trashRecord(trashed);
  manifest.formalCount--;
  return manifest;
}
