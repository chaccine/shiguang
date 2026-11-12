import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { AppearanceUi, FONT_SCALE_KEY, THEME_CACHE_KEY, resolvedTheme } from "../src/ui/appearance.ts";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { createTauriApi } from "../src/platform/tauri-adapter.ts";
import type { AppSettings } from "../src/domain/types.ts";

const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
const earlyScript = html.match(/<script>([\s\S]*?)<\/script>/)![1];

test("theme and relative font scale apply before styles/modules: explicit, system, invalid and denied cache", () => {
  assert.ok(html.indexOf("<script>") < html.indexOf('<link rel="stylesheet"'));
  for (const [preference, systemDark, scale, expected] of [
    ["light", true, "1", "light"], ["dark", false, "1.3", "dark"],
    ["system", true, "1.15", "dark"], ["system", false, "1", "light"],
    ["bogus", true, "200px", "dark"], [null, false, null, "light"],
  ] as const) {
    const root = { dataset: {} as Record<string, string>, style: {fontSize: ""} };
    runInNewContext(earlyScript, {
      document: { documentElement: root }, matchMedia: () => ({matches: systemDark}),
      localStorage: {getItem: (key: string) => key === THEME_CACHE_KEY ? preference : scale},
    });
    assert.equal(root.dataset.theme, expected);
    assert.equal(root.style.fontSize, ["1", "1.15", "1.3"].includes(scale ?? "") ? `${Math.round(Number(scale) * 100)}%` : "100%");
  }
  const root = { dataset: {} as Record<string, string>, style: {fontSize: ""} };
  runInNewContext(earlyScript, {document: {documentElement: root}, matchMedia: () => ({matches: true}),
    localStorage: {getItem: () => {throw new Error("denied");}}});
  assert.equal(root.dataset.theme, "dark"); assert.equal(root.style.fontSize, "100%");
});

