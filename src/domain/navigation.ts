/**
 * 0.1.10 主导航：五个一级页签永远可见，与数据状态（有无记录/草稿）无关。
 * 纯函数，便于测试；UI 只负责渲染。
 */
export type MainTab = "timeline" | "calendar" | "create" | "museum" | "mine";
/** 一级页签之外的二级视图：编辑器、回收站（从设置进入）。 */
export type View = MainTab | "drafts" | "collect" | "settings" | "editor" | "trash" | "reading" | "storage" | "appearance" | "privacy";

export interface NavTab { id: MainTab; label: string; testId: string }

export const NAV_TABS: readonly NavTab[] = Object.freeze([
  { id: "timeline", label: "时光轴", testId: "timeline-tab" },
  { id: "calendar", label: "日历", testId: "calendar-tab" },
  { id: "create", label: "＋记录", testId: "create-tab" },
  { id: "museum", label: "博物馆", testId: "museum-tab" },
  { id: "mine", label: "我的", testId: "mine-tab" },
]);

export const DEFAULT_TAB: MainTab = "timeline";
export const LAST_TAB_KEY = "shiguang.lastTab";

export function isMainTab(value: unknown): value is MainTab {
  return typeof value === "string" && NAV_TABS.some((t) => t.id === value);
}

/** 旧的 ?view= 取值（0.1.7 及以前）映射到新页签。 */
const LEGACY: Record<string, View> = { data: "settings", backup: "settings", tags: "collect", favorites: "collect" };

export interface InitialViewInput {
  /** URL ?view= 参数（预览/截图脚本用）。 */
  param?: string | null;
  /** 上次停留的一级页签（localStorage，可选）。 */
  lastTab?: string | null;
}

/** 启动时的页签：显式预览参数 > 时光轴；上次页签不影响正常启动。永远不因“没有记录/没有草稿”而落到别的页。 */
export function initialTab(input: InitialViewInput = {}): View {
  for (const raw of [input.param]) {
    if (raw == null) continue;
    if (isMainTab(raw) && raw !== "create") return raw;
    if (["drafts", "collect", "settings"].includes(raw)) return raw as View;
    const legacy = LEGACY[raw];
    if (legacy !== undefined) return legacy;
  }
  return DEFAULT_TAB;
}

/** 某个视图属于哪个一级页签（用于高亮）。 */
export function tabOf(view: View): MainTab {
  if (view === "editor") return "create";
  if (view === "reading") return "timeline";
  if (!isMainTab(view)) return "mine";
  return view;
}

/** 只有一级页签才记为“上次页签”；编辑器/回收站不记，避免下次启动直接进二级页。 */
export function rememberableTab(view: View): MainTab | null {
  return isMainTab(view) && view !== "create" ? view : null;
}

export interface DataState { formalCount: number; draftCount: number }

/** 主导航在任何视图、任何数据状态下都可见；返回可见页签。 */
export function visibleTabs(_view: View, _data: DataState): readonly NavTab[] {
  return NAV_TABS;
}

export type EmptyKind = "none" | "no-entries" | "filtered-empty";

/** 时光轴空态：一条都没有 → 欢迎 + “写下第一段时光”；有记录但筛选为空 → 提示清除筛选。 */
export function timelineEmptyKind(total: number, formalCount: number): EmptyKind {
  if (total > 0) return "none";
  return formalCount === 0 ? "no-entries" : "filtered-empty";
}
