import { icon } from "./icons.ts";
import type { UiPreferences } from "./appearance.ts";
import { mobilePreview } from "./mobile-preview.ts";
import { bindLocalBack, type BackLayer } from "./local-back.ts";
import { bindTimelineSheet } from "./timeline-sheet.ts";
import { renderReading, renderStoryReading } from "./reading.ts";
import { PersonalUi } from "./personal.ts";
import { MuseumUi } from "./museum.ts";
import { SearchUi } from "./search.ts";
import { searchAwareApi } from "./search-source.ts";
import { SEARCH_DEMO_STORAGE_KEY, searchDemoClock, searchDemoMode, seedSearchDemo } from "./search-demo.ts";
import type { Mood } from "../domain/types.ts";
import { recoverLastDraft } from "../domain/draft-session.ts";
import { StoryEditor } from "../domain/story-editor.ts";
import { plainText, storyPhotos } from "../domain/story.ts";
import { bindTyping, showValue, StoryBlocksUi } from "./story-controls.ts";
import type { DraftSessionSnapshot } from "../domain/draft-session.ts";
import { describeError } from "../domain/errors.ts";
import type { ErrorDescription } from "../domain/errors.ts";
import { durabilityLabel, formalHeadline, formatEventWhen } from "../domain/format.ts";
import { LAST_TAB_KEY, NAV_TABS, initialTab, rememberableTab, tabOf, timelineEmptyKind } from "../domain/navigation.ts";
import type { MainTab, View } from "../domain/navigation.ts";
import { calendarGrid, countLabel, daysInMonth, localToday } from "../domain/timeline.ts";
import type {
  BackupSummary, CalendarDay, ConflictCopy, FieldIssue, PhotoUse, RecordRow, TagInfo, TimelineFilter, TimelineItem,
} from "../domain/types.ts";
import type { ShiguangApi } from "../platform/api.ts";
import { MemoryAdapter } from "../platform/memory-adapter.ts";
import { createTauriApi, tauriInvokeFromWindow } from "../platform/tauri-adapter.ts";
import { PREVIEW_STORAGE_KEY, seedDemo } from "./demo.ts";

import { gateWithRetry } from "../domain/startup.ts";
const LAST_DRAFT_KEY = "shiguang.lastDraft";

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

const navTabs = byId<HTMLElement>("nav-tabs");
const tabButtons = new Map<MainTab, HTMLButtonElement>();
for (const tab of NAV_TABS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tab";
  button.dataset.testid = tab.testId;
  button.dataset.navTab = tab.id;
  button.setAttribute("aria-label", tab.label);
  // Page navigation includes a create action and secondary pages, not an ARIA tab widget.
  button.setAttribute("aria-current", "false");
  const label = document.createElement("span");
  label.className = "tab-label";
  label.textContent = tab.label;
  button.append(icon(tab.id), label);
  button.addEventListener("click", () => { void activateMainTab(tab.id); });
  navTabs.append(button);
  tabButtons.set(tab.id, button);
}
const viewData = byId<HTMLElement>("view-data");
const exportBackupButton = byTestId<HTMLButtonElement>("export-backup");
const exportResult = byTestId<HTMLDivElement>("export-result");
const pickBackupButton = byTestId<HTMLButtonElement>("pick-backup");
const pickedBackup = byTestId<HTMLDivElement>("picked-backup");
const pickedSummary = byId<HTMLDivElement>("picked-summary");
const restoreBackupButton = byTestId<HTMLButtonElement>("restore-backup");
const discardPickedButton = byTestId<HTMLButtonElement>("discard-picked");
const encryptToggle = byTestId<HTMLInputElement>("encrypt-toggle");
const encryptFields = byId<HTMLDivElement>("encrypt-fields");
const plainWarning = byId<HTMLParagraphElement>("plain-warning");
const backupPassword = byTestId<HTMLInputElement>("backup-password");
const backupPassword2 = byTestId<HTMLInputElement>("backup-password2");
const unlockArea = byId<HTMLDivElement>("unlock-area");
const unlockPassword = byTestId<HTMLInputElement>("unlock-password");
const unlockButton = byTestId<HTMLButtonElement>("unlock-backup");
const pickedActions = byId<HTMLDivElement>("picked-actions");
const mergeBackupButton = byTestId<HTMLButtonElement>("merge-backup");
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
const viewCalendar = byId<HTMLElement>("view-calendar");
const viewCollect = byId<HTMLElement>("view-collect");
const viewTrash = byId<HTMLElement>("view-trash");
const draftList = byId<HTMLDivElement>("draft-list");
const timelineList = byId<HTMLDivElement>("timeline-list");
const trashList = byId<HTMLDivElement>("trash-list");
const photoGrid = byId<HTMLDivElement>("photo-grid");
const emptyTrashButton = byTestId<HTMLButtonElement>("empty-trash-button");
const conflictActions = byId<HTMLElement>("conflict-actions");
const keepMineButton = byTestId<HTMLButtonElement>("keep-mine");
const keepFormalButton = byTestId<HTMLButtonElement>("keep-formal");
const confirmDialog = byTestId<HTMLDialogElement>("confirm-dialog");
const confirmTitle = byId<HTMLElement>("confirm-title");
const confirmMessage = byId<HTMLParagraphElement>("confirm-message");
const confirmOk = byTestId<HTMLButtonElement>("confirm-ok");
const confirmCancel = byTestId<HTMLButtonElement>("confirm-cancel");

// ---- Unit-0.7 时光轴 / 日历 / 标签 ----
const jumpMonth = byTestId<HTMLSelectElement>("jump-month");
const jumpLatest = byTestId<HTMLButtonElement>("jump-latest");
const orderToggle = byTestId<HTMLButtonElement>("order-toggle");
const favoriteFilter = byTestId<HTMLInputElement>("favorite-filter");
const manageTagsButton = byTestId<HTMLButtonElement>("manage-tags");
const tagFilterBar = byId<HTMLDivElement>("tag-filter-bar");
const tagFilterChips = byId<HTMLDivElement>("tag-filter-chips");
const timelineSummary = byTestId<HTMLParagraphElement>("timeline-summary");
const timelineSentinel = byTestId<HTMLDivElement>("timeline-sentinel");
const calPrev = byTestId<HTMLButtonElement>("cal-prev");
const calNext = byTestId<HTMLButtonElement>("cal-next");
const calTitle = byId<HTMLHeadingElement>("cal-title");
const calMonthInput = byTestId<HTMLInputElement>("cal-month-input");
const calToday = byTestId<HTMLButtonElement>("cal-today");
const calGrid = byId<HTMLDivElement>("cal-grid");
const calEmpty = byId<HTMLParagraphElement>("cal-empty");
const calEmptyWrite = byTestId<HTMLButtonElement>("cal-empty-write");
const dayPanelTitle = byId<HTMLHeadingElement>("day-panel").querySelector("h2") as HTMLHeadingElement;
const dayPanelDate = byId<HTMLParagraphElement>("day-panel-date");
const dayPanelList = byId<HTMLDivElement>("day-panel-list");
const onThisDayTitle = byId<HTMLHeadingElement>("on-this-day-title");
const onThisDaySub = byId<HTMLParagraphElement>("on-this-day-sub");
const onThisDayList = byId<HTMLDivElement>("on-this-day-list");
const tagDialog = byTestId<HTMLDialogElement>("tag-dialog");
const tagNewInput = byTestId<HTMLInputElement>("tag-new-input");
const tagCreateButton = byTestId<HTMLButtonElement>("tag-create");
const tagDialogStatus = byTestId<HTMLParagraphElement>("tag-dialog-status");
const tagManageList = byId<HTMLDivElement>("tag-manage-list");
const tagCloseButton = byTestId<HTMLButtonElement>("tag-close");
const tagPickerDialog = byTestId<HTMLDialogElement>("tag-picker-dialog");
const tagPickerNew = byTestId<HTMLInputElement>("tag-picker-new");
const tagPickerCreate = byTestId<HTMLButtonElement>("tag-picker-create");
const tagPickerStatus = byTestId<HTMLParagraphElement>("tag-picker-status");
const tagPickerList = byId<HTMLDivElement>("tag-picker-list");
const tagPickerCancel = byTestId<HTMLButtonElement>("tag-picker-cancel");
const tagPickerSave = byTestId<HTMLButtonElement>("tag-picker-save");

// ---- Unit-0.8 主导航 / 继续写提示 / 收藏与标签 ----
const resumeDraftBar = byTestId<HTMLDivElement>("resume-draft");
const resumeDraftButton = byTestId<HTMLButtonElement>("resume-draft-button");
const collectFavorites = byTestId<HTMLDivElement>("collect-favorites");
const collectTags = byTestId<HTMLDivElement>("collect-tags");
const collectManageTags = byTestId<HTMLButtonElement>("collect-manage-tags");
const openTrashButton = byTestId<HTMLButtonElement>("open-trash");
const backToSettingsButton = byTestId<HTMLButtonElement>("back-to-settings");

const filterEntry = byTestId<HTMLButtonElement>("timeline-filters");
const timelineSheet = byId<HTMLDialogElement>("timeline-sheet");
const activeConditions = byId("active-conditions");
const filterResult = byId("filter-result");
filterEntry.prepend(icon("filters"));
byTestId("timeline-search").prepend(icon("search"));
const syncBack = bindLocalBack(backLayers, () => !byId("app-shell").inert, showError);
const openTimelineSheet = bindTimelineSheet(timelineSheet, filterEntry, byTestId("filters-close"),
  () => currentView === "timeline" && !byId("app-shell").inert, syncBack);

const params = new URLSearchParams(window.location.search);
const invoke = tauriInvokeFromWindow();
const visualPreview = mobilePreview(params, invoke !== null);
// Last-tab and last-draft hints are optional, including on hosts that deny Web Storage.
const uiPreferences: UiPreferences = visualPreview?.preferences ?? {
  getItem(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
  setItem(key, value) { try { window.localStorage.setItem(key, value); } catch { /* optional hint */ } },
  removeItem(key) { try { window.localStorage.removeItem(key); } catch { /* optional hint */ } },
};
const searchDemo = searchDemoMode(params, invoke !== null);
const demo = invoke === null && searchDemo === null && params.get("demo") === "1";

const memory = visualPreview?.adapter ?? (invoke === null
  ? new MemoryAdapter({ storage: window.localStorage, deferOpen: true, storageKey: searchDemo !== null ? SEARCH_DEMO_STORAGE_KEY : PREVIEW_STORAGE_KEY,
    ...(searchDemo !== null ? { now: searchDemoClock(), search: "" } : {}) })
  : null);
let search: SearchUi;
let formalGeneration = 0;
const api: ShiguangApi = searchAwareApi(memory ?? createTauriApi(invoke!), () => {
  formalGeneration++;
  search?.invalidate();
});

let currentView: View = "timeline";
let photoKey: string | null = null;

const blocksUi = new StoryBlocksUi(byId("story-blocks"));
const parked = new Set<StoryEditor>();
const pendingUrls = new Map<string, string>();
const chooseDraft = byId<HTMLDialogElement>("choose-draft");
let editor = makeEditor(null, "");
let unsubscribeEditor: (() => void) | undefined;
let originHasFormal = false;
let lastEditorFocus: HTMLElement | null = null;

function makeEditor(row: RecordRow | null, defaultDate: string) {
  return new StoryEditor({ api, row, defaultDate,
    schedule: (fn, ms) => window.setTimeout(fn, ms), cancel: handle => window.clearTimeout(handle) });
}

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

const mainScroller = byId("main-content");
function scrollPosition() { return { main: mainScroller.scrollTop, window: window.scrollY }; }
type ScrollPosition = ReturnType<typeof scrollPosition>;
const tabPositions = new Map<View, ScrollPosition>();
function restoreScroll(place?: ScrollPosition) {
  mainScroller.scrollTop = place?.main ?? 0;
  window.scrollTo(0, place?.window ?? 0);
}

function setView(view: View): void {
  if (currentView === "timeline" || currentView === "calendar") tabPositions.set(currentView, scrollPosition());
  if (timelineSheet.open && view !== "timeline") timelineSheet.close();
  if (currentView === "search" && view !== "search") search.leave();
  currentView = view;
  for (const id of ["mine", "museum", "reading", "storage", "appearance", "privacy", "search"]) byId(`view-${id}`).hidden = view !== id;
  byTestId("sidebar-search").setAttribute("aria-current", view === "search" || view === "reading" && readingOrigin === "search" ? "page" : "false");
  if (view === "storage") void personal.renderStorage().catch(showError);
  if (view === "privacy" || view === "appearance") void personal.refresh().catch(showError);
  viewDrafts.hidden = view !== "drafts";
  viewEditor.hidden = view !== "editor";
  viewTimeline.hidden = view !== "timeline";
  viewCalendar.hidden = view !== "calendar";
  viewCollect.hidden = view !== "collect";
  viewTrash.hidden = view !== "trash";
  viewData.hidden = view !== "settings";
  const active = view === "reading" ? tabOf(readingOrigin) : tabOf(view);
  for (const [id, button] of tabButtons) {
    const on = id === active;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-current", on ? "page" : "false");
  }
  const panelId = view === "settings" ? "view-data" : `view-${view}`;
  const heading = document.getElementById(panelId)?.querySelector<HTMLElement>("h1");
  if (heading && !document.querySelector<HTMLElement>(".app-shell")?.inert) {
    heading.tabIndex = -1;
    heading.focus({preventScroll: true});
  }
  if (view === "editor") backButton.textContent = readingId ? "← 返回阅读" : "← 全部草稿";
  restoreScroll(tabPositions.get(view));
  syncBack();
  const remembered = rememberableTab(view);
  if (remembered !== null) uiPreferences.setItem(LAST_TAB_KEY, remembered);
  // 数据打不开时，每个页签都显示同一条错误提示，但导航始终可用。
  if (blockedDescription !== null) showErrorDescription(blockedDescription);
}

function showPreviewNotice(): void {
  previewNotice.hidden = false;
  previewNotice.textContent = visualPreview ? "合成预览 · 刷新后重新开始" : "浏览器预览 · 数据仅保存在本浏览器";
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
  notice.hidden = true;
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

interface EmptyCardOptions {
  title: string;
  message: string;
  actionLabel?: string;
  actionTestId?: string;
  onAction?: () => void;
  testId?: string;
}

/** 空态卡片：一句说明 + 一个合适的下一步按钮，别让页面成为死路。 */
function emptyCard(options: EmptyCardOptions): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "empty-card";
  if (options.testId !== undefined) card.dataset.testid = options.testId;
  const title = document.createElement("h2");
  title.textContent = options.title;
  const message = document.createElement("p");
  message.textContent = options.message;
  card.append(title, message);
  const action = options.onAction;
  if (options.actionLabel !== undefined && action !== undefined) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    if (options.actionTestId !== undefined) button.dataset.testid = options.actionTestId;
    button.textContent = options.actionLabel;
    button.addEventListener("click", action);
    card.append(button);
  }
  return card;
}