class Control {
  value = ""; disabled = false; textContent = "";
  dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  private handlers = new Map<string, Array<() => void>>();
  addEventListener(name: string, handler: () => void) { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  fire(name: string) { for (const handler of this.handlers.get(name) ?? []) handler(); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
}
async function settle(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("Appearance change did not settle");
}
function environment() {
  const original = {window: globalThis.window, document: globalThis.document};
  const controls = new Map<string, Control>();
  const control = (id: string) => { let c = controls.get(id); if (!c) { c = new Control(); controls.set(id, c); } return c; };
  const choices = ["light", "dark", "system"].map(theme => {const c = new Control(); c.dataset.themeChoice = theme; return c;});
  const values = new Map<string, string>(); let denied = false;
  const storage = {getItem: (key: string) => {if (denied) throw Error("denied"); return values.get(key) ?? null;},
    setItem: (key: string, value: string) => {if (denied) throw Error("denied"); values.set(key, value);}};
  const root = {dataset: {} as Record<string, string>, style: {fontSize: ""}};
  let mediaListener = () => {};
  const media = {matches: false, addEventListener: (_name: string, fn: () => void) => {mediaListener = fn;}};
  Object.assign(globalThis, {window: {localStorage: storage, matchMedia: () => media},
    document: {documentElement: root, querySelector: (selector: string) => control(selector.match(/data-testid="([^"]+)"/)![1]), querySelectorAll: () => choices}});
  return {control, choices, values, storage, root, setDenied: () => {denied = true;},
    system: (dark: boolean) => {media.matches = dark; mediaListener();}, restore: () => Object.assign(globalThis, original)};
}

test("real appearance controller persists all three choices and live system changes never overwrite preference", async () => {
  const env = environment();
  try {
    env.values.set(THEME_CACHE_KEY, "dark"); env.values.set(FONT_SCALE_KEY, "1.3");
    const api = new MemoryAdapter({search: ""});
    const ui = new AppearanceUi(api, () => {});
    assert.equal(env.root.dataset.theme, "dark"); assert.equal(env.root.style.fontSize, "130%");
    ui.sync((await api.getSettings()).theme);
    assert.equal(env.root.dataset.theme, "light"); // Authoritative system setting beats stale paint cache.
    for (const [i, preference] of ["light", "dark", "system"].entries()) {
      env.choices[i].fire("click");
      await settle(() => !env.choices[i].disabled);
      assert.equal((await api.getSettings()).theme, preference);
      assert.equal(env.values.get(THEME_CACHE_KEY), preference);
      assert.deepEqual(env.choices.map(c => c.attributes.get("aria-pressed")), env.choices.map(c => String(c.dataset.themeChoice === preference)));
    }
    env.system(true); assert.equal(env.root.dataset.theme, "dark");
    assert.equal(env.values.get(THEME_CACHE_KEY), "system"); assert.equal((await api.getSettings()).theme, "system");
    env.system(false); assert.equal(env.root.dataset.theme, "light");
    env.choices[1].fire("click"); await settle(() => !env.choices[1].disabled);
    env.system(false); assert.equal(env.root.dataset.theme, "dark");
    assert.match(env.control("appearance-current").textContent, /灯下展馆/);
    env.control("theme-select").value = "light"; env.control("theme-select").fire("change");
    await settle(() => !env.control("theme-select").disabled);
    assert.equal((await api.getSettings()).theme, "light");
  } finally { env.restore(); }
});

test("theme write failure preserves saved style/cache, font sizes stay relative and storage denial stays usable", async () => {
  const env = environment();
  try {
    const api = new MemoryAdapter({search: ""}); const ui = new AppearanceUi(api, () => {}); ui.sync("light");
    api.failNext("DISK_FULL", "setTheme");
    env.choices[1].fire("click"); assert.equal(env.choices.every(c => c.disabled), true);
    await settle(() => !env.choices[1].disabled);
    assert.equal(env.root.dataset.theme, "light"); assert.equal(env.values.get(THEME_CACHE_KEY), "light");
    assert.equal(env.control("theme-select").value, "light"); assert.ok(env.control("appearance-feedback").textContent);
    for (const [scale, expected] of [["1", "100%"], ["1.15", "115%"], ["1.3", "130%"], ["bad", "100%"]]) {
      env.control("font-scale").value = scale; env.control("font-scale").fire("change");
      assert.equal(env.root.style.fontSize, expected);
    }
    env.setDenied();
    const denied = new AppearanceUi(api, () => {}); denied.sync("dark");
    assert.equal(env.root.dataset.theme, "dark");
    env.control("font-scale").value = "1.3"; env.control("font-scale").fire("change");
    assert.equal(env.root.style.fontSize, "130%"); assert.match(env.control("appearance-feedback").textContent, /无法保存/);
  } finally { env.restore(); }
});

test("appearance consumes the unchanged Tauri settings contract and follows restored backend preference", async () => {
  const env = environment();
  try {
    let settings: AppSettings = {theme: "system", appLock: {enabled: false, failedAttempts: 0, retryAfterMs: 0}};
    const calls: unknown[] = [];
    const api = createTauriApi(async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      if (command === "get_settings") return settings as T;
      assert.equal(command, "set_theme"); assert.equal(args?.theme, "dark");
      settings = {...settings, theme: "dark"}; return {settings, durability: "durable"} as T;
    });
    const ui = new AppearanceUi(api, () => {}); ui.sync((await api.getSettings()).theme);
    env.choices[1].fire("click"); await settle(() => !env.choices[1].disabled);
    assert.equal(env.root.dataset.theme, "dark"); assert.equal(env.values.get(THEME_CACHE_KEY), "dark");
    settings = {...settings, theme: "light"}; ui.sync((await api.getSettings()).theme);
    assert.equal(env.root.dataset.theme, "light"); assert.equal(env.values.get(THEME_CACHE_KEY), "light");
    assert.deepEqual(calls, [["get_settings", undefined], ["set_theme", {theme: "dark"}], ["get_settings", undefined]]);
    assert.equal(resolvedTheme("system", true), "dark");
  } finally { env.restore(); }
});
