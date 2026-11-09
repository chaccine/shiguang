import { DraftSession, recoverLastDraft } from "../domain/draft-session.ts";
import type { DraftSessionSnapshot } from "../domain/draft-session.ts";
import { describeError } from "../domain/errors.ts";
import type { ErrorDescription } from "../domain/errors.ts";
import { durabilityLabel, formalHeadline, formatEventWhen } from "../domain/format.ts";
import type { FieldIssue, PhotoUse, RecordRow } from "../domain/types.ts";
import { formalItems } from "../domain/view.ts";
import type { FormalListItem } from "../domain/view.ts";
import type { ShiguangApi } from "../platform/api.ts";
import { MemoryAdapter } from "../platform/memory-adapter.ts";
import { createTauriApi, tauriInvokeFromWindow } from "../platform/tauri-adapter.ts";
import { PREVIEW_STORAGE_KEY, seedDemo } from "./demo.ts";

const LAST_DRAFT_KEY = "shiguang.lastDraft";

type View = "drafts" | "editor" | "timeline";

function byTestId<T extends HTMLElement>(testId: string): T {
  const node = document.querySelector<T>(`[data-testid="${testId}"]`);
  if (node === null) throw new Error(`界面缺少元素：${testId}`);
  return node;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`界面缺少元素：#${id}`);
  return node as T;
}

const draftsTab = byTestId<HTMLButtonElement>("drafts-tab");
const timelineTab = byTestId<HTMLButtonElement>("timeline-tab");
const newDraftButton = byTestId<HTMLButtonElement>("new-draft");
const commitButton = byTestId<HTMLButtonElement>("commit-button");
const backButton = byTestId<HTMLButtonElement>("back-to-drafts");
const photoInput = byTestId<HTMLInputElement>("photo-input");
const saveStatus = byTestId<HTMLDivElement>("save-status");
const notice = byTestId<HTMLDivElement>("notice");
const errorBox = byTestId<HTMLDivElement>("error-box");
const editorTitle = byTestId<HTMLInputElement>("editor-title");
const editorBody = byTestId<HTMLTextAreaElement>("editor-body");
const editorDate = byTestId<HTMLInputElement>("editor-date");
const editorTime = byTestId<HTMLInputElement>("editor-time");
const editorBadge = byId<HTMLSpanElement>("editor-badge");
const previewNotice = byId<HTMLParagraphElement>("preview-notice");
const appNotice = byId<HTMLParagraphElement>("app-notice");
const viewDrafts = byId<HTMLElement>("view-drafts");
const viewEditor = byId<HTMLElement>("view-editor");
const viewTimeline = byId<HTMLElement>("view-timeline");
const draftList = byId<HTMLDivElement>("draft-list");
const timelineList = byId<HTMLDivElement>("timeline-list");
const photoGrid = byId<HTMLDivElement>("photo-grid");

const params = new URLSearchParams(window.location.search);
const invoke = tauriInvokeFromWindow();
const demo = invoke === null && params.get("demo") === "1";

if (demo) {
  window.localStorage.removeItem(PREVIEW_STORAGE_KEY);
  window.localStorage.removeItem(LAST_DRAFT_KEY);
}

const memory = invoke === null
  ? new MemoryAdapter({ storage: window.localStorage, storageKey: PREVIEW_STORAGE_KEY })
  : null;
const api: ShiguangApi = memory ?? createTauriApi(invoke!);

const session = new DraftSession<number>({
  api,
  schedule: (fn, ms) => window.setTimeout(fn, ms),
  cancel: (handle) => window.clearTimeout(handle),
  debounceMs: 800,
});

let currentView: View = "drafts";
let photoKey: string | null = null;

session.onChange((state) => {
  renderStatus(state);
  renderPhotos(state.snapshot.photos);
  const recordId = state.recordId;
  if (recordId !== null && currentView === "editor"
    && (state.status === "saved" || state.status === "savedUncertain")) {
    window.localStorage.setItem(LAST_DRAFT_KEY, recordId);
  }
});

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function clockText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

function formatUpdated(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return sameDay
    ? `今天 ${time}`
    : `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${time}`;
}

function previewText(body: string, limit: number): string {
  const text = body.trim().replace(/\s+/g, " ");
  if (text.length === 0) return "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function setView(view: View): void {
  currentView = view;
  viewDrafts.hidden = view !== "drafts";
  viewEditor.hidden = view !== "editor";
  viewTimeline.hidden = view !== "timeline";
  const draftsActive = view === "drafts" || view === "editor";
  draftsTab.classList.toggle("is-active", draftsActive);
  timelineTab.classList.toggle("is-active", view === "timeline");
  draftsTab.setAttribute("aria-selected", String(draftsActive));
  timelineTab.setAttribute("aria-selected", String(view === "timeline"));
}

