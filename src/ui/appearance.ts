import { describeError } from "../domain/errors.ts";
import { durabilityLabel } from "../domain/format.ts";
import type { AppSettings, ThemePreference } from "../domain/types.ts";
import type { ShiguangApi } from "../platform/api.ts";

export const THEME_CACHE_KEY = "shiguang.theme";
export const FONT_SCALE_KEY = "shiguang.fontScale";
export const FONT_SCALES = ["1", "1.15", "1.3"] as const;

export function themePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}
export function resolvedTheme(preference: ThemePreference, systemDark: boolean): "light" | "dark" {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}
function cached(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function cache(key: string, value: string): boolean {
  try { window.localStorage.setItem(key, value); return true; } catch { return false; }
}
const node = <T extends HTMLElement = HTMLElement>(id: string): T => document.querySelector<T>(`[data-testid="${id}"]`)!;

/** The cache is only for paint, never a replacement for native/preview settings.
 * Font scale is a device UI preference; no new domain field or backup schema. */
export class AppearanceUi {
  private preference = themePreference(cached(THEME_CACHE_KEY));
  private media = window.matchMedia("(prefers-color-scheme: dark)");
  private selector = node<HTMLSelectElement>("theme-select");
  private font = node<HTMLSelectElement>("font-scale");
  private choices = [...document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")];
  private busy = false;
  private api: ShiguangApi;
  private changed: (settings: AppSettings) => void;

  constructor(api: ShiguangApi, changed: (settings: AppSettings) => void) {
    this.api = api; this.changed = changed;
    this.font.value = cached(FONT_SCALE_KEY) ?? "1";
    if (!FONT_SCALES.some(value => value === this.font.value)) this.font.value = "1";
    this.applyFont();
    this.font.addEventListener("change", () => {
      if (!FONT_SCALES.some(value => value === this.font.value)) this.font.value = "1";
      this.applyFont();
      node("appearance-feedback").textContent = cache(FONT_SCALE_KEY, this.font.value)
        ? "字号已保存在本机。" : "字号已应用，本机界面偏好暂时无法保存。";
    });
    this.selector.addEventListener("change", () => { void this.choose(themePreference(this.selector.value)); });
    for (const choice of this.choices) choice.addEventListener("click", () => { void this.choose(themePreference(choice.dataset.themeChoice)); });
    this.media.addEventListener("change", () => this.paint());
    this.paint();
  }

  sync(preference: ThemePreference): void {
    this.preference = preference;
    cache(THEME_CACHE_KEY, preference);
    this.paint();
  }
  private applyFont(): void {
    // Percentages multiply the user's default size instead of assuming a 16px root.
    document.documentElement.style.fontSize = `${Math.round(Number(this.font.value) * 100)}%`;
  }
  private paint(): void {
    const resolved = resolvedTheme(this.preference, this.media.matches);
    document.documentElement.dataset.themePreference = this.preference;
    document.documentElement.dataset.theme = resolved;
    this.selector.value = this.preference;
    for (const choice of this.choices) choice.setAttribute("aria-pressed", String(choice.dataset.themeChoice === this.preference));
    node("appearance-current").textContent = `${this.preference === "system" ? "跟随系统 · " : "当前外观 · "}${resolved === "dark" ? "灯下展馆" : "暖纸本"}`;
  }
  private async choose(preference: ThemePreference): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.selector.disabled = true;
    for (const choice of this.choices) choice.disabled = true;
    try {
      const result = await this.api.setTheme(preference);
      this.changed(result.settings);
      this.sync(result.settings.theme);
      node("appearance-feedback").textContent = durabilityLabel(result.durability);
    } catch (error) {
      this.paint();
      node("appearance-feedback").textContent = describeError(error).detail;
    } finally {
      this.busy = false; this.selector.disabled = false;
      for (const choice of this.choices) choice.disabled = false;
    }
  }
}
