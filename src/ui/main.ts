import { DraftSession, recoverLastDraft } from "../domain/draft-session.ts";
import type { DraftSessionSnapshot } from "../domain/draft-session.ts";
import { describeError } from "../domain/errors.ts";
import type { ErrorDescription } from "../domain/errors.ts";
import { durabilityLabel, formalHeadline, formatEventWhen } from "../domain/format.ts";
import type { BackupSummary, ConflictCopy, FieldIssue, PhotoUse, RecordRow } from "../domain/types.ts";
import { formalItems } from "../domain/view.ts";
import type { FormalListItem } from "../domain/view.ts";
import type { ShiguangApi } from "../platform/api.ts";
import { MemoryAdapter } from "../platform/memory-adapter.ts";
import { createTauriApi, tauriInvokeFromWindow } from "../platform/tauri-adapter.ts";
import { PREVIEW_STORAGE_KEY, seedDemo } from "./demo.ts";

const LAST_DRAFT_KEY = "shiguang.lastDraft";

type View = "drafts" | "editor" | "timeline" | "trash" | "data";

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
const trashTab = byTestId<HTMLButtonElement>("trash-tab");
const dataTab = byTestId<HTMLButtonElement>("data-tab");
const viewData = byId<HTMLElement>("view-data");
const exportBackupButton = byTestId<HTMLButtonElement>("export-backup");
const exportResult = byTestId<HTMLDivElement>("export-result");
const pickBackupButton = byTestId<HTMLButtonElement>("pick-backup");
const pickedBackup = byTestId<HTMLDivElement>("picked-backup");
const pickedSummary = byId<HTMLDivElement>("picked-summary");
const restoreBackupButton = byTestId<HTMLButtonElement>("restore-backup");
const discardPickedButton = byTestId<HTMLButtonElement>("discard-picked");
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
const viewTrash = byId<HTMLElement>("view-trash");
const draftList = byId<HTMLDivElement>("draft-list");
const timelineList = byId<HTMLDivElement>("timeline-list");
const trashList = byId<HTMLDivElement>("trash-list");
const photoGrid = byId<HTMLDivElement>("photo-grid");
const emptyTrashButton = byTestId<HTMLButtonElement>("empty-trash-button");
const conflictActions = byId<HTMLElement>("conflict-actions");
const keepMineButton = byTestId<HTMLButtonElement>("keep-mine");
const keepFormalButton = byTestId<HTMLButtonElement>("keep-formal");
const appShell = byId<HTMLElement>("app-shell");
const storeBlocked = byTestId<HTMLElement>("store-blocked");
const storeBlockedTitle = byId<HTMLElement>("store-blocked-title");
const storeBlockedDetail = byId<HTMLParagraphElement>("store-blocked-detail");
const confirmDialog = byTestId<HTMLDialogElement>("confirm-dialog");
const confirmTitle = byId<HTMLElement>("confirm-title");
const confirmMessage = byId<HTMLParagraphElement>("confirm-message");
const confirmOk = byTestId<HTMLButtonElement>("confirm-ok");
const confirmCancel = byTestId<HTMLButtonElement>("confirm-cancel");

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

let currentView: View = "drafts";
let photoKey: string | null = null;

function createSession(): DraftSession<number> {
  const created = new DraftSession<number>({
    api,
    schedule: (fn, ms) => window.setTimeout(fn, ms),
    cancel: (handle) => window.clearTimeout(handle),
    debounceMs: 800,
  });
  created.onChange((state) => {
    renderStatus(state);
    renderPhotos(state.snapshot.photos);
    const recordId = state.recordId;
    if (recordId !== null && currentView === "editor"
      && (state.status === "saved" || state.status === "savedUncertain")) {
      window.localStorage.setItem(LAST_DRAFT_KEY, recordId);
    }
  });
  return created;
}

let session: DraftSession<number> = createSession();

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
  viewTrash.hidden = view !== "trash";
  viewData.hidden = view !== "data";
  dataTab.classList.toggle("is-active", view === "data");
  dataTab.setAttribute("aria-selected", String(view === "data"));
  const draftsActive = view === "drafts" || view === "editor";
  draftsTab.classList.toggle("is-active", draftsActive);
  timelineTab.classList.toggle("is-active", view === "timeline");
  trashTab.classList.toggle("is-active", view === "trash");
  draftsTab.setAttribute("aria-selected", String(draftsActive));
  timelineTab.setAttribute("aria-selected", String(view === "timeline"));
  trashTab.setAttribute("aria-selected", String(view === "trash"));
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

