import type { UiPreferences } from "./appearance.ts";
import { MemoryAdapter } from "../platform/memory-adapter.ts";
import { MINT_SVG, ORANGE_SVG } from "../platform/synthetic-media.ts";
import { searchDemoClock } from "./search-demo.ts";

type Startup = "disabled" | "enabled" | "slow" | "error";

/** A fresh device in RAM for each explicit URL, including its appearance and navigation hints. */
export function mobilePreview(params: URLSearchParams, native: boolean) {
  const collection = params.get("stage01");
  if (native || (collection !== "timeline" && collection !== "empty")) return null;
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  const lock = params.get("lock");
  const startup = lock === "enabled" || lock === "slow" || lock === "error" ? lock : "disabled";
  const values = new Map([["shiguang.theme", theme]]);
  const preferences: UiPreferences = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
  const adapter = new MobilePreviewDevice(startup);
  return {
    adapter, preferences, filtered: params.get("filters") === "active", panel: params.get("panel") === "open",
    async prepare() {
      await adapter.setTheme(theme);
      if (collection === "timeline") await seedTimeline(adapter);
      if (startup !== "disabled") await adapter.setAppLock("0042");
    },
  };
}

class MobilePreviewDevice extends MemoryAdapter {
  private firstCheck: Startup;
  constructor(startup: Startup) {
    super({ now: searchDemoClock(), search: "" });
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
