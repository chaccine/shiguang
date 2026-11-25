import type { RecordRow, SearchFilter, SearchPage, TagInfo, TimelineItem } from "../domain/types.ts";
import type { ShiguangApi } from "../platform/api.ts";
import { normalizeSearchFilter } from "../domain/search.ts";
import { isValidDate } from "../domain/rules.ts";
import { matchesFilter, toItem } from "../domain/timeline.ts";
import { describeError } from "../domain/errors.ts";
import { durabilityLabel } from "../domain/format.ts";
import { hitExcerpts, projectionHasHit, renderSearchCard } from "./search-card.ts";

export const SEARCH_PAGE_SIZE = 24;
export const SEARCH_DEBOUNCE_MS = 450;
interface Host {
  read: (id: string) => Promise<void>;
  active: () => boolean;
  photo: (item: TimelineItem) => HTMLElement | null;
  manageTags: () => void;
  changed?: () => void;
}
interface Timing { schedule: (fn: () => void, ms: number) => unknown; cancel: (handle: unknown) => void }
interface Place { main: number; window: number; focus?: string }
const code = (error: unknown) => (error as { code?: string })?.code;
const cursorError = (error: unknown) => ["SEARCH_CURSOR_STALE", "SEARCH_CURSOR_MISMATCH", "INVALID_CURSOR"].includes(code(error) ?? "");
const lower = (text: string) => text.replace(/[A-Z]/g, c => c.toLowerCase());
// Explicit scalar tuple: IPC object property order is not a semantic difference.
function projectionKey(item: TimelineItem): string {
  const cover = item.cover;
  return JSON.stringify([item.recordId, item.eventDate, item.eventTime, item.location, item.mood,
    item.title, item.excerpt, item.photoCount, item.favorite, item.favoriteRevision, item.tagIds, item.tagRevision,
    item.createdAt, cover ? [cover.photoUseId, cover.assetId, cover.caption, cover.sha256, cover.bytes, cover.mediaType] : null]);
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function identified<T extends HTMLElement>(node: T, id: string): T { node.dataset.testid = id; return node; }
function button(text: string, id: string, action: () => void): HTMLButtonElement {
  const node = identified(el("button", text, "button ghost"), id); node.type = "button"; node.addEventListener("click", action); return node;
}

/** UI state is session-local. Opaque cursors never enter storage or the URL. */
export class SearchUi {
  private readonly root: HTMLElement;
  private readonly api: ShiguangApi;
  private readonly host: Host;
  private readonly timing: Timing;
  private input = identified(el("input"), "search-input");
  private from = identified(el("input"), "search-from");
  private to = identified(el("input"), "search-to");
  private favorite = identified(el("input"), "search-favorite");
  private photos = identified(el("select"), "search-photos");
  private order = identified(el("select"), "search-order");
  private tagBox = identified(el("div", "", "search-tags"), "search-tags");
  private chips = identified(el("div", "", "search-chips"), "search-chips");
  private list = identified(el("div", "", "search-result-list"), "search-list");
  private status = identified(el("p", "", "search-status"), "search-status");
  private error = identified(el("p", "", "search-error"), "search-error");
  private retry = button("重试查找", "search-retry", () => { void this.submit(); });
  private moreButton = button("加载更多", "search-more", () => { void this.more(); });
  private selected = new Set<string>();
  private tags: TagInfo[] = [];
  private items: TimelineItem[] = [];
  private rows = new Map<string, RecordRow>();
  private cursor: string | null = null;
  private source: string | null = null;
  private query: string | null = null;
  private total = 0;
  private generation = 0;
  private timer: unknown;
  private composing = false;
  private busy = false;
  private dirty = false;
  private rendered = false;
  private depth = SEARCH_PAGE_SIZE;
  private place: Place = { main: 0, window: 0 };

  constructor(root: HTMLElement, api: ShiguangApi, host: Host, timing?: Timing) {
    this.root = root; this.api = api; this.host = host;
    this.timing = timing ?? { schedule: (fn, ms) => setTimeout(fn, ms), cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    const header = el("header", "", "view-head");
    const heading = el("div"); heading.append(el("p", "从记得的一点，找到完整的时光", "eyebrow"), el("h1", "查找时光"),
      el("p", "查找正式保存的标题、正文、图片说明、手写地点和标签。", "view-sub")); header.append(heading);
    const form = identified(el("form", "", "search-form"), "search-form"); form.noValidate = true;
    const keyword = el("label", "关键词"); this.input.type = "search"; this.input.placeholder = "一个词，或一段记得的话";
    this.input.autocomplete = "off"; this.input.setAttribute("enterkeyhint", "search"); keyword.append(this.input);
    const submit = identified(el("button", "查找", "button"), "search-submit"); submit.type = "submit";
    const keywordRow = el("div", "", "search-keyword-row"); keywordRow.append(keyword, submit);
    form.addEventListener("submit", event => { event.preventDefault(); if (!this.composing) void this.submit(); });
    this.input.addEventListener("compositionstart", () => { this.composing = true; this.inputChanged(); });
    this.input.addEventListener("compositionend", () => { this.composing = false; this.inputChanged(); });
    this.input.addEventListener("input", () => this.inputChanged());
    this.input.addEventListener("keydown", event => {
      if (event.key === "Enter" && (this.composing || event.isComposing || event.keyCode === 229)) event.preventDefault();
    });
    const filters = el("fieldset", "", "search-filters"); filters.append(el("legend", "缩小查找范围"));
    const explanation = el("p", "多选标签满足任一即可（OR）；关键词、标签、发生日期、珍藏和照片条件需同时满足（AND）。", "search-summary");
    explanation.id = "search-filter-help"; filters.setAttribute("aria-describedby", explanation.id);
    const dates = el("div", "", "search-dates");
    for (const [input, label] of [[this.from, "发生日期 · 从（含当天）"], [this.to, "到（含当天）"]] as const) {
      input.type = "date"; input.setAttribute("aria-describedby", "search-date-help search-error");
      const field = el("label", label); field.append(input); dates.append(field);
      input.addEventListener("input", () => this.inputChanged()); input.addEventListener("change", () => this.inputChanged(false));
    }
    const dateHelp = el("p", "日期可留空；开始日期不能晚于结束日期。", "search-summary"); dateHelp.id = "search-date-help";
    this.favorite.type = "checkbox"; const favLabel = el("label", "", "search-favorite-label"); favLabel.append(this.favorite, document.createTextNode("只看珍藏"));
    this.favorite.addEventListener("change", () => this.inputChanged(false));
    for (const [select, label, options] of [
      [this.photos, "照片", [["all", "全部"], ["with", "含照片"], ["without", "无照片"]]],
      [this.order, "发生日期排序", [["desc", "从近到远"], ["asc", "从远到近"]]],
    ] as const) {
      for (const [value, text] of options) { const option = el("option", text); option.value = value; select.append(option); }
      select.value = options[0][0]; const field = el("label", label); field.append(select); filters.append(field);
      select.addEventListener("change", () => this.inputChanged(false));
    }
    const tagGroup = el("fieldset"); tagGroup.append(el("legend", "标签 · 可多选"), this.tagBox,
      button("管理标签", "search-manage-tags", host.manageTags));
    filters.append(favLabel, dates, dateHelp, tagGroup, explanation);
    this.chips.setAttribute("role", "group"); this.chips.setAttribute("aria-label", "已选条件，点击逐项移除");
    const clear = button("清除全部条件", "search-clear", () => this.clear());
    const actions = el("div", "", "search-actions"); actions.append(clear);
    form.append(keywordRow, filters, this.chips, actions);
    this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite"); this.status.setAttribute("aria-atomic", "true");
    this.status.tabIndex = -1;
    this.error.id = "search-error"; this.error.setAttribute("role", "alert"); this.error.hidden = true; this.retry.hidden = true;
    this.list.setAttribute("aria-label", "查找结果"); this.list.setAttribute("aria-busy", "false");
    this.moreButton.hidden = true;
    root.replaceChildren(header, form, this.status, this.error, this.retry, this.list, this.moreButton);
  }

  private filter(): SearchFilter {
    return { keyword: this.input.value, from: this.from.value, to: this.to.value, tagIds: [...this.selected],
      favoriteOnly: this.favorite.checked, hasPhoto: this.photos.value === "all" ? null : this.photos.value === "with",
      order: this.order.value === "asc" ? "asc" : "desc" };
  }
  private cancel(): number {
    if (this.timer !== undefined) this.timing.cancel(this.timer); this.timer = undefined;
    this.busy = false; this.list.setAttribute("aria-busy", "false"); this.moreButton.disabled = false;
    return ++this.generation;
  }
  private current(generation: number): boolean { return generation === this.generation && this.host.active(); }
  private discard(): void {
    this.items = []; this.rows.clear(); this.cursor = null; this.source = null; this.query = null; this.total = 0;
    this.list.replaceChildren(); this.moreButton.hidden = true;
    this.rendered = false;
  }
  private inputChanged(debounce = true): void {
    this.cancel(); this.discard(); this.depth = SEARCH_PAGE_SIZE; this.dirty = true;
    this.place = { main: 0, window: 0 }; this.renderChips();
    this.error.hidden = true; this.retry.hidden = true;
    if (!this.valid()) { this.status.textContent = "请先调整日期条件。"; return; }
    this.status.textContent = this.composing ? "输入完成后查找。" : "条件已改变，等待查找…";
    if (!this.composing && this.host.active()) this.timer = this.timing.schedule(() => { void this.submit(); }, debounce ? SEARCH_DEBOUNCE_MS : 0);
  }
  private valid(): boolean {
    const fromBad = !!this.from.validity?.badInput || !!this.from.value && !isValidDate(this.from.value);
    const toBad = !!this.to.validity?.badInput || !!this.to.value && !isValidDate(this.to.value);
    const reversed = !!this.from.value && !!this.to.value && this.from.value > this.to.value;
    this.from.setAttribute("aria-invalid", String(fromBad || reversed)); this.to.setAttribute("aria-invalid", String(toBad || reversed));
    try {
      if (fromBad || toBad) throw new Error("date"); normalizeSearchFilter(this.filter()); return true;
    } catch {
      this.error.textContent = reversed ? "开始日期不能晚于结束日期，请修改日期或移除日期条件。" : "请输入真实的发生日期（年-月-日），或移除日期条件后查找。";
      this.error.hidden = false; this.retry.hidden = true; return false;
    }
  }
  private renderTags(): void {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.testid;
    this.tagBox.replaceChildren();
    for (const tag of this.tags) {
      const choice = button(tag.name, `search-tag-${tag.tagId}`, () => {
        if (this.selected.has(tag.tagId)) this.selected.delete(tag.tagId); else this.selected.add(tag.tagId);
        this.renderTags(); this.inputChanged(false);
        this.tagBox.querySelector<HTMLElement>(`[data-testid="search-tag-${tag.tagId}"]`)?.focus({ preventScroll: true });
      });
      choice.className = "search-tag"; choice.setAttribute("aria-pressed", String(this.selected.has(tag.tagId))); this.tagBox.append(choice);
      if (focused === choice.dataset.testid) choice.focus({ preventScroll: true });
    }
    if (!this.tags.length) this.tagBox.append(el("p", "还没有标签，也可以直接用关键词查找。", "search-summary"));
  }
  private renderChips(): void {
    this.chips.replaceChildren();
    const add = (label: string, id: string, remove: () => void) => {
      const chip = button(`${label} ×`, `search-chip-${id}`, () => { remove(); this.renderTags(); this.inputChanged(false); this.input.focus(); });
      chip.className = "search-chip"; chip.setAttribute("aria-label", `移除条件：${label}`); this.chips.append(chip);
    };
    if (this.input.value.trim()) add(`关键词：${this.input.value.trim()}`, "keyword", () => { this.input.value = ""; });
    if (this.from.value || this.from.validity?.badInput) add(`从：${this.from.value || "未完成的日期"}`, "from", () => { this.from.value = ""; });
    if (this.to.value || this.to.validity?.badInput) add(`到：${this.to.value || "未完成的日期"}`, "to", () => { this.to.value = ""; });
    if (this.favorite.checked) add("只看珍藏", "favorite", () => { this.favorite.checked = false; });
    if (this.photos.value !== "all") add(this.photos.value === "with" ? "含照片" : "无照片", "photos", () => { this.photos.value = "all"; });
    for (const id of this.selected) add(`标签：${this.tags.find(t => t.tagId === id)?.name ?? "已移除的标签"}`, `tag-${id}`, () => { this.selected.delete(id); });
  }
  private clear(): void {
    this.input.value = ""; this.from.value = ""; this.to.value = ""; this.favorite.checked = false; this.photos.value = "all";
    this.selected.clear(); this.renderTags(); this.inputChanged(false); this.input.focus();
  }
  private capture(): Place {
    return { main: document.querySelector<HTMLElement>(".main")?.scrollTop ?? 0, window: window.scrollY,
      focus: (document.activeElement as HTMLElement | null)?.dataset?.searchFocus };
  }
  private restore(): void {
    if (!this.host.active() || document.querySelector<HTMLElement>(".app-shell")?.inert
      || (document.activeElement as HTMLElement | null)?.closest?.("dialog[open]")) return;
    const focus = [...this.root.querySelectorAll<HTMLElement>("[data-search-focus]")].find(n => n.dataset.searchFocus === this.place.focus);
    if (focus) focus.focus({ preventScroll: true });
    else if (this.place.focus) this.status.focus({ preventScroll: true });
    const main = document.querySelector<HTMLElement>(".main"); if (main) main.scrollTop = this.place.main;
    window.scrollTo(0, this.place.window);
  }
  leave(): void { this.place = this.capture(); this.cancel(); }
  invalidate(): void {
    this.cancel(); this.dirty = true;
    if (this.host.active()) {
      this.discard(); this.status.textContent = "正式内容或标签已更新，正在重新查找…";
      if (!this.composing) this.timer = this.timing.schedule(() => { void this.refresh(this.depth); }, 0);
    }
  }
  async enter(): Promise<void> { await this.resume(); }
  async resume(): Promise<void> { await this.refresh(this.depth, true); }
  async submit(): Promise<void> {
    if (this.composing) return;
    this.depth = SEARCH_PAGE_SIZE; await this.refresh(SEARCH_PAGE_SIZE);
  }
  private loading(message: string): void {
    this.busy = true; this.list.setAttribute("aria-busy", "true"); this.status.textContent = message;
    this.moreButton.disabled = true; this.error.hidden = true; this.retry.hidden = true;
  }
  private failed(error: unknown): void {
    this.error.textContent = `${describeError(error).title}。可以重试查找，或调整条件。`;
    this.error.hidden = false; this.retry.hidden = false; this.status.textContent = "查找未完成。";
  }
  private finish(): void {
    this.busy = false; this.list.setAttribute("aria-busy", "false"); this.moreButton.disabled = false;
  }
  private async refresh(depth: number, preserve = false): Promise<void> {
    const generation = this.cancel();
    if (this.composing || !this.host.active()) return;
    if (!this.valid()) { this.discard(); return; }
    const filter = this.filter(), oldSource = this.source, oldQuery = this.query;
    const oldItems = this.items.length;
    if (!preserve || this.dirty) this.discard();
    this.loading(preserve ? "正在核对最新的正式时光…" : "正在查找…");
    try {
      const tags = await this.api.listTags(); if (!this.current(generation)) return;
      this.tags = tags; this.renderTags(); this.renderChips();
      const first = await this.api.searchPage(filter, null, SEARCH_PAGE_SIZE); if (!this.current(generation)) return;
      if (preserve && !this.dirty && this.rendered && oldItems && oldSource === first.sourceGeneration && oldQuery === first.queryKey) {
        this.status.textContent = `已显示 ${oldItems} / ${first.total} 段时光。`; this.restore();
        void this.hydrate(this.items, filter.keyword ?? "", generation); return;
      }
      this.discard(); this.accept(first, false); this.dirty = false;
      while (this.cursor && this.items.length < depth && this.current(generation)) {
        const page = await this.api.searchPage(filter, this.cursor, Math.min(SEARCH_PAGE_SIZE, depth - this.items.length));
        if (!this.current(generation)) return;
        this.assertPage(page); this.accept(page, true);
      }
      if (!this.current(generation)) return;
      this.depth = Math.max(SEARCH_PAGE_SIZE, this.items.length); this.renderResults();
      if (preserve) this.restore();
      void this.hydrate(this.items, filter.keyword ?? "", generation);
    } catch (error) {
      if (!this.current(generation)) return;
      this.discard();
      if (cursorError(error)) await this.restart(generation); else this.failed(error);
    } finally { if (this.current(generation)) this.finish(); }
  }
  private assertPage(page: SearchPage): void {
    if (page.sourceGeneration !== this.source || page.queryKey !== this.query) throw { code: "SEARCH_CURSOR_STALE" };
  }
  private accept(page: SearchPage, append: boolean): void {
    const seen = new Set(append ? this.items.map(i => i.recordId) : []);
    this.items = [...(append ? this.items : []), ...page.items.filter(i => !seen.has(i.recordId) && !!seen.add(i.recordId))];
    this.cursor = page.nextCursor; this.total = page.total; this.source = page.sourceGeneration; this.query = page.queryKey;
  }
  /** Exactly one cursor recovery, never an unbounded retry loop. */
  private async restart(generation: number): Promise<void> {
    this.discard(); this.depth = SEARCH_PAGE_SIZE; this.status.textContent = "记录或条件已更新，已清空旧页并重新查找…";
    try {
      const tags = await this.api.listTags(); if (!this.current(generation)) return;
      this.tags = tags; this.renderTags(); this.renderChips();
      const page = await this.api.searchPage(this.filter(), null, SEARCH_PAGE_SIZE); if (!this.current(generation)) return;
      this.accept(page, false); this.dirty = false; this.renderResults("记录或条件已更新，已从第一页重新查找。 ");
      void this.hydrate(this.items, this.input.value, generation);
    } catch (error) { if (this.current(generation)) this.failed(error); }
  }
  async more(): Promise<void> {
    if (this.busy || !this.cursor || this.composing || !this.host.active()) return;
    const generation = this.generation, filter = this.filter(), before = this.items.length;
    this.loading("正在加载更多时光…");
    try {
      const page = await this.api.searchPage(filter, this.cursor, SEARCH_PAGE_SIZE); if (!this.current(generation)) return;
      this.assertPage(page); this.accept(page, true); this.depth = this.items.length;
      const continueFocus = document.activeElement === this.moreButton && !document.querySelector<HTMLElement>(".app-shell")?.inert;
      this.renderResults();
      // Keep keyboard continuation meaningful when the final Load more disappears.
      const next = this.list.children[before]?.querySelector<HTMLElement>("[data-search-focus]");
      if (continueFocus) next?.focus({ preventScroll: true });
      void this.hydrate(page.items, filter.keyword ?? "", generation);
    } catch (error) {
      if (!this.current(generation)) return;
      if (cursorError(error)) await this.restart(generation); else this.failed(error);
    } finally { if (this.current(generation)) this.finish(); }
  }
  private card(item: TimelineItem): HTMLElement {
    return renderSearchCard(item, this.rows.get(item.recordId) ?? null, this.tags, this.input.value, {
      photo: this.host.photo,
      read: id => { this.place = this.capture(); void this.host.read(id).catch(error => this.failed(error)); },
      favorite: (row, control) => { void this.toggleFavorite(row, control); },
    });
  }
  private renderResults(prefix = ""): void {
    this.list.replaceChildren(...this.items.map(item => this.card(item)));
    this.moreButton.hidden = this.cursor === null;
    this.rendered = true;
    this.status.textContent = `${prefix}已显示 ${this.items.length} / ${this.total} 段时光。`;
    if (!this.total) {
      const empty = identified(el("div", "", "search-empty"), "search-empty");
      empty.append(el("h2", "没有找到相符的时光"), el("p", "可以换个词、逐项移除条件，或清除全部条件再看看。"),
        button("清除全部条件", "search-empty-clear", () => this.clear())); this.list.append(empty);
    }
  }
  private async toggleFavorite(item: TimelineItem, control: HTMLButtonElement): Promise<void> {
    if (control.disabled) return; control.disabled = true;
    const place = this.capture();
    try {
      const result = await this.api.setFavorite(item.recordId, !item.favorite, item.favoriteRevision);
      this.host.changed?.(); this.dirty = true; this.place = place; await this.refresh(this.depth, true);
      if (this.host.active() && this.error.hidden) this.status.textContent += ` 珍藏状态${durabilityLabel(result.durability)}。`;
    } catch (error) {
      if (code(error) === "META_REVISION_CONFLICT") {
        this.dirty = true; await this.refresh(this.depth); this.status.textContent += " 珍藏状态已更新，请核对后重试。";
      } else if (this.host.active()) this.failed(error);
    } finally { control.disabled = false; }
  }
  /** Only unresolved hits need a formal read: most queries use the M02 projection.
   * Sequential yielded hydration bounds IPC and avoids a 24-read synchronous burst.
   * Every response is guarded by the same input generation as its parent query. */
  private async hydrate(items: readonly TimelineItem[], keyword: string, generation: number): Promise<void> {
    const needle = lower(keyword.trim()); if (!needle) return;
    for (const item of items) {
      if (projectionHasHit(item, this.tags, keyword) || this.rows.has(item.recordId)) continue;
      await new Promise<void>(resolve => setTimeout(resolve, 0)); if (!this.current(generation)) return;
      try {
        const row = await this.api.getRecord(item.recordId); if (!this.current(generation)) return;
        if (!row.formal || row.status !== "active") { this.invalidate(); return; }
        const formalRow = { ...row, formal: row.formal };
        // getRecord is a separate IPC read. Do not combine an obsolete card with
        // a different formal projection or a record that no longer matches.
        const fresh = toItem(formalRow, item.eventDate);
        if (projectionKey(fresh) !== projectionKey(item) || !matchesFilter(formalRow, this.filter())
          || !(lower(row.formal.title).includes(needle) || hitExcerpts(row, this.tags, keyword).length)) {
          this.invalidate(); return;
        }
        this.rows.set(item.recordId, row);
        const existing = [...this.list.children].find(n => (n as HTMLElement).dataset.recordId === item.recordId);
        const focus = this.capture(); existing?.replaceWith(this.card(item));
        if (focus.focus?.endsWith(item.recordId)) { this.place = focus; this.restore(); }
      } catch {
        if (!this.current(generation)) return;
        const pending = this.list.querySelector<HTMLElement>(`[data-testid="search-hit-${item.recordId}"]`);
        if (pending) pending.textContent = "命中片段暂时无法读取，可以重试查找或打开完整记录。";
      }
    }
  }
}