let confirmSettler: ((value: boolean) => void) | null = null;

function finishConfirm(value: boolean): void {
  const settle = confirmSettler;
  confirmSettler = null;
  confirmDialog.close();
  settle?.(value);
}

/** 应用内二次确认；不使用 window.confirm，取消/关闭一律按“不执行”处理。 */
function askConfirm(title: string, message: string, okLabel = "确定"): Promise<boolean> {
  if (confirmSettler !== null) finishConfirm(false);
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmOk.textContent = okLabel;
  return new Promise<boolean>((resolve) => {
    confirmSettler = resolve;
    confirmDialog.showModal();
  });
}

confirmOk.addEventListener("click", () => { finishConfirm(true); });
confirmCancel.addEventListener("click", () => { finishConfirm(false); });
confirmDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  finishConfirm(false);
});
confirmDialog.addEventListener("close", () => {
  const settle = confirmSettler;
  confirmSettler = null;
  settle?.(false);
});

/** 启动失败时只展示中文提示，不加载任何列表，也不提供写操作。 */
function showStoreBlocked(code: string, error: unknown): void {
  const description = describeError(error);
  storeBlockedTitle.textContent = code === "STORE_LOCKED"
    ? "拾光已在别处打开"
    : code === "SCHEMA_TOO_NEW" ? "需要更新拾光" : "数据暂时无法打开";
  storeBlockedDetail.textContent = description.detail;
  appShell.hidden = true;
  storeBlocked.hidden = false;
}

async function gateStore(): Promise<boolean> {
  try {
    const status = await api.storeStatus();
    if (status.ok) return true;
    showStoreBlocked(status.code, { code: status.code, message: status.message });
  } catch (error) {
    showStoreBlocked("", error);
  }
  return false;
}