function showPreviewNotice(): void {
  previewNotice.hidden = false;
  previewNotice.className = "notice-line preview";
  previewNotice.textContent = "浏览器预览模式：数据只存在本浏览器，用于界面预览，不是真实存储";
  notice.hidden = false;
}

function showAppNotice(message: string, tone: "calm" | "ok" | "warn"): void {
  appNotice.hidden = false;
  appNotice.className = `notice-line ${tone}`;
  appNotice.textContent = message;
  notice.hidden = false;
}

function clearAppNotice(): void {
  appNotice.hidden = true;
  appNotice.textContent = "";
  notice.hidden = previewNotice.hidden;
}

function clearErrorBox(): void {
  errorBox.hidden = true;
  errorBox.className = "error-box";
  errorBox.replaceChildren();
}

function showErrorDescription(description: ErrorDescription): void {
  errorBox.hidden = false;
  errorBox.className = `error-box is-${description.kind}`;
  const title = document.createElement("strong");
  title.textContent = description.title;
  const detail = document.createElement("span");
  detail.textContent = description.detail;
  errorBox.replaceChildren(title, detail);
}

function showError(error: unknown): void {
  showErrorDescription(describeError(error));
}

function isFieldIssue(error: unknown): error is FieldIssue {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; message?: unknown };
  return typeof value.code === "string" && typeof value.message === "string";
}

function showFieldIssue(issue: FieldIssue): void {
  errorBox.hidden = false;
  errorBox.className = "error-box is-validation";
  const title = document.createElement("strong");
  title.textContent = describeError(issue).title;
  const detail = document.createElement("span");
  detail.textContent = issue.message;
  errorBox.replaceChildren(title, detail);
}

function renderStatus(state: DraftSessionSnapshot): void {
  saveStatus.replaceChildren();
  saveStatus.className = "save-status";
  if (state.status === "idle") return;

  const text = document.createElement("span");
  text.className = "status-text";

  switch (state.status) {
    case "dirty":
      text.textContent = "未保存的修改…";
      break;
    case "saving":
      text.textContent = "正在保存…";
      break;
    case "saved": {
      const clock = state.lastSavedAt ? clockText(state.lastSavedAt) : "";
      text.textContent = clock.length > 0 ? `已自动保存 ${clock}` : "已自动保存";
      saveStatus.classList.add("is-saved");
      clearErrorBox();
      break;
    }
    case "savedUncertain":
      text.textContent = "已写入，但系统未确认落盘";
      saveStatus.classList.add("is-uncertain");
      clearErrorBox();
      break;
    case "error": {
      const description = state.lastError ?? describeError(undefined);
      text.textContent = `${description.title}：${description.detail}`;
      saveStatus.classList.add("is-error");
      showErrorDescription(description);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry";
      retry.textContent = "重试";
      retry.addEventListener("click", () => {
        void session.retry().catch((error: unknown) => { showError(error); });
      });
      saveStatus.append(text, retry);
      return;
    }
    case "conflict": {
      const description = state.lastError ?? describeError("REVISION_CONFLICT");
      text.textContent = `${description.title}：${description.detail}`;
      saveStatus.classList.add("is-error");
      showErrorDescription(description);
      break;
    }
  }

  saveStatus.append(text);
}

function createPhotoThumb(assetId: string, caption: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "photo-thumb";
  img.setAttribute("data-testid", "photo-thumb");
  img.alt = caption.trim() || "时光照片";
  img.loading = "lazy";
  img.dataset.assetId = assetId;
  return img;
}

async function loadPhoto(img: HTMLImageElement, assetId: string, holder: HTMLElement): Promise<void> {
  try {
    img.src = await api.photoDataUrl(assetId);
  } catch (error) {
    const description = describeError(error);
    img.remove();
    const fallback = document.createElement("span");
    fallback.className = "photo-fallback";
    fallback.textContent = description.title;
    fallback.title = description.detail;
    holder.append(fallback);
  }
}

function editorPhotoCell(photo: PhotoUse): HTMLElement {
  const cell = document.createElement("div");
  cell.className = "photo-cell";
  const img = createPhotoThumb(photo.assetId, photo.caption);
  cell.append(img);
  void loadPhoto(img, photo.assetId, cell);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "photo-remove";
  remove.textContent = "×";
  remove.title = "移除这张照片";
  remove.setAttribute("aria-label", "移除这张照片");
  remove.addEventListener("click", () => {
    void session.removePhoto(photo.photoUseId).catch((error: unknown) => { showError(error); });
  });
  cell.append(remove);
  return cell;
}