function blockedCard(): HTMLDivElement {
  return emptyCard({
    title: blockedTitle.length > 0 ? blockedTitle : "数据暂时无法打开",
    message: blockedDescription?.detail ?? "稍后可以再试一次。",
    testId: "blocked-state",
  });
}

/** 启动门禁失败时，把同一个错误提示放进每个列表，页签切换不会卡在“正在加载”。 */
function renderBlockedState(): void {
  for (const node of [timelineList, draftList, trashList, dayPanelList, onThisDayList, collectFavorites, collectTags]) {
    node.replaceChildren(blockedCard());
  }
  timelineSummary.textContent = "";
  calGrid.replaceChildren();
  calEmpty.hidden = true;
  resumeDraftBar.hidden = true;
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
  if (byId("app-shell").inert) return Promise.resolve(false);
  if (confirmSettler !== null) finishConfirm(false);
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmOk.textContent = okLabel;
  return new Promise<boolean>((resolve) => {
    confirmSettler = resolve;
    confirmDialog.showModal();
    syncBack();
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

/** 数据目录不可用时保留错误，直到启动重试成功。 */
let blockedDescription: ErrorDescription | null = null;
let blockedTitle = "";

function showStoreBlocked(code: string, error: unknown): void {
  const description = describeError(error);
  blockedDescription = description;
  blockedTitle = code === "STORE_LOCKED"
    ? "拾光已在别处打开"
    : code === "SCHEMA_TOO_NEW" ? "需要更新拾光" : code === "STORE_STARTING" ? "拾光还在打开数据" : "数据暂时无法打开";
  showErrorDescription({ ...description, title: blockedTitle });
}

async function waitForStore(): Promise<void> {
  // 数据仍在打开（STORE_STARTING）或宿主刚重建时短暂重试，不把等待误报为“无法打开”。
  for (;;) {
    const outcome = await gateWithRetry(() => api.storeStatus(), (ms) => new Promise((r) => setTimeout(r, ms)));
    if (outcome.ok) {
      if (blockedDescription !== null) { blockedDescription = null; blockedTitle = ""; clearErrorBox(); }
      return;
    }
    showStoreBlocked(outcome.code, outcome.error);
    const advice = outcome.code === "STORE_LOCKED" ? "请关闭另一个拾光窗口，再重试或重新打开应用。"
      : outcome.code === "SCHEMA_TOO_NEW" ? "请使用支持这份数据的新版拾光。"
      : "请重试。若仍无法打开，请保留本机数据并重新打开拾光。";
    await personal.waitForStoreRetry(`${blockedTitle}。${advice}`);
  }
}

/** 数据打不开时不允许进入写流程；提示已有的错误，不做无用的写入尝试。 */
function ensureWritable(): boolean {
  if (byId("app-shell").inert) return false;
  if (blockedDescription === null) return true;
  showErrorDescription(blockedDescription);
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
      if (editor.needsReload) { saveStatus.append(text); return; }
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry";
      retry.textContent = "重试";
      retry.addEventListener("click", () => {
        if (!canChangeEditor()) return;
        void editor.flush().catch((error: unknown) => { showError(error); });
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
    img.src = await api.photoThumbUrl(assetId);
  } catch (error) {
    const description = describeError(error);
    img.remove();
    const fallback = document.createElement("span");
    fallback.className = "photo-fallback";
    fallback.textContent = errorCode(error) === "HEIC_UNSUPPORTED" ? "无法预览 HEIC 图片" : description.title;
    fallback.title = description.detail;
    holder.append(fallback);
  }
}

function canChangeEditor() {
  return currentView === "editor" && editor.editable && !byId("app-shell").inert;
}

function pendingPhotoUrl(photo: PhotoUse): string | undefined {
  const input = editor.pendingPhoto(photo.photoUseId);
  if (!input) return;
  let url = pendingUrls.get(photo.photoUseId);
  if (!url) {
    url = URL.createObjectURL(new Blob([Uint8Array.from(input.bytes)], { type: photo.mediaType }));
    pendingUrls.set(photo.photoUseId, url);
  }
  return url;
}

function editorPhotoCell(photo: PhotoUse): HTMLElement {
  const cell = document.createElement("div");
  cell.className = "photo-cell";
  const img = createPhotoThumb(photo.assetId, photo.caption);
  cell.append(img);
  const local = pendingPhotoUrl(photo);
  if (local) img.src = local; else void loadPhoto(img, photo.assetId, cell);
  const id = photo.photoUseId;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "photo-remove";
  remove.textContent = "×";
  remove.title = "移除这张照片";
  remove.setAttribute("aria-label", "移除这张照片");
  remove.addEventListener("click", () => { void confirmRemove(editor.photoIndex(id)); });
  const caption = document.createElement("textarea");
  caption.dataset.testid = "photo-caption"; caption.setAttribute("aria-label", "照片说明"); caption.placeholder = "为这张照片写点说明";
  showValue(caption, photo.caption);
  bindTyping(caption, () => { if (canChangeEditor()) editor.caption(id, caption.value, caption.selectionEnd); });
  const controls = document.createElement("div"); controls.className = "photo-controls";
  const cover = document.createElement("button"); cover.type = "button"; cover.dataset.testid = "photo-cover";
  cover.textContent = editor.story.coverPhotoUseId === id ? "封面 ✓" : "设为封面";
  cover.setAttribute("aria-pressed", String(editor.story.coverPhotoUseId === id));
  cover.addEventListener("click", () => { if (canChangeEditor()) editor.cover(id); }); controls.append(cover);
  for (const [delta, label] of [[-1, "上移"], [1, "下移"]] as const) {
    const move = document.createElement("button"); move.type = "button"; move.textContent = label; move.dataset.testid = delta < 0 ? "photo-up" : "photo-down";
    const index = editor.photoIndex(id), neighbor = editor.story.blocks[index + delta];
    move.disabled = !neighbor || (editor.mode === "quick" && neighbor.kind !== "photo");
    const ordinal = storyPhotos(editor.story).findIndex(p => p.photoUseId === id) + 1;
    move.setAttribute("aria-label", editor.mode === "quick" ? `第 ${ordinal} 张照片${label}` : `第 ${index + 1} 块照片${label}`);
    move.addEventListener("click", () => {
      if (!canChangeEditor()) return;
      editor.move(editor.photoIndex(id), delta);
      const area = editor.mode === "story" ? byId("story-blocks") : photoGrid;
      const moved = Array.from(area.querySelectorAll<HTMLElement>(".photo-cell")).find(node => node.dataset.photoKey === editor.photoKey(id));
      (moved?.querySelector<HTMLButtonElement>(`[data-testid="${move.dataset.testid}"]:not(:disabled)`) ?? moved?.querySelector("textarea"))?.focus();
    }); controls.append(move);
  }
  cell.dataset.photoId = id; cell.dataset.photoKey = editor.photoKey(id);
  cell.append(remove, caption, controls);
  return cell;
}

function renderPhotos(photos: PhotoUse[]) {
  const key = JSON.stringify(photos.map(p => editor.photoKey(p.photoUseId)));
  if (key === photoKey) return;
  photoKey = key;
  if (!photos.length) {
    const empty = document.createElement("p");
    empty.className = "photo-empty"; empty.textContent = "还没有照片，可以附上几张。";
    photoGrid.replaceChildren(empty);
  } else photoGrid.replaceChildren(...photos.map(editorPhotoCell));
}

function focusBlock(index: number) {
  const block = byId("story-blocks").querySelectorAll<HTMLElement>('[data-testid="story-block"]')[index];
  (block?.querySelector<HTMLElement>("textarea") ?? block?.querySelector<HTMLElement>("button") ??
    byId("story-blocks").querySelector<HTMLElement>("select"))?.focus();
}

async function confirmRemove(index: number) {
  const owner = editor, block = editor.story.blocks[index];
  if (!canChangeEditor() || !block) return;
  const description = block.kind === "photo" ? "这张照片及其说明" : "这个故事块";
  if (await askConfirm(`移除${description}？`, "可以在本次编辑中撤销。", "移除") &&
      editor === owner && canChangeEditor() && editor.story.blocks[index] === block) {
    editor.remove(index);
    if (editor.mode === "story") focusBlock(Math.min(index, editor.story.blocks.length - 1));
  }
}

function renderEditor() {
  const state = editor.saveState, { meta } = editor, protectedMode = editor.protected;
  if (!editor.needsReload) parked.delete(editor);
  const storyView = editor.mode === "story" || protectedMode;
  const photos = storyPhotos(editor.story);
  byId("editor-work").hidden = editor.preview;
  byId("draft-preview").hidden = !editor.preview;
  byId<HTMLFieldSetElement>("editor-fields").disabled = !editor.editable;
  byTestId("mode-quick").setAttribute("aria-pressed", String(editor.mode === "quick"));
  byTestId("mode-story").setAttribute("aria-pressed", String(editor.mode === "story"));
  byTestId("enter-story").hidden = !protectedMode;
  byTestId("reload-editor").hidden = !editor.needsReload || protectedMode;
  byTestId<HTMLButtonElement>("draft-preview-open").disabled = protectedMode || editor.publishing;
  const limit = byId("story-limit");
  limit.hidden = !protectedMode;
  limit.textContent = protectedMode ? "速记已锁定全部编辑操作。请进入故事编辑继续修改。" : "";
  byTestId<HTMLButtonElement>("story-undo").disabled = !editor.canUndo;
  byTestId<HTMLButtonElement>("story-redo").disabled = !editor.canRedo;
  commitButton.disabled = !editor.editable || editor.needsReload;
  byTestId<HTMLButtonElement>("editor-tag-add").disabled = !editor.editable;
  showValue(editorTitle, meta.title); editorDate.value = meta.eventDate; editorTime.value = meta.eventTime ?? "";
  showValue(byTestId<HTMLInputElement>("editor-location"), meta.location);
  byTestId<HTMLSelectElement>("editor-mood").value = meta.mood ?? "";
  byId("quick-content").hidden = storyView;
  byId("story-blocks").hidden = !storyView;
  if (storyView) {
    if (photoKey !== null) { photoKey = null; photoGrid.replaceChildren(); }
    blocksUi.render(editor, { photo: index => {
      const block = editor.story.blocks[index];
      if (block.kind !== "photo") throw new Error("照片位置无效");
      return editorPhotoCell(block.photoUse);
    }, pick: pickPhotos, remove: index => { void confirmRemove(index); }, focusBlock });
  } else {
    if (byId("story-blocks").children.length) blocksUi.reset();
    showValue(editorBody, plainText(editor.story)); renderPhotos(photos);
  }
  const area = storyView ? byId("story-blocks") : photoGrid;
  const byKey = new Map(photos.map(photo => [editor.photoKey(photo.photoUseId), photo]));
  for (const cell of area.querySelectorAll<HTMLElement>(".photo-cell")) {
    const photo = byKey.get(cell.dataset.photoKey!);
    if (!photo) continue;
    const caption = cell.querySelector("textarea"), cover = cell.querySelector('[data-testid="photo-cover"]');
    if (caption) showValue(caption, photo.caption);
    const on = editor.story.coverPhotoUseId === photo.photoUseId;
    if (cover && cover.getAttribute("aria-pressed") !== String(on)) {
      cover.setAttribute("aria-pressed", String(on)); cover.textContent = on ? "封面 ✓" : "设为封面";
    }
    const img = cell.querySelector("img");
    if (img) {
      img.alt = photo.caption || "时光照片";
      if (cell.dataset.photoId !== photo.photoUseId) void loadPhoto(img, photo.assetId, cell);
    }
    cell.dataset.photoId = photo.photoUseId;
  }
  const status = editor.pending && ["idle", "saved", "savedUncertain"].includes(state.status)
    ? { ...state, status: "dirty" as const } : state;
  renderStatus(status);
  if (currentView === "editor" && state.recordId && (state.status === "saved" || state.status === "savedUncertain") && !editor.publishing) {
    uiPreferences.setItem(LAST_DRAFT_KEY, state.recordId);
  }
  editorBadge.hidden = !(originHasFormal && (editor.pending || state.status !== "idle"));
}

function openInEditor(row: RecordRow | null, date = calendarToday(), retained?: StoryEditor) {
  unsubscribeEditor?.();
  for (const url of pendingUrls.values()) URL.revokeObjectURL(url);
  pendingUrls.clear(); byTestId("draft-preview-content").replaceChildren();
  editor = retained ?? makeEditor(row, date);
  parked.delete(editor);
  editor.resume();
  originHasFormal = !!row?.formal;
  lastEditorFocus = null;
  blocksUi.reset(); photoKey = null;
  renderEditor();
  unsubscribeEditor = editor.subscribe(renderEditor);
  void refreshEditorTags();
}

async function refreshEditorTags(): Promise<void> {
  const rowElement = byTestId<HTMLDivElement>("editor-tag-chips");
  const id = editor.recordId;
  rowElement.replaceChildren();
  if (!id || blockedDescription !== null) return;
  try {
    const [row, tags] = await Promise.all([api.getRecord(id), api.listTags()]);
    if (editor.recordId !== id) return;
    rowElement.replaceChildren(...row.tagIds.map((tagId) => {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.dataset.testid = "editor-tag-chip";
      chip.textContent = tags.find((t) => t.tagId === tagId)?.name ?? "标签";
      return chip;
    }));
  } catch (error) { showError(error); }
}

byTestId<HTMLButtonElement>("editor-tag-add").addEventListener("click", () => {
  void (async () => {
    if (!ensureWritable() || !canChangeEditor()) return;
    const owner = editor, id = editor.recordId;
    const row = id ? await api.getRecord(id) : null;
    if (editor === owner && canChangeEditor()) await openTagPicker(row, owner);
  })().catch(showError);
});

async function flushBeforeLeave(): Promise<boolean> {
  try {
    if (editor.publishing) return false;
    await editor.settle();
    if (editor.needsReload) parked.add(editor);
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
}

async function openDraft(row: RecordRow): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  if (!ensureWritable()) return;
  try {
    const fresh = await api.getRecord(row.recordId);
    if (!fresh.draft || fresh.status !== "active" || byId("app-shell").inert) return;
    readingId = null;
    openInEditor(fresh, calendarToday(), [...parked].find(item => item.recordId === row.recordId));
    clearAppNotice();
    clearErrorBox();
    setView("editor");
  } catch (error) {
    showError(error);
  }
}

async function startNewDraft(): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  if (!ensureWritable()) return;
  try {
    readingId = null;
    openInEditor(null);
    uiPreferences.removeItem(LAST_DRAFT_KEY);
    clearAppNotice();
    clearErrorBox();
    setView("editor");
    editorTitle.focus();
  } catch (error) {
    showError(error);
  }
}

type DraftChoice = "continue" | "restart" | "cancel";
let settleDraftChoice: ((choice: DraftChoice) => void) | undefined;
function chooseExistingDraft(): Promise<DraftChoice> {
  return new Promise(resolve => {
    settleDraftChoice?.("cancel"); settleDraftChoice = resolve; chooseDraft.showModal(); syncBack();
  });
}
for (const choice of ["continue", "restart", "cancel"] as const) {
  byTestId("choose-" + choice).addEventListener("click", () => {
    settleDraftChoice?.(choice); settleDraftChoice = undefined; chooseDraft.close();
  });
}
chooseDraft.addEventListener("close", () => { settleDraftChoice?.("cancel"); settleDraftChoice = undefined; });
async function openModification(recordId: string): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  if (!ensureWritable()) return;
  try {
    const origin = currentView;
    let row = await api.getRecord(recordId);
    let retained = [...parked].find(item => item.recordId === recordId);
    const active = () => currentView === origin && readingId === recordId && !byId("app-shell").inert;
    if (!active()) return;
    if (row.draft || retained) {
      const choice = await chooseExistingDraft();
      if (!active() || choice === "cancel") return;
      if (choice === "restart") {
        if (!await askConfirm("从正式版重新编辑？", "放弃这份修改草稿和本次会话的排版，重新打开正式版。", "放弃草稿并重编") || !active()) return;
        if (row.draft) await api.discardDraft(recordId);
        if (retained) parked.delete(retained);
        retained = undefined;
        row = await api.getRecord(recordId);
      }
    }
    if (!active()) return;
    openInEditor(row, calendarToday(), retained);
    clearAppNotice();
    clearErrorBox();
    setView("editor");
  } catch (error) {
    showError(error);
  }
}

async function refreshDrafts(): Promise<void> {
  if (blockedDescription !== null) {
    draftList.replaceChildren(blockedCard());
    return;
  }
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
  const inMemory = [...parked].filter(item => item.needsReload);
  for (const item of inMemory) {
    const card = document.createElement("button"); card.type = "button"; card.className = "draft-card";
    card.dataset.testid = "session-draft"; card.textContent = (item.meta.title || "未命名故事") + " · 待核对";
    card.addEventListener("click", () => { void (async () => {
      if (!ensureWritable() || !await flushBeforeLeave()) return;
      const row = item.recordId ? await api.getRecord(item.recordId) : null;
      if (row && row.status !== "active") return;
      readingId = null; openInEditor(row, calendarToday(), item); setView("editor");
    })().catch(showError); });
    nodes.push(card);
  }
  rows = rows.filter(row => !inMemory.some(item => item.recordId === row.recordId));
  if (nodes.length === 0 && rows.length === 0) {
    nodes.push(emptyCard({
      title: "还没有草稿",
      message: "没写完的小事可以先放在这里，之后再慢慢补。",
      actionLabel: "写一篇",
      actionTestId: "empty-new-draft",
      onAction: () => { void startNewDraft(); },
      testId: "drafts-empty",
    }));
  } else {
    nodes.push(...rows.map(draftCard));
  }
  if (copies.length > 0) nodes.push(conflictCopySection(copies));
  draftList.replaceChildren(...nodes);
}

// ---- Unit-0.7 时光轴：分页、年月日分组、珍藏与标签 ----
const TIMELINE_PAGE_SIZE = 50;
let timelineItems: TimelineItem[] = [];
let timelineCursor: string | null = null;
let timelineTotal = 0;
let timelineFormalCount = 0;
let timelineLoading = false;
let timelineLoaded = false;
let timelineGeneration = 0;
let timelineOrder: "desc" | "asc" = "desc";
let timelineTo: string | null = null;
let timelineTags: TagInfo[] = [];
const selectedTagIds = new Set<string>();

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? String((error as { code: string }).code) : "";
}

function tagName(tagId: string): string {
  return timelineTags.find((tag) => tag.tagId === tagId)?.name ?? tagId;
}

function currentTimelineFilter(): TimelineFilter {
  return {
    to: timelineTo,
    favoriteOnly: favoriteFilter.checked,
    tagIds: [...selectedTagIds],
    order: timelineOrder,
  };
}

function monthListFilter(): TimelineFilter {
  const filter = currentTimelineFilter();
  return { ...filter, to: null };
}

function hasTimelineFilter(): boolean {
  return timelineTo !== null || favoriteFilter.checked || selectedTagIds.size > 0;
}

function timelineEmpty(message: string): HTMLParagraphElement {
  const empty = document.createElement("p");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

function formatDayHeading(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${month}月${day}日 ${weekday}`;
}

function formatMonth(date: string): string {
  return `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月`;
}

function lastDayOfMonth(year: number, month: number): string {
  const mm = String(month).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${mm}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
}

function syncTimelineTags(tags: TagInfo[]): void {
  timelineTags = tags;
  const available = new Set(timelineTags.map((tag) => tag.tagId));
  for (const id of [...selectedTagIds]) if (!available.has(id)) selectedTagIds.delete(id);
  renderTagFilterChips();
}

function renderActiveConditions(): void {
  const chips: HTMLButtonElement[] = [];
  const add = (key: string, label: string, remove: () => void) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "condition-chip";
    button.dataset.condition = key;
    button.textContent = `${label} ×`;
    button.setAttribute("aria-label", `移除条件，${label}`);
    button.addEventListener("click", () => {
      remove();
      void reloadTimeline();
    });
    chips.push(button);
  };
  if (timelineTo) add("month", `截至 ${formatMonth(timelineTo)}`, () => { timelineTo = null; });
  if (timelineOrder === "asc") add("order", "由远到近", () => { timelineOrder = "desc"; paintOrderToggle(); });
  if (favoriteFilter.checked) add("favorite", "只看珍藏", () => { favoriteFilter.checked = false; });
  for (const id of selectedTagIds) add(`tag:${id}`, tagName(id), () => { selectedTagIds.delete(id); });

  const focused = document.activeElement as HTMLElement | null;
  const oldIndex = Array.from(activeConditions.children).findIndex(button => button === focused);
  activeConditions.replaceChildren(...chips);
  activeConditions.hidden = chips.length === 0;
  if (oldIndex >= 0) {
    const next = chips.find(button => button.dataset.condition === focused?.dataset.condition)
      ?? chips[Math.min(oldIndex, chips.length - 1)] ?? filterEntry;
    next.focus({ preventScroll: true });
  }
}

function renderTagFilterChips(): void {
  tagFilterBar.hidden = timelineTags.length === 0;
  const chips = timelineTags.map((tag) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-chip";
    chip.dataset.testid = "tag-filter-chip";
    chip.dataset.tagId = tag.tagId;
    chip.setAttribute("aria-pressed", String(selectedTagIds.has(tag.tagId)));
    chip.classList.toggle("is-active", selectedTagIds.has(tag.tagId));
    chip.textContent = tag.name;
    chip.title = `${tag.activeCount} 条记录`;
    chip.addEventListener("click", () => {
      if (selectedTagIds.has(tag.tagId)) selectedTagIds.delete(tag.tagId);
      else selectedTagIds.add(tag.tagId);
      void reloadTimeline();
    });
    return chip;
  });
  const focused = document.activeElement as HTMLElement | null;
  const tagId = focused?.dataset.testid === "tag-filter-chip" ? focused.dataset.tagId : null;
  tagFilterChips.replaceChildren(...chips);
  if (tagId) (chips.find(button => button.dataset.tagId === tagId) ?? manageTagsButton).focus({ preventScroll: true });
  renderActiveConditions();
}

async function refreshMonthOptions(generation: number): Promise<void> {
  const months = await api.timelineMonths(monthListFilter());
  if (generation !== timelineGeneration) return;
  const options: HTMLOptionElement[] = [];
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "选择年月";
  options.push(placeholder);
  for (const m of months) {
    const option = document.createElement("option");
    option.value = `${String(m.year).padStart(4, "0")}-${String(m.month).padStart(2, "0")}`;
    option.textContent = `${m.year}年${m.month}月（${m.count}）`;
    options.push(option);
  }
  const selected = timelineTo?.slice(0, 7) ?? "";
  if (selected && !options.some(option => option.value === selected)) {
    const option = document.createElement("option");
    option.value = selected;
    option.textContent = `${formatMonth(selected)}（0）`;
    options.push(option);
  }
  jumpMonth.replaceChildren(...options);
  jumpMonth.value = selected;
}

async function reloadTimeline(keepDepth = false): Promise<void> {
  if (blockedDescription !== null) {
    timelineList.replaceChildren(blockedCard());
    timelineSummary.textContent = "";
    return;
  }
  const generation = ++timelineGeneration;
  const wanted = keepDepth ? timelineItems.length : 0;
  timelineCursor = null;
  timelineLoading = false;
  timelineLoaded = false;
  renderActiveConditions();
  filterResult.textContent = "正在查找…";
  if (!keepDepth || !timelineItems.length) {
    if (coverObserver) for (const img of timelineList.querySelectorAll("img")) coverObserver.unobserve(img);
    timelineItems = [];
    timelineList.replaceChildren(timelineEmpty("正在加载时光…"));
    timelineSummary.textContent = "";
    timelineSentinel.hidden = true;
  }
  try {
    const tags = await api.listTags();
    if (generation !== timelineGeneration) return;
    syncTimelineTags(tags);
    const filter = currentTimelineFilter();
    let page = await api.timelinePage(filter, null, TIMELINE_PAGE_SIZE);
    if (generation !== timelineGeneration) return;
    const items = [...page.items];
    while (page.nextCursor && items.length < wanted) {
      page = await api.timelinePage(filter, page.nextCursor, TIMELINE_PAGE_SIZE);
      if (generation !== timelineGeneration) return;
      items.push(...page.items);
    }
    const formalCount = hasTimelineFilter() && !page.total
      ? (await api.timelinePage({ order: timelineOrder }, null, 1)).total : page.total;
    if (generation !== timelineGeneration) return;
    timelineItems = items;
    timelineCursor = page.nextCursor;
    timelineTotal = page.total;
    timelineFormalCount = formalCount;
    timelineLoaded = true;
    renderTimelineLoaded();
    await refreshMonthOptions(generation);
  } catch (error) {
    if (generation !== timelineGeneration) return;
    const description = describeError(error);
    showErrorDescription(description);
    filterResult.textContent = description.title;
    if (!timelineLoaded) timelineList.replaceChildren(emptyCard({
      title: description.title, message: description.detail,
      actionLabel: "重试", onAction: () => { void reloadTimeline(keepDepth); },
    }));
  }
}

async function loadMoreTimeline(): Promise<void> {
  if (!timelineLoaded || timelineLoading || timelineCursor === null) return;
  timelineLoading = true;
  const generation = timelineGeneration;
  try {
    const page = await api.timelinePage(currentTimelineFilter(), timelineCursor, TIMELINE_PAGE_SIZE);
    if (generation !== timelineGeneration) return;
    const previousDate = timelineItems.at(-1)?.eventDate;
    timelineItems.push(...page.items);
    timelineCursor = page.nextCursor;
    timelineTotal = page.total;
    timelineList.append(...journalPage(page.items, previousDate));
    paintTimelineCount();
  } catch (error) {
    if (generation === timelineGeneration) showError(error);
  } finally {
    if (generation === timelineGeneration) timelineLoading = false;
  }
}

function clearTimelineFilters(): void {
  timelineOrder = "desc";
  paintOrderToggle();
  filterEntry.focus();
  timelineTo = null;
  favoriteFilter.checked = false;
  selectedTagIds.clear();
  void reloadTimeline();
}

function paintTimelineCount(): void {
  filterResult.textContent = `共 ${timelineTotal} 条时光`;
  timelineSummary.hidden = !timelineItems.length;
  timelineSummary.textContent = `已显示 ${timelineItems.length} / 共 ${timelineTotal} 条`;
  timelineSentinel.hidden = timelineCursor === null;
}
function renderTimelineLoaded(): void {
  paintTimelineCount();
  if (coverObserver) for (const img of timelineList.querySelectorAll("img")) coverObserver.unobserve(img);
  if (timelineItems.length === 0) {
    const kind = timelineEmptyKind(timelineTotal, timelineFormalCount);
    if (kind === "no-entries") {
      timelineList.replaceChildren(emptyCard({
        title: "这里还没有时光",
        message: "写下第一段小事，它会按日子排进时光轴。",
        actionLabel: "写下第一段时光",
        actionTestId: "write-first",
        onAction: () => { void startNewDraft(); },
        testId: "timeline-empty",
      }));
      return;
    }
    if (kind === "filtered-empty") {
      timelineList.replaceChildren(emptyCard({
        title: "没有符合筛选的时光",
        message: "换个标签，或者回到全部时光看看。",
        actionLabel: "清除筛选",
        actionTestId: "clear-filters",
        onAction: clearTimelineFilters,
        testId: "timeline-empty",
      }));
      return;
    }
    timelineList.replaceChildren();
    return;
  }
  timelineList.replaceChildren(...journalPage(timelineItems));
}

function journalPage(items: TimelineItem[], previousDate?: string): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  let previousMonth = previousDate?.slice(0, 7);
  for (const item of items) {
    const month = item.eventDate.slice(0, 7);
    if (month !== previousMonth) {
      const heading = document.createElement("h2");
      heading.className = "timeline-month";
      heading.textContent = formatMonth(month);
      nodes.push(heading);
      previousMonth = month;
    }
    nodes.push(timelineCard(item));
  }
  return nodes;
}

let coverObserver: IntersectionObserver | null = null;

function observeCover(img: HTMLImageElement, assetId: string): void {
  if (coverObserver === null) {
    coverObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target as HTMLImageElement;
        coverObserver?.unobserve(target);
        const id = target.dataset.assetId;
        if (id) void loadCoverImage(target, id);
      }
    }, { rootMargin: "240px" });
  }
  img.dataset.assetId = assetId;
  coverObserver.observe(img);
}

async function loadCoverImage(img: HTMLImageElement, assetId: string): Promise<void> {
  try {
    img.src = await api.photoThumbUrl(assetId);
  } catch (error) {
    if (!img.isConnected) return;
    const fallback = document.createElement("span");
    fallback.className = "cover-fallback";
    const code = errorCode(error);
    fallback.dataset.testid = code === "ASSET_MISSING" ? "photo-missing" : code === "ASSET_HASH_MISMATCH" ? "photo-corrupt" : "cover-fallback";
    fallback.textContent = code === "HEIC_UNSUPPORTED" ? "无法预览 HEIC 图片" : code === "ASSET_MISSING" ? "原图缺失" : code === "ASSET_HASH_MISMATCH" ? "原图校验失败" : "图片暂时无法显示";
    img.replaceWith(fallback);
  }
}

function timelineCover(item: TimelineItem): HTMLElement | null {
  const cover = item.cover;
  if (cover === null) return null;
  const holder = document.createElement("span");
  holder.className = "timeline-cover";
  const img = document.createElement("img");
  img.alt = cover.caption.trim() || "时光封面";
  img.loading = "lazy"; img.decoding = "async";
  img.dataset.testid = "timeline-cover";
  holder.append(img);
  observeCover(img, cover.assetId);
  return holder;
}

function itemHeadline(item: TimelineItem): string {
  if (item.title.length > 0) return item.title;
  if (item.excerpt.length > 0) return item.excerpt;
  return "这段时光";
}

function paintFavorite(button: HTMLButtonElement, item: TimelineItem): void {
  button.textContent = item.favorite ? "★" : "☆";
  button.classList.toggle("is-on", item.favorite);
  button.setAttribute("aria-pressed", String(item.favorite));
  button.setAttribute("aria-label", item.favorite ? "取消珍藏" : "珍藏这段时光");
  button.title = item.favorite ? "取消珍藏" : "珍藏";
}

async function toggleFavorite(item: TimelineItem, button: HTMLButtonElement): Promise<void> {
  if (!ensureWritable()) return;
  clearErrorBox();
  button.disabled = true;
  try {
    const result = await api.setFavorite(item.recordId, !item.favorite, item.favoriteRevision);
    item.favorite = result.favorite;
    item.favoriteRevision = result.favoriteRevision;
    item.tagIds = [...result.tagIds];
    item.tagRevision = result.tagRevision;
    paintFavorite(button, item);
    showAppNotice(result.favorite ? "已珍藏这段时光" : "已取消珍藏", "ok");
    if (favoriteFilter.checked && !result.favorite) await reloadTimeline();
    if (currentView === "calendar") await refreshCalendar();
  } catch (error) {
    if (errorCode(error) === "META_REVISION_CONFLICT") {
      showAppNotice("珍藏状态已在别处改变，已刷新列表，请再试一次", "warn");
      await reloadTimeline();
      if (currentView === "calendar") await refreshCalendar();
    } else {
      showError(error);
    }
  } finally {
    button.disabled = false;
  }
}

function timelineCard(item: TimelineItem, readOnly = false): HTMLElement {
  const article = document.createElement("article");
  article.className = "journal-entry";
  article.dataset.testid = "timeline-item";
  article.dataset.recordId = item.recordId;

  const read = document.createElement("button");
  read.type = "button";
  read.className = "entry-read";
  read.dataset.testid = "edit-button";
  read.setAttribute("aria-label", `阅读，${formatEventWhen(item)}，${itemHeadline(item)}`);
  read.addEventListener("click", () => { void openReading(item.recordId, false, read).catch(showError); });
  const cover = timelineCover(item);
  if (cover) read.append(cover);

  const dateLine = document.createElement("span");
  dateLine.className = "entry-dateline";
  const date = document.createElement("time");
  date.dateTime = item.eventDate;
  const [day, weekday] = formatDayHeading(item.eventDate).split(" ");
  date.textContent = day;
  const detail = document.createElement("span");
  detail.textContent = [weekday, item.eventTime?.slice(0, 5), item.isFuture ? "未来时光" : ""].filter(Boolean).join(" · ");
  dateLine.append(date, detail, icon("next"));
  read.append(dateLine);
  for (const [className, text] of [["entry-title", item.title], ["entry-excerpt", item.excerpt]]) {
    if (!text) continue;
    const line = document.createElement("span");
    line.className = className;
    line.textContent = text;
    read.append(line);
  }
  article.append(read);

  const footer = document.createElement("footer");
  footer.className = "entry-footer";
  const meta = document.createElement("div");
  meta.className = "entry-meta";
  for (const id of item.tagIds) {
    const tag = document.createElement("span");
    tag.className = "entry-tag";
    tag.textContent = tagName(id);
    meta.append(tag);
  }
  const context = [item.mood, item.location, item.photoCount ? `${item.photoCount} 张照片` : ""].filter(Boolean).join(" · ");
  if (context) {
    const note = document.createElement("span");
    note.textContent = context;
    meta.append(note);
  }
  footer.append(meta);
  if (readOnly) {
    if (item.favorite) meta.append(document.createTextNode("已珍藏"));
  } else {
    const star = document.createElement("button");
    star.type = "button";
    star.className = "entry-favorite";
    star.dataset.testid = "favorite-toggle";
    paintFavorite(star, item);
    star.addEventListener("click", () => { void toggleFavorite(item, star); });
    const more = document.createElement("details");
    more.className = "entry-more";
    const summary = document.createElement("summary");
    summary.setAttribute("aria-label", `更多操作，${itemHeadline(item)}`);
    summary.append(icon("more"));
    const actions = document.createElement("div");
    actions.className = "entry-actions";
    const tags = tagActionButton("标签", "edit-tags", () => { void openTagPicker(item); });
    const trash = tagActionButton("移到回收站", "trash-button", () => { void trashTimelineItem(item.recordId, itemHeadline(item)); });
    trash.classList.add("danger");
    actions.append(tags, trash);
    more.append(summary, actions);
    footer.append(star, more);
  }
  article.append(footer);
  return article;
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
    await reloadTimeline();
    if (currentView === "calendar") await refreshCalendar();
  } catch (error) {
    showError(error);
  }
}

// ---- Unit-0.7 日历 / 当天 / 那年今日 ----
const calendarToday = visualPreview?.adapter.today ?? localToday;
const initialToday = calendarToday();
let calYear = Number(initialToday.slice(0, 4));
let calMonth = Number(initialToday.slice(5, 7));
let calSelectedDate: string | null = null;
let calDays = new Map<string, CalendarDay>();
let calendarGeneration = 0;
let dayPanelGeneration = 0;
let onThisDayGeneration = 0;

function setDialogStatus(node: HTMLElement, message: string, tone: "calm" | "ok" | "warn" | "error"): void {
  node.hidden = message.length === 0;
  node.className = `dialog-status${message.length > 0 ? ` is-${tone}` : ""}`;
  node.textContent = message;
}

async function showCalendar(): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  setView("calendar");
  await refreshCalendar();
}

async function refreshCalendar(): Promise<void> {
  if (blockedDescription !== null) {
    renderBlockedState();
    return;
  }
  const generation = ++calendarGeneration;
  try {
    const days = await api.calendarMonth(calYear, calMonth);
    if (generation !== calendarGeneration) return;
    calDays = new Map(days.map((day) => [day.date, day] as const));
    const prefix = `${String(calYear).padStart(4, "0")}-${String(calMonth).padStart(2, "0")}-`;
    if (calSelectedDate !== null && !calSelectedDate.startsWith(prefix)) calSelectedDate = null;
    renderCalendar();
    const selected = calSelectedDate;
    if (selected !== null) await loadDayPanel(selected);
    else renderDayPanelPlaceholder();
    await refreshOnThisDay();
  } catch (error) {
    if (generation === calendarGeneration) showError(error);
  }
}

function renderCalendar(): void {
  calTitle.textContent = `${calYear}年${calMonth}月`;
  calMonthInput.value = `${String(calYear).padStart(4, "0")}-${String(calMonth).padStart(2, "0")}`;
  const today = calendarToday();
  const cells = calendarGrid(calYear, calMonth).map((date) => {
    if (date === null) {
      const empty = document.createElement("span");
      empty.className = "cal-day is-empty";
      return empty;
    }
    const info = calDays.get(date);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cal-day";
    button.dataset.testid = "cal-day";
    button.dataset.date = date;
    button.setAttribute("aria-pressed", String(date === calSelectedDate));
    button.setAttribute("aria-controls", "day-panel");
    button.setAttribute("aria-label", `${date.slice(0, 4)}年${formatDayHeading(date)}${date === today ? "，今天" : ""}，${info?.count ?? 0} 条时光${info?.hasFavorite ? "，有珍藏" : ""}`);
    if (info) {
      button.classList.add("has-record");
      button.dataset.count = String(info.count);
    }
    if (date === today) button.classList.add("is-today");
    if (date === calSelectedDate) button.classList.add("is-selected");
    const number = document.createElement("span");
    number.className = "cal-num";
    number.textContent = String(Number(date.slice(8, 10)));
    button.append(number);
    if (info) {
      const mark = document.createElement("span");
      mark.className = "cal-mark";
      const dot = document.createElement("span");
      dot.className = "cal-dot";
      mark.append(dot);
      const count = document.createElement("span");
      count.textContent = countLabel(info.count);
      mark.append(count);
      if (info.hasFavorite) {
        const star = document.createElement("span");
        star.className = "cal-star";
        star.textContent = "★";
        star.title = "有珍藏";
        mark.append(star);
      }
      button.append(mark);
    }
    button.addEventListener("click", () => { void selectCalendarDate(date); });
    return button;
  });
  calGrid.replaceChildren(...cells);
  calEmpty.hidden = calDays.size > 0;
}

async function selectCalendarDate(date: string): Promise<void> {
  calSelectedDate = date;
  renderCalendar();
  calGrid.querySelector<HTMLButtonElement>(`[data-date="${date}"]`)?.focus({preventScroll: true});
  await loadDayPanel(date);
  await refreshOnThisDay();
}

function dayEmpty(message: string, date: string | null): HTMLDivElement {
  const box = document.createElement("div");
  box.className = "empty-state";
  box.append(document.createTextNode(message));
  if (date !== null) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button ghost";
    button.dataset.testid = "record-this-day";
    button.textContent = "记录这一天";
    button.addEventListener("click", () => { void startNewDraftAt(date); });
    box.append(document.createElement("br"), button);
  }
  return box;
}

function renderDayPanelPlaceholder(): void {
  dayPanelGeneration += 1;
  dayPanelTitle.textContent = "当天时光";
  dayPanelDate.textContent = "点一天，看看那天留下的时光";
  delete dayPanelList.dataset.date;
  dayPanelList.replaceChildren(dayEmpty("还没有选择日期", null));
}

async function loadDayPanel(date: string): Promise<void> {
  const generation = ++dayPanelGeneration;
  dayPanelTitle.textContent = "当天时光";
  dayPanelDate.textContent = formatDayHeading(date);
  if (dayPanelList.dataset.date !== date) dayPanelList.replaceChildren(timelineEmpty("正在翻找这一天…"));
  dayPanelList.dataset.date = date;
  try {
    const items = await api.dayEntries(date);
    if (generation !== dayPanelGeneration) return;
    if (items.length === 0) {
      dayPanelList.replaceChildren(dayEmpty("这一天还没有留下时光", date));
      return;
    }
    dayPanelList.replaceChildren(...items.map((item) => timelineCard(item)));
  } catch (error) {
    if (generation === dayPanelGeneration) showError(error);
  }
}

async function refreshOnThisDay(): Promise<void> {
  const generation = ++onThisDayGeneration;
  const base = calSelectedDate ?? calendarToday();
  const month = Number(base.slice(5, 7));
  const day = Number(base.slice(8, 10));
  onThisDayTitle.textContent = "那年今日";
  onThisDaySub.textContent = calSelectedDate === null ? `${month}月${day}日` : `${month}月${day}日 · 往年同月同日`;
  try {
    const groups = await api.onThisDay(month, day, calendarToday());
    if (generation !== onThisDayGeneration) return;
    if (groups.length === 0) {
      onThisDayList.replaceChildren(timelineEmpty("往年的今天还没有记录"));
      return;
    }
    const nodes: HTMLElement[] = [];
    for (const group of groups) {
      const section = document.createElement("section");
      section.className = "on-this-day-group";
      const heading = document.createElement("h3");
      heading.className = "on-this-day-year";
      heading.textContent = `${group.year}年 · ${group.items.length} 条`;
      section.append(heading);
      for (const item of group.items) section.append(timelineCard(item, true));
      nodes.push(section);
    }
    onThisDayList.replaceChildren(...nodes);
  } catch (error) {
    if (generation === onThisDayGeneration) showError(error);
  }
}

async function startNewDraftAt(date: string): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  if (!ensureWritable()) return;
  try {
    readingId = null;
    openInEditor(null, date);
    uiPreferences.removeItem(LAST_DRAFT_KEY);
    clearAppNotice();
    clearErrorBox();
    setView("editor");
    editorBody.focus();
  } catch (error) {
    showError(error);
  }
}

// ---- Unit-0.7 标签管理 / 标签选择 ----
function conflictTag(error: unknown): TagInfo | null {
  const value: Record<string, unknown> = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const tagId = value.tagId;
  if (typeof tagId === "string") {
    const found = timelineTags.find((tag) => tag.tagId === tagId);
    if (found) return found;
  }
  const message = typeof value.message === "string" ? value.message : "";
  const match = /「(.+?)」/.exec(message);
  if (match) return timelineTags.find((tag) => tag.name === match[1]) ?? null;
  return null;
}

function impactMessage(impact: { active: number; trashed: number }): string {
  return `将影响 ${impact.active + impact.trashed} 条记录（其中回收站 ${impact.trashed} 条）。删除标签只会解除关联，不会删除任何记录或照片。`;
}

async function refreshTagManager(): Promise<void> {
  const tags = await api.listTags();
  syncTimelineTags(tags);
  renderTagManagerRows(tags);
}

function tagActionButton(label: string, testId: string, handler: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button ghost";
  button.dataset.testid = testId;
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function renderTagManagerRows(tags: readonly TagInfo[]): void {
  if (tags.length === 0) {
    tagManageList.replaceChildren(timelineEmpty("还没有标签，先在上方新建一个吧"));
    return;
  }
  tagManageList.replaceChildren(...tags.map((tag) => {
    const row = document.createElement("div");
    row.className = "tag-row";
    row.dataset.testid = "tag-row";
    row.dataset.tagId = tag.tagId;
    const name = document.createElement("span");
    name.className = "tag-row-name";
    name.textContent = tag.name;
    const count = document.createElement("span");
    count.className = "tag-row-count";
    count.textContent = `${tag.activeCount} 条`;
    row.append(
      name,
      count,
      tagActionButton("改名", "tag-rename", () => { beginTagRename(row, tag); }),
      tagActionButton("合并到…", "tag-merge", () => { beginTagMerge(row, tag); }),
      tagActionButton("删除", "tag-delete", () => { void deleteTagFlow(tag); }),
    );
    return row;
  }));
}

function beginTagRename(row: HTMLDivElement, tag: TagInfo): void {
  const input = document.createElement("input");
  input.type = "text";
  input.value = tag.name;
  input.maxLength = 40;
  input.dataset.testid = "tag-rename-input";
  input.setAttribute("aria-label", `重命名标签：${tag.name}`);
  const save = tagActionButton("保存", "tag-rename-confirm", () => { void commitTagRename(tag, input.value); });
  const cancel = tagActionButton("取消", "tag-rename-cancel", () => {
    void refreshTagManager().catch((error: unknown) => { showError(error); });
  });
  row.replaceChildren(input, save, cancel);
  input.focus();
  input.select();
}

async function commitTagRename(tag: TagInfo, name: string): Promise<void> {
  try {
    const updated = await api.renameTag(tag.tagId, name);
    setDialogStatus(tagDialogStatus, `已改名为「${updated.name}」`, "ok");
    await refreshTagManager();
    await afterTagMetaChange();
  } catch (error) {
    if (errorCode(error) === "TAG_NAME_CONFLICT") {
      const target = conflictTag(error);
      await refreshTagManager();
      if (target === null) {
        setDialogStatus(tagDialogStatus, "已有同名标签，请换一个名字", "warn");
        return;
      }
      const confirmed = await askConfirm(
        "标签重名",
        `已有同名标签「${target.name}」。要把这个标签合并到「${target.name}」吗？`,
        "合并",
      );
      if (!confirmed) {
        setDialogStatus(tagDialogStatus, "已取消，没有改动", "calm");
        return;
      }
      try {
        const result = await api.mergeTags(tag.tagId, target.tagId);
        setDialogStatus(tagDialogStatus, `已合并，影响 ${result.affectedRecords} 条`, "ok");
        await refreshTagManager();
        await afterTagMetaChange();
      } catch (mergeError) {
        setDialogStatus(tagDialogStatus, describeError(mergeError).title, "error");
        showError(mergeError);
      }
      return;
    }
    setDialogStatus(tagDialogStatus, describeError(error).title, "error");
    showError(error);
  }
}

function beginTagMerge(row: HTMLDivElement, tag: TagInfo): void {
  const others = timelineTags.filter((item) => item.tagId !== tag.tagId);
  if (others.length === 0) {
    setDialogStatus(tagDialogStatus, "没有其他标签可以合并", "warn");
    return;
  }
  const select = document.createElement("select");
  select.dataset.testid = "tag-merge-target";
  select.setAttribute("aria-label", `将标签「${tag.name}」合并到`);
  for (const other of others) {
    const option = document.createElement("option");
    option.value = other.tagId;
    option.textContent = other.name;
    select.append(option);
  }
  const confirm = tagActionButton("合并", "tag-merge-confirm", () => { void mergeTagFlow(tag, select.value); });
  const cancel = tagActionButton("取消", "tag-merge-cancel", () => {
    void refreshTagManager().catch((error: unknown) => { showError(error); });
  });
  row.replaceChildren(select, confirm, cancel);
}

async function mergeTagFlow(tag: TagInfo, intoTagId: string): Promise<void> {
  const target = timelineTags.find((item) => item.tagId === intoTagId);
  if (!target) return;
  try {
    const impact = await api.tagImpact(tag.tagId);
    const confirmed = await askConfirm(
      `合并标签「${tag.name}」到「${target.name}」？`,
      impactMessage(impact),
      "合并",
    );
    if (!confirmed) {
      setDialogStatus(tagDialogStatus, "已取消，没有改动", "calm");
      return;
    }
    const result = await api.mergeTags(tag.tagId, intoTagId);
    setDialogStatus(tagDialogStatus, `已合并，影响 ${result.affectedRecords} 条`, "ok");
    await refreshTagManager();
    await afterTagMetaChange();
  } catch (error) {
    setDialogStatus(tagDialogStatus, describeError(error).title, "error");
    showError(error);
  }
}

async function deleteTagFlow(tag: TagInfo): Promise<void> {
  try {
    const impact = await api.tagImpact(tag.tagId);
    const confirmed = await askConfirm(
      `删除标签「${tag.name}」？`,
      impactMessage(impact),
      "删除标签",
    );
    if (!confirmed) {
      setDialogStatus(tagDialogStatus, "已取消，没有改动", "calm");
      return;
    }
    const result = await api.deleteTag(tag.tagId);
    setDialogStatus(tagDialogStatus, `已删除标签，影响 ${result.affectedRecords} 条；记录和照片都还在`, "ok");
    await refreshTagManager();
    await afterTagMetaChange();
  } catch (error) {
    setDialogStatus(tagDialogStatus, describeError(error).title, "error");
    showError(error);
  }
}

async function afterTagMetaChange(): Promise<void> {
  await reloadTimeline();
  if (currentView === "calendar") await refreshCalendar();
  if (currentView === "collect") await refreshCollect();
}

async function openTagManager(): Promise<void> {
  if (!ensureWritable()) return;
  clearErrorBox();
  setDialogStatus(tagDialogStatus, "", "calm");
  tagNewInput.value = "";
  try {
    if (!tagDialog.open) { tagDialog.showModal(); syncBack(); }
    await refreshTagManager();
  } catch (error) {
    showError(error);
  }
}

interface PickerState { owner?: StoryEditor; item: Pick<RecordRow, "recordId" | "favorite" | "favoriteRevision" | "tagIds" | "tagRevision"> | null; revision: number; selected: Set<string> }
const picker: PickerState = { item: null, revision: 0, selected: new Set<string>() };

async function renderTagPickerOptions(): Promise<void> {
  const tags = await api.listTags();
  timelineTags = tags;
  const rows = tags.map((tag) => {
    const label = document.createElement("label");
    label.className = "tag-option-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = tag.tagId;
    checkbox.dataset.testid = "tag-option";
    checkbox.checked = picker.selected.has(tag.tagId);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) picker.selected.add(tag.tagId);
      else picker.selected.delete(tag.tagId);
    });
    const name = document.createElement("span");
    name.textContent = tag.name;
    const count = document.createElement("span");
    count.className = "tag-option-count";
    count.textContent = `${tag.activeCount} 条`;
    label.append(checkbox, name, count);
    return label;
  });
  if (rows.length === 0) {
    tagPickerList.replaceChildren(timelineEmpty("还没有标签，可以在下面新建"));
  } else {
    tagPickerList.replaceChildren(...rows);
  }
}

async function openTagPicker(item: PickerState["item"], owner?: StoryEditor): Promise<void> {
  if (!ensureWritable()) return;
  clearErrorBox();
  picker.owner = owner; picker.item = item;
  picker.revision = item?.tagRevision ?? 0;
  picker.selected = new Set(item?.tagIds);
  setDialogStatus(tagPickerStatus, "", "calm");
  tagPickerNew.value = "";
  try {
    if (!tagPickerDialog.open) { tagPickerDialog.showModal(); syncBack(); }
    await renderTagPickerOptions();
  } catch (error) {
    showError(error);
  }
}

async function createTagForPicker(): Promise<void> {
  if (currentView === "editor" && !canChangeEditor()) return;
  try {
    const tag = await api.createTag(tagPickerNew.value);
    picker.selected.add(tag.tagId);
    tagPickerNew.value = "";
    setDialogStatus(tagPickerStatus, `已新建标签「${tag.name}」`, "ok");
    await renderTagPickerOptions();
  } catch (error) {
    if (errorCode(error) === "TAG_NAME_CONFLICT") {
      const target = conflictTag(error);
      if (target) picker.selected.add(target.tagId);
      setDialogStatus(tagPickerStatus, "已有同名标签，可以直接使用", "warn");
      await renderTagPickerOptions();
      return;
    }
    setDialogStatus(tagPickerStatus, describeError(error).detail, "error");
  }
}

async function savePickerTags(): Promise<void> {
  if (picker.owner && (picker.owner !== editor || !canChangeEditor())) return;
  tagPickerSave.disabled = true;
  try {
    let item = picker.item;
    if (!item) {
      if (!picker.owner || !picker.selected.size) { tagPickerDialog.close(); return; }
      item = await api.getRecord(await picker.owner.ensureTagRecord());
      if (editor !== picker.owner || !canChangeEditor()) return;
      picker.item = item; picker.revision = item.tagRevision;
    }
    const result = await api.setRecordTags(item.recordId, [...picker.selected], picker.revision);
    item.favorite = result.favorite;
    item.favoriteRevision = result.favoriteRevision;
    item.tagIds = [...result.tagIds];
    item.tagRevision = result.tagRevision;
    for (const loaded of timelineItems) {
      if (loaded.recordId !== item.recordId) continue;
      loaded.favorite = result.favorite;
      loaded.favoriteRevision = result.favoriteRevision;
      loaded.tagIds = [...result.tagIds];
      loaded.tagRevision = result.tagRevision;
    }
    await refreshEditorTags();
    tagPickerDialog.close();
    showAppNotice("标签已保存；文字和草稿都没有改动", "ok");
    await reloadTimeline();
    if (currentView === "calendar") await refreshCalendar();
  } catch (error) {
    if (errorCode(error) === "META_REVISION_CONFLICT") {
      setDialogStatus(tagPickerStatus, "标签已在别处改变，已刷新列表，请重新打开", "warn");
      showAppNotice("标签已在别处改变，已刷新列表", "warn");
      tagPickerDialog.close();
      await refreshEditorTags();
      await reloadTimeline();
      if (currentView === "calendar") await refreshCalendar();
    } else {
      setDialogStatus(tagPickerStatus, describeError(error).detail, "error");
    }
  } finally {
    tagPickerSave.disabled = false;
  }
}

async function refreshTrash(): Promise<void> {
  if (blockedDescription !== null) {
    trashList.replaceChildren(blockedCard());
    return;
  }
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

async function showTimeline(fromStart = false): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  setView("timeline");
  if (fromStart) { tabPositions.delete("timeline"); restoreScroll(); }
  await reloadTimeline(!fromStart);
}

async function showTrash(): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  setView("trash");
  await refreshTrash();
}

// ---- Unit-0.8 标签·收藏 ----
let collectGeneration = 0;

function renderCollectFavorites(items: readonly TimelineItem[]): void {
  if (items.length === 0) {
    collectFavorites.replaceChildren(emptyCard({
      title: "还没有珍藏的时光",
      message: "在时光轴点一下星星，就能把那段时光收进这里。",
      actionLabel: "去时光轴看看",
      actionTestId: "collect-empty-favorites",
      onAction: () => { void showTimeline(); },
      testId: "collect-favorites-empty",
    }));
    return;
  }
  collectFavorites.replaceChildren(...items.map((item) => timelineCard(item, true)));
}

function filterTimelineByTag(tagId: string): void {
  selectedTagIds.clear();
  selectedTagIds.add(tagId);
  favoriteFilter.checked = false;
  timelineTo = null;
  void showTimeline(true);
}

function renderCollectTagList(tags: readonly TagInfo[]): void {
  if (tags.length === 0) {
    collectTags.replaceChildren(emptyCard({
      title: "还没有标签",
      message: "在时光轴给记录加上标签，这里就会按标签归好。",
      actionLabel: "去时光轴给记录加标签",
      actionTestId: "collect-empty-tags",
      onAction: () => { void showTimeline(); },
      testId: "collect-tags-empty",
    }));
    return;
  }
  collectTags.replaceChildren(...tags.map((tag) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "collect-tag";
    button.dataset.testid = "collect-tag-item";
    button.dataset.tagId = tag.tagId;
    const name = document.createElement("span");
    name.textContent = tag.name;
    const count = document.createElement("span");
    count.className = "collect-tag-count";
    count.textContent = `${tag.activeCount} 条`;
    button.append(name, count);
    button.addEventListener("click", () => { filterTimelineByTag(tag.tagId); });
    return button;
  }));
}

async function refreshCollect(): Promise<void> {
  if (blockedDescription !== null) {
    renderBlockedState();
    return;
  }
  const generation = ++collectGeneration;
  try {
    const tags = await api.listTags();
    if (generation !== collectGeneration) return;
    timelineTags = tags;
    renderCollectTagList(tags);
    const page = await api.timelinePage({ favoriteOnly: true }, null, TIMELINE_PAGE_SIZE);
    if (generation !== collectGeneration) return;
    renderCollectFavorites(page.items);
  } catch (error) {
    if (generation === collectGeneration) showError(error);
  }
}

async function showCollect(): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  setView("collect");
  await refreshCollect();
}

/** 一级页签入口：所有路径都先 flush 当前草稿，再切换视图。 */
function activateMainTab(tab: MainTab): void {
  switch (tab) {
    case "timeline": void showTimeline(); break;
    case "calendar": void showCalendar(); break;
    case "create": void startNewDraft(); break;
    case "museum": void flushBeforeLeave().then(async ok => {
      if (ok) { setView(tab); if (!blockedDescription) await museum.enter(); }
    }).catch(showError); break;
    case "mine": void flushBeforeLeave().then(ok => { if (ok) setView(tab); }); break;
  }
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
    ["加密", summary.encryption === "none" ? "未加密（明文）" : "口令加密"],
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
  setView("settings");
}

async function exportBackupNow(): Promise<void> {
  if (!ensureWritable()) return;
  clearErrorBox();
  let password: string | undefined;
  if (encryptToggle.checked) {
    if (backupPassword.value.length === 0) { showErrorDescription({ kind: "validation", title: "请设置口令", detail: "勾选了加密就需要设置口令；不想加密请取消勾选。" }); return; }
    if (backupPassword.value !== backupPassword2.value) { showErrorDescription({ kind: "validation", title: "两次输入的口令不一致", detail: "请重新输入。口令不会被保存。" }); return; }
    password = backupPassword.value;
  }
  exportBackupButton.disabled = true;
  exportBackupButton.textContent = password ? "正在加密导出…" : "正在导出…";
  try {
    const result = await api.exportBackup(password ? { password } : {});
    backupPassword.value = ""; backupPassword2.value = "";
    if (result.cancelled) { showAppNotice("已取消导出，没有生成文件", "calm"); return; }
    const head = document.createElement("strong");
    head.textContent = password ? "加密备份已导出并校验通过" : "备份已导出并校验通过";
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
  unlockPassword.value = "";
  unlockArea.hidden = true;
  pickedActions.hidden = true;
  if (token !== null) await api.discardPickedBackup(token).catch(() => undefined);
}

async function pickBackupNow(): Promise<void> {
  if (!ensureWritable()) return;
  clearErrorBox();
  await clearPicked();
  pickBackupButton.disabled = true;
  pickBackupButton.textContent = "正在校验…";
  try {
    const result = await api.pickBackup();
    if (result.cancelled) { showAppNotice("没有选择文件，当前数据未改动", "calm"); return; }
    pickedToken = result.token;
    const head = document.createElement("strong");
    if (result.encrypted || result.summary === null) {
      head.textContent = `已选择加密备份：${result.fileName}`;
      pickedSummary.replaceChildren(head);
      unlockArea.hidden = false;
      pickedActions.hidden = true;
    } else {
      head.textContent = `校验通过：${result.fileName}`;
      pickedSummary.replaceChildren(head, summaryList(result.summary));
      unlockArea.hidden = true;
      pickedActions.hidden = false;
    }
    pickedBackup.hidden = false;
  } catch (error) {
    showError(error);
  } finally {
    pickBackupButton.disabled = false;
    pickBackupButton.textContent = "选择备份文件…";
  }
}

async function unlockBackupNow(): Promise<void> {
  const token = pickedToken;
  if (token === null) return;
  if (unlockPassword.value.length === 0) { showErrorDescription({ kind: "validation", title: "请输入口令", detail: "加密备份需要导出时设置的口令。" }); return; }
  clearErrorBox();
  unlockButton.disabled = true;
  unlockButton.textContent = "正在解锁…";
  try {
    const { summary } = await api.unlockBackup(token, unlockPassword.value);
    unlockPassword.value = "";
    const head = document.createElement("strong");
    head.textContent = "口令正确，校验通过";
    pickedSummary.replaceChildren(head, summaryList(summary));
    unlockArea.hidden = true;
    pickedActions.hidden = false;
  } catch (error) {
    showError(error);
  } finally {
    unlockButton.disabled = false;
    unlockButton.textContent = "解锁并校验";
  }
}

async function mergeBackupNow(): Promise<void> {
  if (!ensureWritable()) return;
  const token = pickedToken;
  if (token === null) return;
  clearErrorBox();
  let plan;
  try { plan = await api.planMerge(token); } catch (error) { showError(error); return; }
  const c = plan.counts;
  const lines = [
    `将新增 ${c.added} 条记录，更新 ${c.updated} 条较新的版本，${c.unchanged} 条无变化。`,
    c.conflicts + c.conflictCopiesAdded > 0 ? `有分歧的内容会两份都保留：新增 ${c.conflictCopiesAdded} 份冲突副本。` : "",
    c.skippedDeleted > 0 ? `备份里有 ${c.skippedDeleted} 条你已经永久删除的记录，不会被带回来。` : "",
    c.keptTrashed > 0 ? `${c.keptTrashed} 条在回收站的记录保持在回收站。` : "",
    c.deletedInBackup > 0 ? `备份里删除了 ${c.deletedInBackup} 条本机仍保留的记录：本机这几条保持不动。` : "",
    c.mediaAdded > 0 ? `将复制 ${c.mediaAdded} 张本机没有的照片原件。` : "",
    "现有数据只会被添加或更新，不会被整体替换；合并前会自动保留一份当前数据的安全副本。",
  ].filter(Boolean).join("");
  const confirmed = await askConfirm("合并导入这份备份？", lines, "确认合并");
  if (!confirmed) return;
  mergeBackupButton.disabled = true;
  mergeBackupButton.textContent = "正在合并…";
  try {
    if (!(await flushBeforeLeave())) return;
    if (!await mayResetSessions()) return;
    const result = await api.mergeBackup(token);
    pickedToken = null;
    pickedBackup.hidden = true;
    resetEditorLibrary();
    const m = result.plan.counts;
    showAppNotice(`合并完成：新增 ${m.added} 条、更新 ${m.updated} 条、冲突副本 ${m.conflictCopiesAdded} 份、已删除未复活 ${m.skippedDeleted} 条。合并前的数据已保存在 ${result.safetyBackup}`, "ok");
    await refreshDrafts();
    await reloadTimeline();
  } catch (error) {
    showError(error);
  } finally {
    mergeBackupButton.disabled = false;
    mergeBackupButton.textContent = "合并导入";
  }
}

async function restoreBackupNow(): Promise<void> {
  if (!ensureWritable()) return;
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
    if (!await mayResetSessions()) return;
    const result = await api.restoreBackup(token);
    pickedToken = null;
    pickedBackup.hidden = true;
    resetEditorLibrary();
    uiPreferences.removeItem(LAST_DRAFT_KEY);
    const r = result.restored;
    showAppNotice(`恢复完成：${r.formal} 条正式记录、${r.drafts} 份草稿、${r.trashed} 条回收站记录。恢复前的数据已保存在 ${result.safetyBackup}`, "ok");
    exportResult.hidden = true;
    // Content is already restored. A failed appearance refresh must not retain a consumed import token/session.
    await personal.refresh().catch(showError);
    await refreshDrafts();
    await reloadTimeline();
  } catch (error) {
    showError(error);
  } finally {
    restoreBackupButton.disabled = false;
    restoreBackupButton.textContent = "覆盖恢复";
  }
}

async function commitCurrent(): Promise<void> {
  if (!ensureWritable()) return;
  if (!canChangeEditor()) return;
  clearErrorBox();
  commitButton.disabled = true;
  commitButton.textContent = "正在存入…";
  try {
    const result = await editor.commit();
    parked.delete(editor);
    uiPreferences.removeItem(LAST_DRAFT_KEY);
    unfinishedDraft = null;
    refreshResumeNotice();
    const durability = editor.saveState.status === "savedUncertain" ? "uncertain" : result.durability;
    showAppNotice(durabilityLabel(durability), durability === "uncertain" ? "warn" : "ok");
    // M05 refreshes its retained result pages in SearchUi.resume().
    if (readingId && readingOrigin === "search") await openReading(readingId, true);
    else if (readingId) await leaveEditor();
    else await showTimeline(true);
  } catch (error) {
    const description = describeError(error);
    if (description.kind === "validation" && isFieldIssue(error)) showFieldIssue(error);
    else showError(error);
  } finally {
    commitButton.disabled = !editor.editable || editor.needsReload;
    commitButton.textContent = "存入时光";
  }
}

async function resolveKeepMine(): Promise<void> {
  const recordId = editor.recordId;
  if (recordId === null || !canChangeEditor()) return;
  clearErrorBox();
  keepMineButton.disabled = true;
  keepFormalButton.disabled = true;
  try {
    const result = await api.resolveConflict(recordId, "keepMine");
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
  const recordId = editor.recordId;
  if (recordId === null || !canChangeEditor()) return;
  clearErrorBox();
  keepMineButton.disabled = true;
  keepFormalButton.disabled = true;
  try {
    await api.resolveConflict(recordId, "keepFormal");
    openInEditor(null);
    uiPreferences.removeItem(LAST_DRAFT_KEY);
    showAppNotice("你的草稿已另存为冲突副本，不会丢失", "ok");
    await showDrafts();
  } catch (error) {
    showError(error);
  } finally {
    keepMineButton.disabled = false;
    keepFormalButton.disabled = false;
  }
}

async function mayResetSessions() {
  return !parked.size ||
    await askConfirm("放弃尚未保存的草稿修改？", "导入会重新打开资料库。可以取消，回草稿箱核对尚未保存的修改。", "放弃修改并继续");
}
function resetEditorLibrary() {
  parked.clear(); openInEditor(null);
}
let insertion: { owner: StoryEditor; index: number } | undefined;
function pickPhotos(index: number) {
  if (!canChangeEditor()) return;
  insertion = { owner: editor, index }; photoInput.click();
}
async function attachSelectedPhotos() {
  const target = insertion; insertion = undefined;
  const files = Array.from(photoInput.files ?? []); photoInput.value = "";
  if (!target) return;
  let index = target.index;
  try {
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) throw new Error("图片超过 25 MB");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (editor !== target.owner || !canChangeEditor()) return;
      editor.insertPhoto(index++, { fileName: file.name, bytes, caption: "", mediaType: file.type });
    }
    if (editor === target.owner) await editor.flush();
  } catch (error) { showError(error); }
}

const personal = new PersonalUi(api, memory !== null, flushBeforeLeave, visualPreview?.preferences);
const museum = new MuseumUi(byId("view-museum"), api, {
  read: id => openReading(id), write: () => { void startNewDraft(); },
  active: () => currentView === "museum", error: showError,
});
search = new SearchUi(byId("view-search"), api, {
  read: id => openReading(id), active: () => currentView === "search",
  photo: timelineCover, manageTags: () => { void openTagManager(); },
});
async function showSearch(): Promise<void> {
  if (!(await flushBeforeLeave())) return;
  setView("search"); if (!blockedDescription) await search.enter();
}
let readingId: string | null = null;
let readingOrigin: View = "timeline";
let readingScroll: ScrollPosition;
let readingEditScroll: ScrollPosition;
let readingList: Element | null = null;
let readingGeneration = 0;
let readingFocus: HTMLElement | null = null;
function loadReadingPhoto(img: HTMLImageElement, photo: PhotoUse, holder: HTMLElement) {
    const fallback = (message: string) => {
      img.hidden = true;
      const retry = document.createElement("button"); retry.className = "button";
      retry.textContent = `${message} · 重试（保留原记录）`;
      retry.addEventListener("click", () => { retry.remove(); img.hidden = false; void load(); });
      holder.append(retry);
    };
    const load = async () => {
      try {
        const status = await api.photoStatus(photo.assetId);
        if (status !== "available") { fallback(status === "missing" ? "原图缺失" : "原图校验失败"); return; }
        img.onerror = () => fallback(photo.mediaType.includes("heic") || photo.mediaType.includes("heif") ? "无法预览 HEIC 图片" : "图片无法预览，原图仍保留");
        img.src = await api.photoDataUrl(photo.assetId);
      } catch { fallback("暂时无法读取图片"); }
    }; void load();
}
async function openReading(id: string, returning = false, originControl?: HTMLElement): Promise<void> {
  const origin = currentView;
  if (!(await flushBeforeLeave())) return;
  const row = await api.getRecord(id); if (!row.formal || row.status !== "active") return;
  const tags = await api.listTags();
  if (currentView !== origin || byId("app-shell").inert) return;
  timelineTags = tags;
  if (!returning) {
    readingOrigin = currentView;
    readingScroll = scrollPosition();
    readingList = originControl?.closest(".journal, .timeline-list, #on-this-day-list") ?? null;
    readingGeneration = formalGeneration;
    readingFocus = originControl ?? document.activeElement as HTMLElement | null;
  }
  readingId = id;
  renderReading(byTestId("reading-content"), row, tagName, loadReadingPhoto);
  setView("reading");
  if (returning) {
    byTestId("reading-edit").focus({ preventScroll: true });
    restoreScroll(readingEditScroll);
  }
}
async function refreshReadingList(): Promise<void> {
  const generation = formalGeneration;
  if (readingOrigin === "timeline") await reloadTimeline(true);
  if (readingOrigin === "calendar") await refreshCalendar();
  if (readingOrigin === "collect") await refreshCollect();
  readingGeneration = generation;
}
async function leaveEditor(): Promise<void> {
  const id = readingId;
  if (!id) { await showDrafts(); return; }
  if (readingGeneration !== formalGeneration) await refreshReadingList();
  if (currentView === "editor" && readingId === id) await openReading(id, true);
}
byTestId("reading-edit").addEventListener("click", () => {
  readingEditScroll = scrollPosition();
  if (readingId) void openModification(readingId);
});
async function returnFromReading(): Promise<void> {
  setView(readingOrigin);
  if (readingOrigin === "museum") await museum.resume();
  if (readingOrigin === "search") await search.resume();
  if (readingGeneration !== formalGeneration) await refreshReadingList();
  if (currentView !== readingOrigin) return;
  if (readingFocus?.isConnected) readingFocus.focus({ preventScroll: true });
  else if (readingList) {
    const entry = Array.from(readingList.querySelectorAll<HTMLElement>('[data-testid="timeline-item"]'))
      .find(node => node.dataset.recordId === readingId);
    entry?.querySelector<HTMLElement>('[data-testid="edit-button"]')?.focus({ preventScroll: true });
  }
  restoreScroll(readingScroll);
}
byTestId("reading-back").addEventListener("click", () => { void returnFromReading().catch(showError); });

function backLayers(): BackLayer[] {
  const stack: BackLayer[] = [];
  const id = readingId, origin = readingOrigin;
  if (id && (currentView === "reading" || currentView === "editor")) {
    stack.push({ close: returnFromReading, reopen: async () => {
      if (currentView === origin) await openReading(id);
    } });
    if (currentView === "editor") stack.push({ close: leaveEditor, reopen: async () => {
      if (currentView === "reading" && readingId === id) await openModification(id);
    } });
  }
  if (currentView === "editor" && !id) stack.push({ close: leaveEditor });
  if (currentView === "editor" && editor.preview) stack.push({ close: closeDraftPreview, reopen: openDraftPreview });
  if (timelineSheet.open) stack.push({ close: () => timelineSheet.close(), reopen: openTimelineSheet });
  for (const dialog of [tagDialog, tagPickerDialog, chooseDraft, confirmDialog]) {
    if (dialog.open) stack.push({ close: () => dialog.close() });
  }
  return stack;
}
for (const dialog of [tagDialog, tagPickerDialog, chooseDraft, confirmDialog]) dialog.addEventListener("close", syncBack);

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-go]")) button.addEventListener("click", () => {
  const view = button.dataset.go as View;
  if (view === "search") void showSearch().catch(showError);
  else if (view === "timeline") void showTimeline(); else if (view === "drafts") void showDrafts(); else if (view === "collect") void showCollect(); else if (view === "trash") void showTrash();
  else void flushBeforeLeave().then(ok => { if (ok) setView(view); });
});
const locationField = byTestId<HTMLInputElement>("editor-location");
bindTyping(locationField, () => { if (canChangeEditor()) editor.editMeta({ location: locationField.value }); });
byTestId<HTMLSelectElement>("editor-mood").addEventListener("change", e => { if (canChangeEditor()) editor.editMeta({ mood: ((e.target as HTMLSelectElement).value || null) as Mood | null }); });

let unfinishedDraft: RecordRow | null = null;

function refreshResumeNotice(): void {
  resumeDraftBar.hidden = unfinishedDraft === null || blockedDescription !== null;
}

/** 找到没写完的草稿只在时光轴顶部温和提示，不强制跳走。 */
async function prepareUnfinishedDraft(): Promise<void> {
  try {
    const preferred = uiPreferences.getItem(LAST_DRAFT_KEY) ?? undefined;
    unfinishedDraft = await recoverLastDraft(api, preferred);
  } catch (error) {
    showError(error);
  }
  refreshResumeNotice();
}

async function resumeUnfinishedDraft(): Promise<void> {
  const row = unfinishedDraft;
  if (row === null) return;
  try {
    await openDraft(row);
  } catch (error) {
    showError(error);
  }
}

resumeDraftButton.addEventListener("click", () => { void resumeUnfinishedDraft(); });
newDraftButton.addEventListener("click", () => { void startNewDraft(); });
backButton.addEventListener("click", () => { void leaveEditor(); });
commitButton.addEventListener("click", () => { void commitCurrent(); });
photoInput.addEventListener("change", () => { void attachSelectedPhotos(); });
byTestId("add-photos").addEventListener("click", () => pickPhotos(editor.story.blocks.length));

openTrashButton.addEventListener("click", () => { void showTrash(); });
backToSettingsButton.addEventListener("click", () => { void showData(); });
collectManageTags.addEventListener("click", () => { void openTagManager(); });
calEmptyWrite.addEventListener("click", () => { void startNewDraftAt(calendarToday()); });
exportBackupButton.addEventListener("click", () => { void exportBackupNow(); });
pickBackupButton.addEventListener("click", () => { void pickBackupNow(); });
restoreBackupButton.addEventListener("click", () => { void restoreBackupNow(); });
discardPickedButton.addEventListener("click", () => { void clearPicked(); });
unlockButton.addEventListener("click", () => { void unlockBackupNow(); });
mergeBackupButton.addEventListener("click", () => { void mergeBackupNow(); });
encryptToggle.addEventListener("change", () => {
  encryptFields.hidden = !encryptToggle.checked;
  plainWarning.hidden = encryptToggle.checked;
  if (!encryptToggle.checked) { backupPassword.value = ""; backupPassword2.value = ""; }
});
emptyTrashButton.addEventListener("click", () => { void emptyTrash(); });
keepMineButton.addEventListener("click", () => { void resolveKeepMine(); });
keepFormalButton.addEventListener("click", () => { void resolveKeepFormal(); });

// ---- Unit-0.7 时光轴工具条 / 日历 / 标签交互 ----
function paintOrderToggle(): void {
  orderToggle.textContent = timelineOrder === "desc" ? "由近到远" : "由远到近";
  orderToggle.setAttribute("aria-label", `日期顺序，${orderToggle.textContent}，点击切换`);
  orderToggle.title = timelineOrder === "desc" ? "当前从新到旧，点击切换" : "当前从旧到新，点击切换";
}
paintOrderToggle();

jumpMonth.addEventListener("change", () => {
  const value = jumpMonth.value;
  if (value.length === 0) {
    timelineTo = null;
  } else {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    if (Number.isInteger(year) && Number.isInteger(month)) timelineTo = lastDayOfMonth(year, month);
  }
  void reloadTimeline();
});
jumpLatest.addEventListener("click", () => {
  timelineTo = null;
  void reloadTimeline();
});
orderToggle.addEventListener("click", () => {
  timelineOrder = timelineOrder === "desc" ? "asc" : "desc";
  paintOrderToggle();
  void reloadTimeline();
});
favoriteFilter.addEventListener("change", () => { void reloadTimeline(); });
manageTagsButton.addEventListener("click", () => { void openTagManager(); });
tagCloseButton.addEventListener("click", () => { tagDialog.close(); });
tagCreateButton.addEventListener("click", () => { void createTagFromManager(); });
tagNewInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); void createTagFromManager(); }
});

async function createTagFromManager(): Promise<void> {
  try {
    const tag = await api.createTag(tagNewInput.value);
    tagNewInput.value = "";
    setDialogStatus(tagDialogStatus, `已新建标签「${tag.name}」`, "ok");
    await refreshTagManager();
  } catch (error) {
    if (errorCode(error) === "TAG_NAME_CONFLICT") {
      setDialogStatus(tagDialogStatus, "已有同名标签，可以直接使用", "warn");
      return;
    }
    setDialogStatus(tagDialogStatus, describeError(error).detail, "error");
  }
}

tagPickerCancel.addEventListener("click", () => { tagPickerDialog.close(); });
tagPickerSave.addEventListener("click", () => { void savePickerTags(); });
tagPickerCreate.addEventListener("click", () => { void createTagForPicker(); });
tagPickerNew.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); void createTagForPicker(); }
});

function shiftCalendarMonth(delta: number): void {
  const next = calMonth + delta;
  if (next < 1) { calYear -= 1; calMonth = 12; }
  else if (next > 12) { calYear += 1; calMonth = 1; }
  else calMonth = next;
  calSelectedDate = null;
  void refreshCalendar();
}
calPrev.addEventListener("click", () => { shiftCalendarMonth(-1); });
calNext.addEventListener("click", () => { shiftCalendarMonth(1); });
calMonthInput.addEventListener("change", () => {
  const value = calMonthInput.value;
  if (!/^\d{4}-\d{2}$/.test(value)) return;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  if (year < 1 || year > 9999 || month < 1 || month > 12) return;
  calYear = year;
  calMonth = month;
  calSelectedDate = null;
  void refreshCalendar();
});
calToday.addEventListener("click", () => {
  const today = calendarToday();
  calYear = Number(today.slice(0, 4));
  calMonth = Number(today.slice(5, 7));
  calSelectedDate = today;
  void refreshCalendar();
});

const timelineSentinelObserver = new IntersectionObserver((entries) => {
  if (currentView === "timeline" && entries.some((entry) => entry.isIntersecting)) void loadMoreTimeline();
}, { rootMargin: "360px" });
timelineSentinelObserver.observe(timelineSentinel);

bindTyping(editorTitle, () => { if (canChangeEditor()) { clearAppNotice(); editor.editMeta({ title: editorTitle.value }); } });
bindTyping(editorBody, () => { if (canChangeEditor() && editor.mode === "quick") { clearAppNotice(); editor.quickBody(editorBody.value, editorBody.selectionEnd); } });
editorDate.addEventListener("input", () => { if (canChangeEditor()) editor.editMeta({ eventDate: editorDate.value }); });
editorTime.addEventListener("input", () => { if (canChangeEditor()) editor.editMeta({ eventTime: editorTime.value || null }); });

for (const [control, mode] of [["mode-quick", "quick"], ["mode-story", "story"], ["enter-story", "story"]] as const) {
  byTestId(control).addEventListener("click", () => {
    if (currentView !== "editor" || byId("app-shell").inert) return;
    editor.switchMode(mode);
    if (control === "enter-story") byTestId("mode-story").focus();
  });
}
byTestId("reload-editor").addEventListener("click", () => { void (async () => {
  const owner = editor, id = editor.recordId;
  if (!id || !editor.needsReload || !canChangeEditor()) return;
  if (!await askConfirm("打开最新草稿？", "当前会话中尚未保存的编辑将被放弃。", "打开最新草稿")) return;
  const row = await api.getRecord(id);
  if (editor === owner && canChangeEditor() && row.status === "active") {
    parked.delete(owner); openInEditor(row);
  }
})().catch(showError); });
byTestId("story-undo").addEventListener("click", () => { if (canChangeEditor()) editor.undo(); });
byTestId("story-redo").addEventListener("click", () => { if (canChangeEditor()) editor.redo(); });
viewEditor.addEventListener("keydown", event => {
  if (!canChangeEditor() || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "z" || key === "y") {
    event.preventDefault();
    if (key === "y" || event.shiftKey) editor.redo(); else editor.undo();
  }
});

let previewPlace: { scroll: ScrollPosition; field: HTMLElement; selection: [number, number] | null; top: number } | undefined;
viewEditor.addEventListener("focusin", event => {
  const field = event.target as HTMLElement;
  if (field.closest("#editor-fields")) lastEditorFocus = field;
});
function openDraftPreview() {
  if (!canChangeEditor()) return;
  const field = lastEditorFocus?.isConnected ? lastEditorFocus : byTestId("draft-preview-open");
  const text = field as HTMLTextAreaElement;
  previewPlace = { scroll: scrollPosition(), field, top: field.scrollTop,
    selection: typeof text.selectionStart === "number" ? [text.selectionStart, text.selectionEnd] : null };
  const tags = Array.from(byTestId("editor-tag-chips").children, chip => chip.textContent ?? "");
  renderStoryReading(byTestId("draft-preview-content"), editor.meta, editor.story, tags, (img, photo, holder) => {
    const url = pendingPhotoUrl(photo);
    if (url) img.src = url; else loadReadingPhoto(img, photo, holder);
  });
  editor.setPreview(true); restoreScroll(); byTestId("draft-preview-back").focus({ preventScroll: true }); syncBack();
}
function closeDraftPreview() {
  if (currentView !== "editor" || !editor.preview) return;
  editor.setPreview(false); byTestId("draft-preview-content").replaceChildren();
  const place = previewPlace; previewPlace = undefined;
  if (place) {
    const target = place.field.isConnected ? place.field : byTestId("draft-preview-open");
    target.focus({ preventScroll: true });
    if (place.selection && target === place.field) (target as HTMLTextAreaElement).setSelectionRange(...place.selection);
    target.scrollTop = place.top; restoreScroll(place.scroll);
  }
  syncBack();
}
byTestId("draft-preview-open").addEventListener("click", openDraftPreview);
byTestId("draft-preview-back").addEventListener("click", closeDraftPreview);
window.addEventListener("beforeunload", event => {
  if (editor.pending || editor.needsReload || parked.size) { event.preventDefault(); event.returnValue = ""; }
  void editor.settle().catch(showError);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void editor.settle().catch(showError);
});
window.addEventListener("pagehide", () => { void editor.settle().catch(showError); });

async function boot(): Promise<void> {
  if (visualPreview) await visualPreview.prepare();
  await waitForStore();
  await personal.start();
  const start = initialTab({ param: params.get("view") });
  setView(start);
  try {
    if (memory !== null) {
      showPreviewNotice();
      if (!visualPreview && (demo || searchDemo !== null) && memory.resetUnlockedDemo()) {
        if (searchDemo !== null) await seedSearchDemo(memory, searchDemo);
        else { uiPreferences.removeItem(LAST_DRAFT_KEY); await seedDemo(memory); }
      }
      if (params.get("fail") === "conflict") memory.failNext("REVISION_CONFLICT", "commitRecord");
      if (params.get("fail") === "uncertain") memory.durabilityMode = "uncertain";
    }
    if (visualPreview?.filtered) {
      favoriteFilter.checked = true;
      timelineTo = "2026-11-30";
    }
    await reportMedia();
    await refreshDrafts();
    await reloadTimeline();
    await prepareUnfinishedDraft();
    if (currentView !== start) return;
    if (start === "timeline" && visualPreview?.panel) openTimelineSheet();
    if (start === "calendar") await refreshCalendar();
    if (start === "collect") await refreshCollect();
    if (start === "museum") await museum.enter();
    if (start === "search") await search.enter();
  } finally {
    // 视觉证据脚本等待这个标记，确保演示数据和初始视图都已就绪。
    document.body.dataset.appReady = "1";
  }
}

void boot().catch(showError);