async function reportMedia(): Promise<void> {
  try {
    const report = await api.mediaReport();
    const messages: string[] = [];
    if (report.quarantined.length > 0) {
      messages.push(`发现 ${report.quarantined.length} 个未被记录使用的照片文件，已移到隔离文件夹（没有删除）`);
    }
    if (report.missing.length > 0) {
      messages.push(`有 ${report.missing.length} 张照片原图缺失`);
    }
    if (messages.length > 0) showAppNotice(messages.join("；"), "warn");
  } catch (error) {
    showError(error);
  }
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
  conflictActions.hidden = state.status !== "conflict" || state.recordId === null;
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

function photoPlaceholder(holder: HTMLElement, status: "missing" | "corrupt"): void {
  const fallback = document.createElement("span");
  fallback.className = "photo-fallback";
  fallback.setAttribute("data-testid", status === "missing" ? "photo-missing" : "photo-corrupt");
  fallback.textContent = status === "missing" ? "原图缺失" : "原图校验失败";
  holder.append(fallback);
}

async function loadPhoto(img: HTMLImageElement, assetId: string, holder: HTMLElement): Promise<void> {
  try {
    const status = await api.photoStatus(assetId);
    if (status !== "available") {
      img.remove();
      photoPlaceholder(holder, status);
      return;
    }
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
    const [rows, copies] = await Promise.all([api.listDrafts(), api.listConflictCopies()]);
    const sorted = rows
      .filter((row) => row.draft !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.recordId.localeCompare(a.recordId));
    renderDrafts(sorted, copies);
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

function conflictCopyCard(copy: ConflictCopy): HTMLElement {
  const article = document.createElement("article");
  article.className = "timeline-card";
  article.setAttribute("data-testid", "conflict-copy-item");

  const head = document.createElement("div");
  head.className = "card-head";
  const title = document.createElement("h3");
  title.className = "timeline-title";
  title.textContent = formalHeadline(copy.snapshot);
  const badge = document.createElement("span");
  badge.className = "pill is-pending";
  badge.textContent = "冲突副本";
  head.append(title, badge);
  article.append(head);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.textContent = `${formatEventWhen(copy.snapshot)} · 另存于 ${formatUpdated(copy.createdAt)}`;
  article.append(meta);

  const body = previewText(copy.snapshot.body, 120);
  if (body.length > 0) {
    const paragraph = document.createElement("p");
    paragraph.className = "timeline-body";
    paragraph.textContent = body;
    article.append(paragraph);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const restore = document.createElement("button");
  restore.type = "button";
  restore.className = "button ghost";
  restore.setAttribute("data-testid", "restore-copy-button");
  restore.textContent = "恢复为草稿";
  restore.addEventListener("click", () => { void restoreCopy(copy); });
  actions.append(restore);
  article.append(actions);
  return article;
}

function conflictCopySection(copies: readonly ConflictCopy[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "conflict-copies";
  const heading = document.createElement("h2");
  heading.textContent = "冲突副本";
  const hint = document.createElement("p");
  hint.className = "conflict-hint";
  hint.textContent = "发生冲突时保留的草稿，恢复后会回到草稿列表。";
  section.append(heading, hint, ...copies.map(conflictCopyCard));
  return section;
}

async function restoreCopy(copy: ConflictCopy): Promise<void> {
  clearErrorBox();
  try {
    await api.restoreConflictCopy(copy.conflictId);
    showAppNotice("冲突副本已恢复为草稿", "ok");
    await refreshDrafts();
  } catch (error) {
    showError(error);
  }
}

function renderDrafts(rows: readonly RecordRow[], copies: readonly ConflictCopy[]): void {
  const nodes: HTMLElement[] = [];
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有草稿，点上面的「新建草稿」写第一篇吧。";
    nodes.push(empty);
  } else {
    nodes.push(...rows.map(draftCard));
  }
  if (copies.length > 0) nodes.push(conflictCopySection(copies));
  draftList.replaceChildren(...nodes);
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

  const trash = document.createElement("button");
  trash.type = "button";
  trash.className = "button ghost danger";
  trash.setAttribute("data-testid", "trash-button");
  trash.textContent = "移到回收站";
  trash.addEventListener("click", () => { void trashTimelineItem(item.recordId, formalHeadline(item)); });
  actions.append(trash);

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

async function trashTimelineItem(recordId: string, headline: string): Promise<void> {
  const confirmed = await askConfirm(
    "移到回收站？",
    `「${headline}」移到回收站后可以随时恢复。`,
    "移到回收站",
  );
  if (!confirmed) return;
  clearErrorBox();
  try {
    await api.trashRecord(recordId);
    showAppNotice("已移到回收站，可以随时恢复", "calm");
    await refreshTimeline();
  } catch (error) {
    showError(error);
  }
}

async function refreshTrash(): Promise<void> {
  try {
    renderTrash(await api.listTrash());
  } catch (error) {
    showError(error);
  }
}

function trashCard(row: RecordRow): HTMLElement {
  const article = document.createElement("article");
  article.className = "timeline-card";
  article.setAttribute("data-testid", "trash-item");

  const snapshot = row.formal ?? row.draft;
  const head = document.createElement("div");
  head.className = "card-head";
  const title = document.createElement("h3");
  title.className = "timeline-title";
  title.textContent = snapshot ? formalHeadline(snapshot) : "（无题）";
  head.append(title);
  article.append(head);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  const when = snapshot ? formatEventWhen(snapshot) : "日期未填写";
  const movedAt = row.trashedAt ? formatUpdated(row.trashedAt) : "时间未知";
  meta.textContent = `${when} · 移入回收站 ${movedAt}`;
  article.append(meta);

  const body = snapshot ? previewText(snapshot.body, 120) : "";
  if (body.length > 0) {
    const paragraph = document.createElement("p");
    paragraph.className = "timeline-body";
    paragraph.textContent = body;
    article.append(paragraph);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const restore = document.createElement("button");
  restore.type = "button";
  restore.className = "button ghost";
  restore.setAttribute("data-testid", "restore-button");
  restore.textContent = "恢复";
  restore.addEventListener("click", () => { void restoreTrashItem(row.recordId); });
  actions.append(restore);

  const purge = document.createElement("button");
  purge.type = "button";
  purge.className = "button ghost danger";
  purge.setAttribute("data-testid", "purge-button");
  purge.textContent = "永久删除";
  purge.addEventListener("click", () => { void purgeTrashItem(row.recordId); });
  actions.append(purge);

  article.append(actions);
  return article;
}

function renderTrash(rows: readonly RecordRow[]): void {
  emptyTrashButton.disabled = rows.length === 0;
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "回收站是空的";
    trashList.replaceChildren(empty);
    return;
  }
  trashList.replaceChildren(...rows.map(trashCard));
}

async function restoreTrashItem(recordId: string): Promise<void> {
  clearErrorBox();
  try {
    await api.restoreRecord(recordId);
    showAppNotice("已恢复这条时光", "ok");
    await refreshTrash();
  } catch (error) {
    showError(error);
  }
}

async function purgeTrashItem(recordId: string): Promise<void> {
  const confirmed = await askConfirm(
    "永久删除这条记录？",
    "永久删除后不可撤销。照片原件不会直接删除，会移到本机隔离文件夹。",
    "永久删除",
  );
  if (!confirmed) return;
  clearErrorBox();
  try {
    await api.purgeRecord(recordId);
    showAppNotice("已永久删除这条记录", "calm");
    await refreshTrash();
  } catch (error) {
    showError(error);
  }
}

async function emptyTrash(): Promise<void> {
  const confirmed = await askConfirm(
    "清空回收站？",
    "清空后，回收站里的所有记录将被永久删除，不可撤销。照片原件不会直接删除，会移到本机隔离文件夹。",
    "全部永久删除",
  );
  if (!confirmed) return;
  clearErrorBox();
  try {
    await api.emptyTrash();
    showAppNotice("回收站已清空", "calm");
    await refreshTrash();
  } catch (error) {
    showError(error);
  }
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

async function showTrash(): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  setView("trash");
  await refreshTrash();
}

// ---- Unit-0.5 数据与备份 ----
let pickedToken: string | null = null;

function summaryList(summary: BackupSummary, extra: Array<[string, string]> = []): HTMLDListElement {
  const dl = document.createElement("dl");
  const c = summary.counts;
  const rows: Array<[string, string]> = [
    ["导出时间", formatUpdated(summary.exportedAt)],
    ["正式记录", `${c.formal} 条`],
    ["草稿", `${c.drafts} 份`],
    ["回收站", `${c.trashed} 条`],
    ["冲突副本", `${c.conflictCopies} 份`],
    ["删除记录", `${c.deletionMarkers} 条`],
    ["照片原件", `${c.mediaFiles} 张${c.missingMedia > 0 ? `（另有 ${c.missingMedia} 张原图缺失，未包含）` : ""}`],
    ["文件大小", formatBytes(summary.bytes)],
    ["拾光版本", summary.appVersion],
    ...extra,
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    dl.append(dt, dd);
  }
  return dl;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function showData(): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  setView("data");
}

async function exportBackupNow(): Promise<void> {
  clearErrorBox();
  exportBackupButton.disabled = true;
  exportBackupButton.textContent = "正在导出…";
  try {
    const result = await api.exportBackup();
    if (result.cancelled) { showAppNotice("已取消导出，没有生成文件", "calm"); return; }
    const head = document.createElement("strong");
    head.textContent = "备份已导出并校验通过";
    const where = document.createElement("p");
    where.className = "data-desc";
    where.textContent = `${result.fileName} → ${result.location}`;
    const nodes: Node[] = [head, where, summaryList(result.summary, [["校验和", `sha256 ${result.sha256.slice(0, 16)}…`]])];
    if (result.missingMedia.length > 0) {
      const warn = document.createElement("p");
      warn.className = "data-desc warn-text";
      warn.textContent = `有 ${result.missingMedia.length} 张原图在本机已缺失，未包含在备份中。`;
      nodes.push(warn);
    }
    exportResult.replaceChildren(...nodes);
    exportResult.className = "data-result ok";
    exportResult.hidden = false;
    showAppNotice("备份已导出。建议把它再拷到这台设备以外的地方。", "ok");
  } catch (error) {
    showError(error);
  } finally {
    exportBackupButton.disabled = false;
    exportBackupButton.textContent = "导出备份";
  }
}

async function clearPicked(): Promise<void> {
  const token = pickedToken;
  pickedToken = null;
  pickedBackup.hidden = true;
  pickedSummary.replaceChildren();
  if (token !== null) await api.discardPickedBackup(token).catch(() => undefined);
}

async function pickBackupNow(): Promise<void> {
  clearErrorBox();
  await clearPicked();
  pickBackupButton.disabled = true;
  pickBackupButton.textContent = "正在校验…";
  try {
    const result = await api.pickBackup();
    if (result.cancelled) { showAppNotice("没有选择文件，当前数据未改动", "calm"); return; }
    pickedToken = result.token;
    const head = document.createElement("strong");
    head.textContent = `校验通过：${result.fileName}`;
    pickedSummary.replaceChildren(head, summaryList(result.summary));
    pickedBackup.hidden = false;
  } catch (error) {
    showError(error);
  } finally {
    pickBackupButton.disabled = false;
    pickBackupButton.textContent = "选择备份文件…";
  }
}

async function restoreBackupNow(): Promise<void> {
  const token = pickedToken;
  if (token === null) return;
  const confirmed = await askConfirm(
    "用这份备份替换当前全部数据？",
    "恢复会用这份备份替换当前全部数据，包括正式记录、草稿、回收站和冲突副本；你在备份之后新写的内容会被替换掉。"
      + "旧备份里也可能包含你后来已经删除的内容，它们会重新出现。"
      + "恢复前拾光会自动在本机保留一份当前数据的安全副本。确定要继续吗？",
    "确认覆盖恢复",
  );
  if (!confirmed) return;
  clearErrorBox();
  restoreBackupButton.disabled = true;
  restoreBackupButton.textContent = "正在恢复…";
  try {
    if (!(await flushBeforeLeave())) return;
    const result = await api.restoreBackup(token);
    pickedToken = null;
    pickedBackup.hidden = true;
    session = createSession();
    window.localStorage.removeItem(LAST_DRAFT_KEY);
    const r = result.restored;
    showAppNotice(`恢复完成：${r.formal} 条正式记录、${r.drafts} 份草稿、${r.trashed} 条回收站记录。恢复前的数据已保存在 ${result.safetyBackup}`, "ok");
    exportResult.hidden = true;
    await refreshDrafts();
    await refreshTimeline();
  } catch (error) {
    showError(error);
  } finally {
    restoreBackupButton.disabled = false;
    restoreBackupButton.textContent = "用这份备份覆盖恢复";
  }
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

async function resolveKeepMine(): Promise<void> {
  const recordId = session.state.recordId;
  if (recordId === null) return;
  clearErrorBox();
  keepMineButton.disabled = true;
  keepFormalButton.disabled = true;
  try {
    const result = await api.resolveConflict(recordId, "keepMine");
    session = createSession();
    openInEditor(result.row);
    showAppNotice("已以你的草稿为准，确认无误后再点“存入时光”", "ok");
    setView("editor");
  } catch (error) {
    showError(error);
  } finally {
    keepMineButton.disabled = false;
    keepFormalButton.disabled = false;
  }
}

async function resolveKeepFormal(): Promise<void> {
  const recordId = session.state.recordId;
  if (recordId === null) return;
  clearErrorBox();
  keepMineButton.disabled = true;
  keepFormalButton.disabled = true;
  try {
    await api.resolveConflict(recordId, "keepFormal");
    session = createSession();
    window.localStorage.removeItem(LAST_DRAFT_KEY);
    showAppNotice("你的草稿已另存为冲突副本，不会丢失", "ok");
    await showDrafts();
  } catch (error) {
    showError(error);
  } finally {
    keepMineButton.disabled = false;
    keepFormalButton.disabled = false;
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

trashTab.addEventListener("click", () => { void showTrash(); });
dataTab.addEventListener("click", () => { void showData(); });
exportBackupButton.addEventListener("click", () => { void exportBackupNow(); });
pickBackupButton.addEventListener("click", () => { void pickBackupNow(); });
restoreBackupButton.addEventListener("click", () => { void restoreBackupNow(); });
discardPickedButton.addEventListener("click", () => { void clearPicked(); });
emptyTrashButton.addEventListener("click", () => { void emptyTrash(); });
keepMineButton.addEventListener("click", () => { void resolveKeepMine(); });
keepFormalButton.addEventListener("click", () => { void resolveKeepFormal(); });

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
  // 启动先确认数据目录可用（第二个实例 STORE_LOCKED / 数据版本过新 SCHEMA_TOO_NEW），不可用时不做任何写操作。
  if (!(await gateStore())) return;
  await reportMedia();
  await refreshDrafts();
  await refreshTimeline();
  if (params.get("view") === "data") {
    setView("data");
    return;
  }
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