function renderPhotos(photos: readonly PhotoUse[]): void {
  const key = photos.map((photo) => photo.photoUseId).join("|");
  if (key === photoKey) return;
  photoKey = key;
  if (photos.length === 0) {
    const empty = document.createElement("p");
    empty.className = "photo-empty";
    empty.textContent = "还没有照片，可以附上几张。";
    photoGrid.replaceChildren(empty);
    return;
  }
  photoGrid.replaceChildren(...photos.map(editorPhotoCell));
}

function fillEditor(): void {
  const snapshot = session.state.snapshot;
  editorTitle.value = snapshot.title;
  editorBody.value = snapshot.body;
  editorDate.value = snapshot.eventDate;
  editorTime.value = snapshot.eventTime ?? "";
}

function openInEditor(row: RecordRow | null): void {
  photoKey = null;
  session.open(row);
  fillEditor();
  editorBadge.hidden = !(row !== null && row.formal !== null && row.draft !== null);
  if (row !== null) window.localStorage.setItem(LAST_DRAFT_KEY, row.recordId);
}

async function flushBeforeLeave(): Promise<boolean> {
  try {
    await session.flush();
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
}

async function openDraft(row: RecordRow): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  try {
    openInEditor(row);
    clearAppNotice();
    clearErrorBox();
    setView("editor");
  } catch (error) {
    showError(error);
  }
}

async function startNewDraft(): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  try {
    openInEditor(null);
    window.localStorage.removeItem(LAST_DRAFT_KEY);
    clearAppNotice();
    clearErrorBox();
    setView("editor");
    editorTitle.focus();
  } catch (error) {
    showError(error);
  }
}

async function openModification(recordId: string): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  try {
    const created = await api.createDraft({ baseRecordId: recordId });
    openInEditor(created.row);
    clearAppNotice();
    clearErrorBox();
    setView("editor");
  } catch (error) {
    showError(error);
  }
}

async function refreshDrafts(): Promise<void> {
  try {
    const rows = (await api.listDrafts())
      .filter((row) => row.draft !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.recordId.localeCompare(a.recordId));
    renderDrafts(rows);
  } catch (error) {
    showError(error);
  }
}

function draftCard(row: RecordRow): HTMLElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "draft-card";
  card.setAttribute("data-testid", "draft-item");
  card.addEventListener("click", () => { void openDraft(row); });

  const head = document.createElement("span");
  head.className = "card-head";
  const title = document.createElement("span");
  title.className = "card-title";
  title.textContent = row.draft?.title.trim() || "未命名草稿";
  head.append(title);
  if (row.formal !== null) {
    const badge = document.createElement("span");
    badge.className = "pill is-modifying";
    badge.textContent = "修改中";
    head.append(badge);
  }

  const meta = document.createElement("span");
  meta.className = "card-meta";
  const dateText = row.draft?.eventDate.trim() || "日期未填写";
  const photos = row.draft?.photos.length ?? 0;
  meta.textContent = `${dateText} · 更新于 ${formatUpdated(row.updatedAt)} · ${photos} 张照片`;
  card.append(head, meta);

  const excerpt = previewText(row.draft?.body ?? "", 48);
  if (excerpt.length > 0) {
    const paragraph = document.createElement("span");
    paragraph.className = "card-excerpt";
    paragraph.textContent = excerpt;
    card.append(paragraph);
  }
  return card;
}

function renderDrafts(rows: readonly RecordRow[]): void {
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有草稿，点上面的「新建草稿」写第一篇吧。";
    draftList.replaceChildren(empty);
    return;
  }
  draftList.replaceChildren(...rows.map(draftCard));
}

async function refreshTimeline(): Promise<void> {
  try {
    renderTimeline(formalItems(await api.listFormalRecords()));
  } catch (error) {
    showError(error);
  }
}

