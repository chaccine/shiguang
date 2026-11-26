import type { UiPreferences } from "./appearance.ts";
import { MemoryAdapter } from "../platform/memory-adapter.ts";
import { base64, sha256 } from "../platform/bytes.ts";
import { MINT_SVG, ORANGE_SVG } from "../platform/synthetic-media.ts";
import { searchDemoClock } from "./search-demo.ts";

type Startup = "disabled" | "enabled" | "slow" | "error";

/** A fresh device in RAM for each explicit URL, including its appearance and navigation hints. */
export function mobilePreview(params: URLSearchParams, native: boolean) {
  const collection = params.get("stage01");
  const photos = params.get("stage23");
  const photoFixture = photos === "simple" || photos === "interleaved" || photos === "shared" ? photos : null;
  if (native || (!photoFixture && collection !== "timeline" && collection !== "empty")) return null;
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  const lock = params.get("lock");
  const startup = lock === "enabled" || lock === "slow" || lock === "error" ? lock : "disabled";
  const values = new Map([["shiguang.theme", theme]]);
  const preferences: UiPreferences = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
  const adapter = new MobilePreviewDevice(startup, photoFixture === "simple");
  return {
    adapter, preferences, filtered: params.get("filters") === "active", panel: params.get("panel") === "open",
    async prepare() {
      await adapter.setTheme(theme);
      if (photoFixture === "interleaved" || photoFixture === "shared") await seedPhotoFixture(adapter, photoFixture);
      else if (!photoFixture && collection === "timeline") await seedTimeline(adapter);
      if (startup !== "disabled") await adapter.setAppLock("0042");
    },
  };
}

class MobilePreviewDevice extends MemoryAdapter {
  private firstCheck: Startup;
  constructor(startup: Startup, legacy: boolean) {
    super({ now: searchDemoClock(), search: "", storage: legacy ? legacyPhotoAlbum() : undefined });
    this.today = () => "2026-11-25";
    this.firstCheck = startup;
  }
  override async getSettings() {
    const check = this.firstCheck;
    this.firstCheck = "disabled";
    if (check === "slow") await new Promise(resolve => setTimeout(resolve, 2400));
    if (check === "error") throw new Error("合成设置读取失败");
    return super.getSettings();
  }
}

/** Source media are the repository's original synthetic color illustrations. */
async function seedTimeline(api: MemoryAdapter) {
  const colors = await api.createTag("色样");
  const type = await api.createTag("排印");
  const samples = [
    { date: "2026-11-21", body: "薄荷的绿，叶尖浅一点。", svg: MINT_SVG, caption: "薄荷色样", tag: colors, favorite: true },
    { date: "2026-11-14", body: "纸上的两行铅字，一行紧凑，一行疏朗。留白也改变了读句子的节奏。", time: "09:15", tag: type, favorite: true },
    { date: "2026-11-14", body: "同日的第二张文字样张。", tag: type },
    { date: "2026-10-23", body: "橘色与赭石。", svg: ORANGE_SVG, caption: "橘色色样", tag: colors, favorite: true },
    { date: "2026-10-08", body: "换一种行距，再读一遍。", tag: type },
  ];
  for (const sample of samples) {
    const { row } = await api.createDraft({ eventDate: sample.date, eventTime: sample.time, body: sample.body });
    if (sample.svg) await api.attachPhotoBytes({ recordId: row.recordId, fileName: "sample.svg",
      mediaType: "image/svg+xml", bytes: new TextEncoder().encode(sample.svg), caption: sample.caption ?? "" });
    await api.commitRecord(row.recordId, row.baseRevision);
    await api.setRecordTags(row.recordId, [sample.tag.tagId], 0);
    if (sample.favorite) await api.setFavorite(row.recordId, true, 0);
  }
}

// Exercise the preview's actual legacy decoder on an isolated v5 body/photos row.
function legacyPhotoAlbum() {
  const assets: Record<string, { dataUrl: string; bytes: number; sha256: string }> = {};
  const photos = [MINT_SVG, ORANGE_SVG].map((svg, index) => {
    const bytes = new TextEncoder().encode(svg), digest = sha256(bytes), assetId = `ast-${digest.slice(0, 16)}`;
    assets[assetId] = { dataUrl: `data:image/svg+xml;base64,${base64(bytes)}`, bytes: bytes.length, sha256: digest };
    return { photoUseId: `pu-00000${index + 2}`, assetId, caption: index ? "橘色色样" : "甲册的薄荷",
      bytes: bytes.length, sha256: digest, mediaType: "image/svg+xml" };
  });
  const at = "2026-11-21T00:00:00Z";
  let raw = JSON.stringify({ version: 1, schemaVersion: 5, seq: 3, assets, deletionMarkers: [], conflictCopies: [],
    settings: { theme: "system", appLock: null }, tags: [], tagDictRevision: 0, tagAliases: [], tagTombstones: [],
    records: [{ recordId: "rec-000001", status: "active", createdAt: at, updatedAt: at, committedAt: at, trashedAt: null,
      contentRevision: 1, baseRevision: 1, draft: null, museumHidden: false, favorite: false, favoriteRevision: 0, tagIds: [], tagRevision: 0,
      formal: { title: "两张色样", eventDate: "2026-11-21", eventTime: null, mood: null, location: "",
        body: "色样册的第一页。", photos, coverPhotoUseId: photos[1].photoUseId } }] });
  return { getItem: () => raw, setItem(_key: string, value: string) { raw = value; } };
}

async function seedPhotoFixture(api: MemoryAdapter, fixture: "interleaved" | "shared") {
  const attach = async (recordId: string, svg: string, caption: string) => {
    const saved = await api.attachPhotoBytes({ recordId, fileName: "sample.svg", mediaType: "image/svg+xml",
      bytes: new TextEncoder().encode(svg), caption });
    return saved.row.draft!.photos.at(-1)!;
  };
  const id = (await api.createDraft({ title: fixture === "shared" ? "色样甲" : "两张色样",
    eventDate: "2026-11-21", body: "色样册的第一页。" })).row.recordId;
  const mint = await attach(id, MINT_SVG, "甲册的薄荷");
  const orange = await attach(id, ORANGE_SVG, "橘色色样");
  await api.setDraftCover(id, orange.photoUseId);
  if (fixture === "interleaved") {
    await api.saveDraft({ recordId: id, editorMode: "story", story: {
      coverPhotoUseId: orange.photoUseId, blocks: [
        { kind: "smallHeading", runs: [{ text: "两种颜色", bold: true, italic: false }] },
        { kind: "photo", photoUse: mint },
        { kind: "quote", runs: [{ text: "光线改变了纸上的颜色。", bold: false, italic: true }] },
        { kind: "photo", photoUse: orange },
      ],
    } });
  }
  await api.commitRecord(id, 0);
  if (fixture === "interleaved") await api.saveDraft({ recordId: id, title: "两张色样（校样）", editorMode: "story" });
  if (fixture === "shared") {
    const other = (await api.createDraft({ title: "色样乙", eventDate: "2026-11-14" })).row.recordId;
    await attach(other, MINT_SVG, "乙册独立说明");
    await api.commitRecord(other, 0);
    api.failNext("MEDIA_STATE_WRITE_FAILED", "replaceDraftPhoto");
  }
}
