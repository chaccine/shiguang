import type { RecordRow, TagInfo, TimelineItem } from "../domain/types.ts";
import { formatEventWhen } from "../domain/format.ts";

/** Same length-preserving ASCII fold as the search contract. Input stays literal. */
function fold(text: string): string {
  return text.replace(/[A-Z]/g, character => character.toLowerCase());
}

/** Append text nodes and marks only; neither the text nor keyword becomes markup. */
export function appendHighlight(holder: HTMLElement, text: string, keyword: string): void {
  const query = fold(keyword.trim());
  if (!query) { holder.append(document.createTextNode(text)); return; }
  const source = fold(text);
  let offset = 0;
  while (offset < text.length) {
    const index = source.indexOf(query, offset);
    if (index < 0) { holder.append(document.createTextNode(text.slice(offset))); break; }
    if (index > offset) holder.append(document.createTextNode(text.slice(offset, index)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(index, index + query.length);
    holder.append(mark);
    offset = index + query.length;
  }
}

/** Keep actual surrounding text, including whitespace; never manufacture a title. */
function excerpt(text: string, query: string): Omit<SearchHit, "label"> {
  const index = fold(text).indexOf(query);
  let start = Math.max(0, index - 48);
  // A long literal can fill the excerpt; the view itself remains bounded.
  let end = Math.min(text.length, start + 240);
  // Avoid cutting a visible emoji into an isolated UTF-16 surrogate.
  const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
  const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
  if (start > 0 && low(text.charCodeAt(start)) && high(text.charCodeAt(start - 1))) start--;
  if (end < text.length && high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end++;
  const prefix = start ? "…" : "";
  return {
    text: prefix + text.slice(start, end) + (end < text.length ? "…" : ""),
    matchStart: prefix.length + index - start,
    matchEnd: prefix.length + Math.min(index + query.length, end) - start,
  };
}

export interface SearchHit {
  label: string;
  text: string;
  /** Range comes from the real field, so clipped long hits and ellipses stay honest. */
  matchStart: number;
  matchEnd: number;
}

function projectedHits(item: TimelineItem, tags: readonly TagInfo[], keyword: string): SearchHit[] {
  const query = fold(keyword.trim());
  if (!query) return [];
  const names = new Map(tags.map(tag => [tag.tagId, tag.name]));
  const matchedTag = item.tagIds.map(id => names.get(id)).find(name => name !== undefined && fold(name).includes(query));
  const fields = [
    // M02 collapses body whitespace and adds an ellipsis. Such queries require
    // the real field so generated separators cannot masquerade as literal hits.
    { label: "正文", text: /\s|…/.test(query) ? "" : item.excerpt },
    { label: "图片说明", text: item.cover?.caption ?? "" },
    { label: "地点", text: item.location },
    { label: "标签", text: matchedTag ?? "" },
  ];
  return fields.filter(hit => fold(hit.text).includes(query)).map(hit => ({ label: hit.label, ...excerpt(hit.text, query) }));
}

/** Avoid fetching full records when the bounded M02 projection already explains a hit. */
export function projectionHasHit(item: TimelineItem, tags: readonly TagInfo[], keyword: string): boolean {
  const query = fold(keyword.trim());
  return !query || fold(item.title).includes(query) || projectedHits(item, tags, keyword).length > 0;
}

/** Read only formal fields. One excerpt per field dimension keeps cards compact. */
export function hitExcerpts(row: RecordRow, tags: readonly TagInfo[], keyword: string, max = 4): SearchHit[] {
  const query = fold(keyword.trim());
  const formal = row.formal;
  if (!query || row.status !== "active" || !formal) return [];
  const result: SearchHit[] = [];
  const add = (label: string, text: string) => {
    if (fold(text).includes(query)) result.push({ label, ...excerpt(text, query) });
  };
  add("正文", formal.body);
  const captionIndex = formal.photos.findIndex(photo => fold(photo.caption).includes(query));
  if (captionIndex >= 0) add(`图片说明 · 第 ${captionIndex + 1} 张`, formal.photos[captionIndex]!.caption);
  add("地点", formal.location);
  const names = new Map(tags.map(tag => [tag.tagId, tag.name]));
  const matchedTag = row.tagIds.map(id => names.get(id)).find(name => name !== undefined && fold(name).includes(query));
  if (matchedTag !== undefined) add("标签", matchedTag);
  return result.slice(0, Math.max(0, Math.min(4, max)));
}

export interface SearchCardHost {
  read(id: string): void;
  favorite(item: TimelineItem, button: HTMLButtonElement): void;
  photo(item: TimelineItem): HTMLElement | null;
}

/** M02's formal card projection, styling and lazy cover loader, with M05 excerpts. */
export function renderSearchCard(item: TimelineItem, row: RecordRow | null, tags: readonly TagInfo[], keyword: string, host: SearchCardHost): HTMLElement {
  const article = document.createElement("article");
  article.className = "timeline-card timeline-card--record search-result";
  article.dataset.testid = "search-item";
  article.dataset.recordId = item.recordId;

  const favorite = document.createElement("button");
  favorite.type = "button";
  favorite.className = `favorite-toggle${item.favorite ? " is-on" : ""}`;
  favorite.dataset.testid = `search-favorite-${item.recordId}`;
  favorite.dataset.searchFocus = favorite.dataset.testid;
  favorite.textContent = item.favorite ? "★" : "☆";
  favorite.setAttribute("aria-pressed", String(item.favorite));
  favorite.setAttribute("aria-label", item.favorite ? "取消珍藏" : "珍藏这段时光");
  favorite.title = item.favorite ? "取消珍藏" : "珍藏";
  favorite.addEventListener("click", () => host.favorite(item, favorite));
  article.append(favorite);

  const date = document.createElement("p");
  date.className = "search-result-date";
  date.textContent = formatEventWhen(item);
  if (item.isFuture) {
    const future = document.createElement("span");
    future.className = "pill is-pending";
    future.textContent = "未来时光";
    date.append(document.createTextNode(" · "), future);
  }
  article.append(date);
  if (item.title) {
    const title = document.createElement("h3");
    title.className = "timeline-title";
    appendHighlight(title, item.title, keyword);
    article.append(title);
  }

  const hits = row ? hitExcerpts(row, tags, keyword) : projectedHits(item, tags, keyword);
  if (hits.length) {
    for (const hit of hits) {
      const text = document.createElement("p");
      text.className = "card-excerpt search-hit";
      const label = document.createElement("span");
      label.className = "search-hit-label";
      label.textContent = `${hit.label}：`;
      text.append(label);
      text.append(document.createTextNode(hit.text.slice(0, hit.matchStart)));
      const mark = document.createElement("mark");
      mark.textContent = hit.text.slice(hit.matchStart, hit.matchEnd);
      text.append(mark, document.createTextNode(hit.text.slice(hit.matchEnd)));
      article.append(text);
    }
  } else if (!row && !projectionHasHit(item, tags, keyword)) {
    const pending = document.createElement("p");
    pending.className = "card-excerpt search-hit-pending";
    pending.dataset.testid = `search-hit-${item.recordId}`;
    pending.textContent = "正在读取命中片段…";
    article.append(pending);
  } else if (item.excerpt) {
    const text = document.createElement("p");
    text.className = "card-excerpt";
    // A contextual M02 summary is not evidence of another literal field hit.
    text.append(document.createTextNode(item.excerpt));
    article.append(text);
  }

  const cover = host.photo(item);
  if (cover) article.append(cover);
  const meta = document.createElement("div");
  meta.className = "timeline-meta-line";
  if (item.photoCount) {
    const photos = document.createElement("span");
    photos.className = "timeline-photo-count";
    photos.textContent = `${item.photoCount} 张照片`;
    meta.append(photos);
  }
  const names = new Map(tags.map(tag => [tag.tagId, tag.name]));
  const pills = document.createElement("div");
  pills.className = "timeline-tags";
  for (const id of item.tagIds) {
    const name = names.get(id);
    if (name === undefined) continue;
    const pill = document.createElement("span");
    pill.className = "tag-pill";
    appendHighlight(pill, name, keyword);
    pills.append(pill);
  }
  if (pills.children.length) meta.append(pills);
  if (item.location || item.mood) {
    const location = document.createElement("span");
    if (item.mood) location.append(document.createTextNode(item.mood + (item.location ? " · " : "")));
    appendHighlight(location, item.location, keyword);
    meta.append(location);
  }
  article.append(meta);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const read = document.createElement("button");
  read.type = "button";
  read.className = "button ghost";
  read.dataset.testid = `search-read-${item.recordId}`;
  read.dataset.searchFocus = read.dataset.testid;
  read.textContent = "阅读全文";
  read.setAttribute("aria-label", item.title ? `阅读：${item.title}` : `阅读 ${formatEventWhen(item)} 的时光`);
  read.addEventListener("click", () => host.read(item.recordId));
  actions.append(read);
  article.append(actions);
  return article;
}
