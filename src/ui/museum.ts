import type { ShiguangApi } from "../platform/api.ts";
import type { MuseumPhotoTile, MuseumYear, SortOrder, TimelineItem } from "../domain/types.ts";
import { localToday } from "../domain/timeline.ts";

type Area = "home" | "reunion" | "favorites" | "photos" | "years" | "year";
interface Place { area: Area; year?: number; order: SortOrder; loaded: number; scroll: number; window: number; focus?: string }
interface Host { read: (id: string) => Promise<void>; write: () => void; active: () => boolean; error: (error: unknown) => void }
const names = { home: "回忆博物馆", reunion: "今日重逢", favorites: "珍藏展柜", photos: "照片展墙", years: "年度展室", year: "年度展室" };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.textContent = text; node.className = cls; return node;
};
function button(text: string, id: string, action: () => void): HTMLButtonElement {
  const node = el("button", text, "button ghost"); node.type = "button"; node.dataset.testid = id;
  node.dataset.museumFocus = id; node.addEventListener("click", action); return node;
}
export function photoAlt(photo: MuseumPhotoTile): string {
  return photo.caption || `照片 ${photo.photoIndex + 1}，来自${photo.title ? `《${photo.title}》` : "无标题记录"}`;
}

/** Disposable projections only. The API remains the sole source of formal content. */
export class MuseumUi {
  private content: HTMLElement;
  private place: Place = { area: "home", order: "desc", loaded: 24, scroll: 0, window: 0 };
  private history: Place[] = [];
  private generation = 0;
  private observer: IntersectionObserver | null = null;
  private cursor: string | null = null;
  private busy = false;
  private tiles: MuseumPhotoTile[] = [];
  private tileButtons: HTMLButtonElement[] = [];
  private seen: string[] = [];
  private shuffleSeed = 1;
  private previousIds: string[] = [];
  private hiddenId: string | null = null;
  private dialog: HTMLDialogElement;
  private viewerIndex = 0;
  private viewerGeneration = 0;
  private viewerFocus: HTMLElement | null = null;
  private yearSummaries: MuseumYear[] = [];
  private mutating = false;
  private api: ShiguangApi;
  private host: Host;
  private root: HTMLElement;
  private today: () => string;
  constructor(root: HTMLElement, api: ShiguangApi, host: Host, today = localToday) {
    this.root = root; this.api = api; this.host = host; this.today = today;
    this.content = root.querySelector('[data-testid="museum-content"]') ?? document.querySelector('[data-testid="museum-content"]')!;
    this.dialog = el("dialog", "", "museum-viewer"); this.dialog.dataset.testid = "museum-viewer";
    this.dialog.setAttribute("aria-modal", "true"); this.dialog.setAttribute("aria-label", "照片查看");
    this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.dialog.close(); });
    this.dialog.addEventListener("close", () => {
      this.viewerGeneration++;
      if (this.host.active() && !document.querySelector<HTMLElement>(".app-shell")?.inert) this.viewerFocus?.focus({ preventScroll: true });
    });
    this.dialog.addEventListener("keydown", event => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); this.run(() => this.movePhoto(event.key === "ArrowLeft" ? -1 : 1));
      } else if (event.key === "Escape") { event.preventDefault(); this.dialog.close(); }
    });
    root.append(this.dialog);
    (root.querySelector('[data-testid="museum-undo"]') ?? document.querySelector('[data-testid="museum-undo"]'))!
      .addEventListener("click", () => this.run(() => this.undo()));
  }
  private run(action: () => Promise<void>): void { void action().catch(this.host.error); }
  async enter(): Promise<void> {
    this.history = []; this.place = { area: "home", order: "desc", loaded: 24, scroll: 0, window: 0 };
    this.shuffleSeed = this.seed(); this.previousIds = []; this.seen = []; await this.render();
  }
  async resume(): Promise<void> { await this.render(true); this.restore(this.place); }
  private async read(id: string): Promise<void> { this.place = this.capture(); await this.host.read(id); }
  private capture(): Place {
    const focus = (document.activeElement as HTMLElement | null)?.dataset?.museumFocus;
    return { ...this.place, scroll: document.querySelector<HTMLElement>(".main")?.scrollTop ?? 0, window: window.scrollY, focus };
  }
  private restore(place: Place): void {
    if (!this.host.active()) return;
    const focus = [...this.content.querySelectorAll<HTMLElement>("[data-museum-focus]")].find(n => n.dataset.museumFocus === place.focus);
    focus?.focus({ preventScroll: true });
    const main = document.querySelector<HTMLElement>(".main"); if (main) main.scrollTop = place.scroll;
    window.scrollTo(0, place.window);
  }
  private async go(area: Area, year?: number): Promise<void> {
    this.history.push(this.capture()); this.place = { area, year, order: "desc", loaded: 24, scroll: 0, window: 0 };
    await this.render(); this.restore(this.place);
  }
  private async back(): Promise<void> {
    this.place = this.history.pop() ?? { area: "home", order: "desc", loaded: 24, scroll: 0, window: 0 };
    await this.render(true); this.restore(this.place);
  }
  private header(): HTMLElement {
    const header = el("header", "", "museum-header");
    if (this.place.area !== "home") header.append(button("← 返回" + (this.history.at(-1)?.area === "years" ? "年度展室" : "博物馆"), "museum-back", () => this.run(() => this.back())));
    header.append(el("p", this.place.area === "home" ? "拾光 · 私人藏馆" : "回忆博物馆 / " + names[this.place.area], "eyebrow"));
    const heading = el("h1", this.place.area === "year" ? `${this.place.year} 年展室` : names[this.place.area]); heading.tabIndex = -1;
    header.append(heading, el("p", this.place.area === "home" ? "把留住的小事，慢慢看一遍。" : {
      reunion: "同月同日，与从前的一天重逢。", favorites: "亲手珍藏的片段，值得再读一次。", photos: "每一张照片，都通向一段完整的故事。",
      years: "沿着年份，走进生活留下的房间。", year: "这一年的文字与照片，都在这里。",
    }[this.place.area], "museum-intro"));
    return header;
  }
  private async render(keepFocus = false): Promise<void> {
    const generation = ++this.generation;
    this.observer?.disconnect(); this.observer = null; this.cursor = null; this.busy = false;
    this.tiles = []; this.tileButtons = [];
    const stage = el("div"); stage.dataset.testid = `museum-${this.place.area}`;
    stage.append(this.header());
    // Render off-DOM: failed or stale requests never publish a partial exhibition.
    if (this.place.area === "home") await this.home(stage);
    else if (this.place.area === "years") {
      const years = await this.api.museumYears();
      if (generation !== this.generation) return;
      this.yearSummaries = years;
      if (!years.length) stage.append(this.empty("每一年，都可以从一件小事开始。"));
      const list = el("div", "", "museum-year-list");
      const count = Math.max(24, this.place.loaded);
      for (const year of years.slice(0, count)) list.append(this.yearCard(year)); stage.append(list);
      this.place.loaded = count;
      if (count < years.length) stage.append(button("继续看更多", "museum-more", () => this.run(() => this.more())));
    } else {
      const count = Math.max(24, this.place.loaded); this.place.loaded = 0;
      await this.page(stage, null, Math.min(500, count), true);
      while (this.cursor && this.place.loaded < count && generation === this.generation) {
        await this.page(stage, this.cursor, Math.min(500, count - this.place.loaded), false);
      }
    }
    if (generation !== this.generation) return;
    this.content.replaceChildren(stage);
    if (!keepFocus && this.host.active()) stage.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
    this.observe();
  }
  private empty(text: string): HTMLElement {
    const box = el("div", "", "museum-empty-note"); box.dataset.testid = "museum-empty";
    box.append(el("p", text), button("记录一件小事", "museum-write", this.host.write)); return box;
  }
  private card(item: TimelineItem, recommend = false, context: string = this.place.area): HTMLElement {
    const card = el("article", "", "museum-exhibit"); card.dataset.recordId = item.recordId;
    const open = button("", `museum-read-${item.recordId}`, () => this.run(() => this.read(item.recordId)));
    open.dataset.museumFocus = `${context}-read-${item.recordId}`;
    open.className = "museum-story";
    if (item.cover) open.append(this.photo(item.cover.assetId, item.cover.caption || `来自${item.title ? `《${item.title}》` : "无标题记录"}`, true));
    const label = el("span", "", "museum-placard");
    label.append(el("span", item.eventDate + (item.eventTime ? ` · ${item.eventTime}` : "") + (item.isFuture ? " · 未来时光" : ""), "museum-date"),
      el("span", item.title || "无标题记录", "museum-story-title"), el("span", item.excerpt, "museum-excerpt"));
    open.append(label); card.append(open);
    if (recommend) {
      const hide = button("暂时不看这条", `museum-hide-${item.recordId}`, () => this.run(() => this.hide(item.recordId)));
      hide.dataset.museumFocus = `${context}-hide-${item.recordId}`; card.append(hide);
    }
    return card;
  }
  private photo(assetId: string, alt: string, thumb: boolean): HTMLElement {
    const mat = el("span", "", thumb ? "museum-mat" : "museum-full-photo");
    const img = el("img"); img.alt = alt; img.loading = thumb ? "lazy" : "eager"; img.decoding = "async";
    const placeholder = el("span", "", "museum-photo-fallback");
    const fallback = (error?: unknown) => {
      img.remove(); const code = (error as { code?: string })?.code;
      placeholder.textContent = code === "HEIC_UNSUPPORTED" ? "无法预览 HEIC 图片" : "照片暂不可预览，说明和完整故事仍可查看。";
      mat.replaceChildren(placeholder);
    };
    img.addEventListener("error", () => fallback()); mat.append(img);
    void (thumb ? this.api.photoThumbUrl(assetId) : this.api.photoDataUrl(assetId)).then(url => { img.src = url; }).catch(fallback);
    return mat;
  }
  private async home(stage: HTMLElement): Promise<void> {
    const today = this.today(), generation = this.generation;
    const [summary, reunion, favorites, photos, years, shuffle] = await Promise.all([
      this.api.museumHomeSummary(today), this.api.museumReunionPreview(today), this.api.museumFavoritesPage(null, 2, "desc", today),
      this.api.museumPhotosPage(null, 3, "desc", today), this.api.museumYears(),
      this.api.museumReshuffle(this.shuffleSeed, this.previousIds, 2, today),
    ]);
    if (generation !== this.generation) return;
    this.seen = [...new Set([...this.seen, ...shuffle.items.map(i => i.recordId)])];
    if (!summary.recordCount) stage.append(this.empty("这里会慢慢装下你的生活。先留下一段文字，或一张照片。"));
    const rooms = el("div", "", "museum-rooms");
    const room = (area: Area, index: string, count: string, description: string) => {
      const section = el("section", "", `museum-room museum-room-${area}`); section.setAttribute("aria-label", names[area]);
      section.append(el("p", `${index} / ${count}`, "museum-room-number"), el("h2", names[area]), el("p", description, "museum-room-description"));
      const preview = el("div", "", "museum-room-preview"); section.append(preview,
        button(area === "reunion" ? "查看全部 →" : "进入展区 →", `museum-enter-${area}`, () => this.run(() => this.go(area))));
      rooms.append(section); return preview;
    };
    const r = room("reunion", "01", `${summary.reunionCount} 段重逢`, "今天，通往从前的同一天。");
    const firstGroup = reunion.groups[0];
    if (firstGroup) { r.append(el("p", firstGroup.label, "museum-reunion-label"), this.card(firstGroup.items[0], true, "reunion-preview")); }
    else r.append(el("p", "今天还没有往年的同日记录。也可以去其他展区走走。", "museum-quiet"));
    const f = room("favorites", "02", `${summary.favoriteCount} 段珍藏`, "由你亲手留下的特别席位。");
    favorites.items.forEach(item => f.append(this.card(item, false, "favorites-preview")));
    if (!favorites.total) f.append(el("p", "遇到想多看几遍的故事，可以在记录上点亮珍藏。", "museum-quiet"));
    const p = room("photos", "03", `${summary.photoCount} 张照片`, "一帧一刻，都是生活的原色。");
    const strip = el("div", "", "museum-photo-strip");
    photos.items.forEach(tile => { const open = button("", `museum-preview-${tile.photoUseId}`, () => this.run(() => this.go("photos")));
      open.className = "museum-photo-preview"; open.setAttribute("aria-label", photoAlt(tile)); open.append(this.photo(tile.assetId, photoAlt(tile), true)); strip.append(open); });
    p.append(strip); if (!photos.total) p.append(el("p", "照片随正式故事来到这里，文字也有自己的展柜。", "museum-quiet"));
    const y = room("years", "04", `${summary.yearCount} 间展室`, "一年一间，收藏不同的光景。");
    if (years[0]) y.append(el("p", String(years[0].year), "museum-year-number"), el("p", `${years[0].recordCount} 段记录 · ${years[0].photoCount} 张照片`, "museum-date"), this.months(years[0]));
    else y.append(el("p", "留下一段正式记录，就有了属于那一年的房间。", "museum-quiet"));
    stage.append(rooms);
    const recommendation = el("section", "", "museum-recommendation"); recommendation.setAttribute("aria-label", "偶遇一段时光");
    recommendation.append(el("h2", "偶遇一段时光"), el("p", "从已发生的正式记录里，随手翻开一页。", "museum-quiet"));
    const tray = el("div", "", "museum-card-grid"); shuffle.items.forEach(item => tray.append(this.card(item, true, "shuffle"))); recommendation.append(tray);
    const next = button("再看一段 ↻", "museum-reshuffle", () => this.run(async () => {
      this.shuffleSeed = this.seed(); this.previousIds = [...this.seen];
      const position = this.capture(); await this.render(true); this.restore(position);
      this.message(summary.eligibleCount <= 2 ? "已翻看这里可推荐的片段，可以慢慢再读。" : "又翻开了几段时光。");
    }));
    next.disabled = summary.eligibleCount === 0; recommendation.append(next);
    if (!summary.eligibleCount) recommendation.append(el("p", "暂时没有可推荐的片段。四个展区仍可以自由浏览。", "museum-quiet"));
    stage.append(recommendation, el("p", "这些展览来自本机的正式记录。", "museum-footer"));
  }
  private months(year: MuseumYear): HTMLElement {
    const chart = el("ol", "", "museum-months"); chart.setAttribute("aria-label", `${year.year} 年每月记录数`);
    const max = Math.max(1, ...year.months);
    year.months.forEach((count, i) => {
      const month = el("li"); month.setAttribute("aria-label", `${i + 1} 月：${count} 条记录`);
      const track = el("span", "", "museum-month-track"); track.setAttribute("aria-hidden", "true");
      const bar = el("span"); bar.style.height = `${100 * count / max}%`; track.append(bar);
      month.append(el("span", String(count), "museum-month-value"), track, el("span", `${i + 1}月`)); chart.append(month);
    }); return chart;
  }
  private yearCard(year: MuseumYear): HTMLElement {
    const card = el("article", "", "museum-year-card");
    card.append(el("h2", `${year.year} 年`), el("p", `${year.recordCount} 段记录 · ${year.photoCount} 张照片`, "museum-date"), this.months(year),
      button("走进这一年 →", `museum-year-${year.year}`, () => this.run(() => this.go("year", year.year)))); return card;
  }
  private order(stage: HTMLElement): void {
    const bar = el("div", "", "museum-toolbar");
    const toggle = button(this.place.order === "desc" ? "发生日期：从近到远 ↓" : "发生日期：从远到近 ↑", "museum-order", () => this.run(async () => {
      this.place.order = this.place.order === "desc" ? "asc" : "desc"; this.place.loaded = 24;
      await this.render(true); this.content.querySelector<HTMLElement>('[data-testid="museum-order"]')?.focus();
    })); bar.append(toggle); stage.append(bar);
  }
  private async page(stage: HTMLElement, cursor: string | null, limit: number, first: boolean): Promise<void> {
    const { area, year, order } = this.place, today = this.today(), generation = this.generation;
    const results = area === "reunion" ? await this.api.museumReunionPage(cursor, limit, today)
      : area === "favorites" ? await this.api.museumFavoritesPage(cursor, limit, order, today)
      : area === "photos" ? await this.api.museumPhotosPage(cursor, limit, order, today)
      : await this.api.museumYearRoom(year!, cursor, limit, order, today);
    if (generation !== this.generation) return;
    const page = "page" in results ? results.page : results;
    if (first) {
      if ("featured" in results) {
        if (results.summary) stage.append(this.months(results.summary));
        const featured = el("section", "", "museum-featured"); featured.setAttribute("aria-label", "年度精选"); featured.append(el("h2", "精选"));
        const cards = el("div", "", "museum-card-grid"); results.featured.forEach(item => cards.append(this.card(item, true, "featured")));
        if (!results.featured.length) featured.append(el("p", "这一年暂时没有可推荐的精选，全部记录仍在下方。", "museum-quiet"));
        featured.append(cards); stage.append(featured, el("h2", "这一年的全部记录"));
      }
      if (area !== "reunion") this.order(stage);
      const list = el("div", "", area === "photos" ? "museum-photo-grid" : "museum-list"); list.dataset.testid = "museum-list";
      if (area === "photos") { list.setAttribute("role", "group"); list.setAttribute("aria-label", "照片展墙，方向键移动，回车查看照片"); }
      stage.append(list);
      if (!page.total) stage.append(this.empty({ reunion: "今天还没有往年的同日记录。回忆也在其他展区等你。", favorites: "还没有珍藏。可以在喜欢的故事上点亮珍藏。",
        photos: "这里会展出正式故事里的照片，暂时也可以去读读文字。", year: "这一年还没有正式记录。", home: "", years: "" }[area]));
    }
    const list = stage.querySelector<HTMLElement>('[data-testid="museum-list"]')!;
    if ("groups" in page) {
      for (const group of page.groups) {
        let section = [...list.children].find(node => (node as HTMLElement).dataset.year === String(group.year)) as HTMLElement | undefined;
        if (!section) { section = el("section"); section.dataset.year = String(group.year); section.append(el("h2", group.label)); list.append(section); }
        group.items.forEach(item => section!.append(this.card(item, true)));
      }
    } else if (area === "photos") {
      for (const tile of page.items as MuseumPhotoTile[]) { this.tiles.push(tile); list.append(this.tile(tile, this.tiles.length - 1)); }
    } else (page.items as TimelineItem[]).forEach(item => list.append(this.card(item)));
    this.cursor = page.nextCursor;
    this.place.loaded += limit;
    stage.querySelector('[data-testid="museum-more"]')?.remove();
    if (this.cursor) stage.append(button("继续看更多", "museum-more", () => this.run(() => this.more())));
  }
  private observe(): void {
    const more = this.content.querySelector('[data-testid="museum-more"]');
    if (!more || typeof IntersectionObserver === "undefined") return;
    this.observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting) && this.host.active() && !this.dialog.open) this.run(() => this.more()); }, { rootMargin: "120px" });
    this.observer.observe(more);
  }
  private async more(): Promise<void> {
    if (this.busy || !this.host.active()) return;
    if (this.place.area === "years") {
      this.observer?.disconnect();
      const list = this.content.querySelector<HTMLElement>(".museum-year-list")!;
      const end = this.place.loaded + 24;
      this.yearSummaries.slice(this.place.loaded, end).forEach(year => list.append(this.yearCard(year)));
      this.place.loaded = end;
      if (end >= this.yearSummaries.length) this.content.querySelector('[data-testid="museum-more"]')?.remove();
      this.observe();
      return;
    }
    if (!this.cursor) return;
    this.busy = true; this.observer?.disconnect();
    const more = this.content.querySelector<HTMLButtonElement>('[data-testid="museum-more"]'); if (more) more.disabled = true;
    try { await this.page(this.content.firstElementChild as HTMLElement, this.cursor, 24, false); this.observe(); }
    finally { this.busy = false; if (more) more.disabled = false; }
  }
  private seed(): number { return Math.floor(Math.random() * 0x100000000); }
  private tile(photo: MuseumPhotoTile, index: number): HTMLButtonElement {
    const tile = button("", `museum-photo-${photo.photoUseId}`, () => this.run(() => this.openPhoto(index)));
    tile.className = "museum-photo-tile"; tile.tabIndex = index === 0 ? 0 : -1;
    tile.setAttribute("aria-label", photoAlt(photo)); tile.append(this.photo(photo.assetId, photoAlt(photo), true));
    tile.append(el("span", photo.eventDate + (photo.isFuture ? " · 未来时光" : ""), "museum-date"));
    tile.addEventListener("focus", () => this.tileButtons.forEach(b => { b.tabIndex = b === tile ? 0 : -1; }));
    tile.addEventListener("keydown", event => {
      const columns = Math.max(1, getComputedStyle(tile.parentElement!).gridTemplateColumns.split(" ").length);
      const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns, Home: -index, End: this.tiles.length - 1 - index };
      if (!(event.key in step)) return;
      event.preventDefault(); const next = Math.max(0, Math.min(this.tileButtons.length - 1, index + step[event.key]));
      this.tileButtons[next]?.focus();
    });
    this.tileButtons.push(tile); return tile;
  }
  private async openPhoto(index: number): Promise<void> {
    this.viewerFocus = this.tileButtons[index]; this.viewerIndex = index;
    await this.paintViewer(); this.dialog.showModal(); this.dialog.querySelector<HTMLElement>("button")?.focus();
  }
  private async movePhoto(step: number): Promise<void> {
    const next = this.viewerIndex + step;
    if (next < 0) return;
    if (next >= this.tiles.length && this.cursor) await this.more();
    if (next >= this.tiles.length || !this.dialog.open) return;
    this.viewerIndex = next; await this.paintViewer();
  }
  private async paintViewer(): Promise<void> {
    const photo = this.tiles[this.viewerIndex]; if (!photo) return;
    const version = ++this.viewerGeneration;
    const controls = el("div", "", "museum-viewer-controls");
    const close = button("关闭 ×", "museum-viewer-close", () => this.dialog.close()); close.setAttribute("aria-label", "关闭照片查看");
    const prev = button("←", "museum-viewer-prev", () => this.run(() => this.movePhoto(-1))); prev.setAttribute("aria-label", "上一张照片"); prev.disabled = this.viewerIndex === 0;
    const next = button("→", "museum-viewer-next", () => this.run(() => this.movePhoto(1))); next.setAttribute("aria-label", "下一张照片"); next.disabled = this.viewerIndex === this.tiles.length - 1 && !this.cursor;
    const count = el("p", `照片 ${this.viewerIndex + 1}`, "museum-date"); count.setAttribute("role", "status");
    controls.append(close, prev, count, next);
    const figure = el("figure"); figure.append(this.photo(photo.assetId, photoAlt(photo), false), el("figcaption", photo.caption || "这张照片没有说明。"));
    const context = el("div", "", "museum-viewer-context");
    context.append(el("h2", photo.title || "无标题记录"), el("p", photo.eventDate + (photo.eventTime ? ` · ${photo.eventTime}` : "") + (photo.isFuture ? " · 未来时光" : ""), "museum-date"),
      button("进入完整故事 →", "museum-viewer-story", () => {
        this.dialog.close(); this.run(() => this.read(photo.recordId));
      }));
    if (version !== this.viewerGeneration) return;
    const focusId = (document.activeElement as HTMLElement | null)?.dataset?.testid;
    this.dialog.replaceChildren(controls, figure, context);
    if (this.dialog.open) (this.dialog.querySelector<HTMLElement>(`[data-testid="${focusId}"]`) ?? close).focus({ preventScroll: true });
  }
  private message(text: string): void {
    const feedback = this.root.querySelector<HTMLElement>('[data-testid="museum-feedback"]')!;
    feedback.hidden = false; this.root.querySelector('[data-testid="museum-message"]')!.textContent = text;
    this.root.querySelector<HTMLElement>('[data-testid="museum-undo"]')!.hidden = !this.hiddenId;
  }
  private async hide(id: string): Promise<void> {
    if (this.mutating) return;
    this.mutating = true;
    try {
    const position = this.capture(), result = await this.api.setMuseumHidden(id, true);
    this.hiddenId = id;
    await this.render(true); this.restore(position);
    this.message(result.durability === "uncertain" ? "已暂时不推荐这条，但系统未确认写入磁盘，请保持应用打开并重试检查。" : "已暂时不推荐这条。仍可在时光轴、珍藏展柜和照片展墙找到它。");
    this.root.querySelector<HTMLElement>('[data-testid="museum-undo"]')?.focus({ preventScroll: true });
    } finally { this.mutating = false; }
  }
  private async undo(): Promise<void> {
    if (!this.hiddenId || this.mutating) return;
    this.mutating = true;
    try {
    const position = this.capture(), result = await this.api.setMuseumHidden(this.hiddenId, false);
    this.hiddenId = null; await this.render(true); this.restore(position);
    this.message(result.durability === "uncertain" ? "已撤销，但系统未确认写入磁盘，请保持应用打开并重试检查。" : "已撤销，恢复这条记录的推荐。");
    this.content.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
    } finally { this.mutating = false; }
  }
}