function timelineCard(item: FormalListItem): HTMLElement {
  const article = document.createElement("article");
  article.className = "timeline-card";
  article.setAttribute("data-testid", "timeline-item");

  const head = document.createElement("div");
  head.className = "card-head";
  const title = document.createElement("h3");
  title.className = "timeline-title";
  title.textContent = formalHeadline(item);
  head.append(title);
  if (item.hasPendingDraft) {
    const badge = document.createElement("span");
    badge.className = "pill is-pending";
    badge.textContent = "有未提交的修改";
    head.append(badge);
  }
  article.append(head);

  const when = document.createElement("div");
  when.className = "card-meta";
  when.textContent = formatEventWhen(item);
  article.append(when);

  const body = previewText(item.body, 120);
  if (body.length > 0) {
    const paragraph = document.createElement("p");
    paragraph.className = "timeline-body";
    paragraph.textContent = body;
    article.append(paragraph);
  }

  if (item.photos.length > 0) {
    const grid = document.createElement("div");
    grid.className = "photo-grid";
    for (const photo of item.photos) {
      const img = createPhotoThumb(photo.assetId, photo.caption);
      grid.append(img);
      void loadPhoto(img, photo.assetId, grid);
    }
    article.append(grid);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "button ghost";
  edit.textContent = "修改";
  edit.addEventListener("click", () => { void openModification(item.recordId); });
  actions.append(edit);
  article.append(actions);
  return article;
}

function renderTimeline(items: readonly FormalListItem[]): void {
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有存入的时光，从一篇草稿开始吧。";
    timelineList.replaceChildren(empty);
    return;
  }
  timelineList.replaceChildren(...items.map(timelineCard));
}

async function showDrafts(): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  setView("drafts");
  await refreshDrafts();
}

async function showTimeline(): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  setView("timeline");
  await refreshTimeline();
}

async function commitCurrent(): Promise<void> {
  if (currentView !== "editor") return;
  clearErrorBox();
  commitButton.disabled = true;
  commitButton.textContent = "正在存入…";
  try {
    const result = await session.commit();
    window.localStorage.removeItem(LAST_DRAFT_KEY);
    showAppNotice(durabilityLabel(result.durability), result.durability === "uncertain" ? "warn" : "ok");
    await showTimeline();
  } catch (error) {
    const description = describeError(error);
    if (description.kind === "validation" && isFieldIssue(error)) showFieldIssue(error);
    else showError(error);
  } finally {
    commitButton.disabled = false;
    commitButton.textContent = "存入时光";
  }
}

async function attachSelectedPhotos(): Promise<void> {
  const files = photoInput.files ? Array.from(photoInput.files) : [];
  photoInput.value = "";
  clearErrorBox();
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await session.attachPhoto({
        fileName: file.name,
        bytes,
        caption: "",
        mediaType: file.type,
      });
    } catch (error) {
      showError(error);
    }
  }
}

async function restoreLastDraft(): Promise<void> {
  try {
    const preferred = window.localStorage.getItem(LAST_DRAFT_KEY) ?? undefined;
    const row = await recoverLastDraft(api, preferred);
    if (row === null) {
      setView("drafts");
      return;
    }
    openInEditor(row);
    setView("editor");
    showAppNotice("已为你恢复上次没写完的草稿", "calm");
  } catch (error) {
    showError(error);
    setView("drafts");
  }
}

draftsTab.addEventListener("click", () => { void showDrafts(); });
timelineTab.addEventListener("click", () => { void showTimeline(); });
newDraftButton.addEventListener("click", () => { void startNewDraft(); });
backButton.addEventListener("click", () => { void showDrafts(); });
commitButton.addEventListener("click", () => { void commitCurrent(); });
photoInput.addEventListener("change", () => { void attachSelectedPhotos(); });

editorTitle.addEventListener("input", () => {
  clearAppNotice();
  session.edit({ title: editorTitle.value });
});
editorBody.addEventListener("input", () => {
  clearAppNotice();
  session.edit({ body: editorBody.value });
});
editorDate.addEventListener("input", () => {
  clearAppNotice();
  session.edit({ eventDate: editorDate.value });
});
editorTime.addEventListener("input", () => {
  clearAppNotice();
  session.edit({ eventTime: editorTime.value.trim().length > 0 ? editorTime.value : null });
});

window.addEventListener("beforeunload", () => {
  void session.flush().catch((error: unknown) => { showError(error); });
});
// 移动端（Android）切到后台/被系统回收前通常不触发 beforeunload：隐藏时也立即 flush。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    void session.flush().catch((error: unknown) => { showError(error); });
  }
});
window.addEventListener("pagehide", () => {
  void session.flush().catch((error: unknown) => { showError(error); });
});

async function boot(): Promise<void> {
  if (memory !== null) {
    showPreviewNotice();
    if (demo) await seedDemo(memory);
    if (params.get("fail") === "conflict") memory.failNext("REVISION_CONFLICT", "commitRecord");
    if (params.get("fail") === "uncertain") memory.durabilityMode = "uncertain";
  }
  await refreshDrafts();
  await refreshTimeline();
  if (demo) {
    setView("drafts");
    return;
  }
  await restoreLastDraft();
}

void boot().catch((error: unknown) => {
  showError(error);
  setView("drafts");
});
