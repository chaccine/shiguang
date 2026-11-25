import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bootDom, until } from "./support/boot-dom.ts";
import { mobilePreview } from "../src/ui/mobile-preview.ts";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { MINT_SVG } from "../src/platform/synthetic-media.ts";
import { PREVIEW_STORAGE_KEY } from "../src/ui/demo.ts";

function setup(t: TestContext, query = "?stage01=timeline") {
  const ui = bootDom(query);
  t.after(ui.restore);
  const list = ui.id("timeline-list"), sheet = ui.id("timeline-sheet"), opener = ui.byTest("timeline-filters");
  const records = () => list.querySelectorAll('[data-testid="timeline-item"]');
  async function load() { await import(new URL(`../src/ui/main.ts?visual=${encodeURIComponent(t.name)}`, import.meta.url).href); }
  const ready = () => until(() => ui.body.dataset.appReady === "1");
  return { ...ui, list, records, sheet, opener, load, ready };
}

test("the five real navigation buttons use the same exact labels, one plus and distinct outline icons", async t => {
  const ui = setup(t);
  await ui.load(); await ui.ready();
  const tabs = ui.id("nav-tabs").children;
  const names = ["时光轴", "日历", "＋记录", "博物馆", "我的"];
  assert.deepEqual(tabs.map(b => b.querySelector(".tab-label")?.textContent), names);
  assert.deepEqual(tabs.map(b => b.getAttribute("aria-label")), names);
  assert.equal(ui.id("nav-tabs").visibleText().match(/[+＋]/g)?.length, 1);
  const icons = tabs.map(button => button.querySelector("svg")!);
  assert.deepEqual(icons.map(svg => svg.getAttribute("data-icon")), ["timeline", "calendar", "create", "museum", "mine"]);
  assert.ok(icons.every(svg => svg.getAttribute("aria-hidden") === "true" && svg.getAttribute("focusable") === "false"));
  const outlines = icons.map(svg => svg.querySelector("path")!.getAttribute("d"));
  assert.equal(new Set(outlines).size, 5);
  assert.match(outlines[1]!, /M8 3v4m8-4v4/); // Two binding rings above the calendar header.
  assert.match(outlines[3]!, /9.5-5 9.5 5z/); // Museum pediment above its columns.
  assert.equal(ui.byTest("timeline-tab").getAttribute("aria-current"), "page");
});

for (const theme of ["light", "dark"]) {
  test(`${theme} journal opens with the real cover, date and body; text-only entries have no photo placeholder`, async t => {
    const ui = setup(t, `?stage01=timeline&theme=${theme}`);
    await ui.load(); await ui.ready();
    assert.equal(document.documentElement.dataset.theme, theme);
    assert.deepEqual(ui.list.querySelectorAll("h2").map(n => n.textContent), ["2026年11月", "2026年10月"]);
    const records = ui.records();
    assert.equal(records.length, 5);
    const read = records[0].querySelector('[data-testid="edit-button"]')!;
    assert.deepEqual(read.children.map(n => n.className), ["timeline-cover", "entry-dateline", "entry-excerpt"]);
    const image = read.querySelector("img")!;
    const thumbs = t.mock.method(MemoryAdapter.prototype, "photoThumbUrl");
    ui.intersect(image);
    assert.equal(thumbs.mock.calls[0].arguments[0], image.dataset.assetId);
    // The Node event DOM has no bitmap decoder. It should show the real fallback.
    await until(() => !!read.querySelector('[data-testid="cover-fallback"]'));
    const textOnly = records.find(n => n.visibleText().includes("两行铅字"))!;
    assert.equal(textOnly.querySelector("img"), null);
    assert.equal(textOnly.querySelector(".entry-dateline")!.querySelector("time")!.textContent, "11月14日");
    assert.doesNotMatch(textOnly.visibleText(), /00:00|移到回收站/);
    textOnly.querySelector("summary")!.fire("click");
    assert.equal(textOnly.querySelector('[data-testid="edit-tags"]')!.visible, true);
    assert.equal(textOnly.querySelector('[data-testid="trash-button"]')!.visible, true);
    read.fire("click");
    await until(() => ui.id("view-reading").visible);
    const original = ui.byTest("reading-cover").querySelector("img")!;
    await until(() => !!original.src);
    assert.equal(Buffer.from(original.src.split(",")[1], "base64").toString(), MINT_SVG);
  });
}

test("sheet supports nested tag management and returns focus after Done, backdrop, cancel and history Back", async t => {
  const ui = setup(t);
  await ui.load(); await ui.ready();
  assert.equal(ui.opener.getAttribute("aria-controls"), ui.sheet.id);
  assert.equal(ui.byTest("jump-month").visible, false);
  Object.assign(ui.sheet, { getBoundingClientRect: () => ({ left: 0, top: 200, right: 360, bottom: 800 }) });
  for (const exit of ["done", "backdrop", "cancel", "back"]) {
    ui.opener.focus(); ui.opener.fire("click");
    assert.equal(ui.active(), ui.byTest("filters-close"));
    assert.equal(ui.sheet.open, true);
    assert.equal(ui.opener.getAttribute("aria-expanded"), "true");
    for (const name of ["jump-month", "jump-latest", "order-toggle", "favorite-filter", "manage-tags"]) assert.equal(ui.byTest(name).visible, true);
    if (exit === "done") {
      ui.byTest("manage-tags").fire("click");
      await until(() => ui.id("tag-dialog").open);
      ui.history.back(); await until(() => !ui.id("tag-dialog").open);
      assert.equal(ui.sheet.open, true);
      ui.byTest("filters-close").fire("click");
    } else if (exit === "backdrop") {
      ui.sheet.fire("click", { clientX: 180, clientY: 320 });
      assert.equal(ui.sheet.open, true);
      ui.sheet.fire("click", { clientX: 180, clientY: 180 });
    } else if (exit === "cancel") ui.sheet.fire("cancel"); // HTML dialog's Escape/cancel path.
    else ui.history.back();
    await until(() => !ui.sheet.open && !ui.history.state);
    assert.equal(ui.opener.getAttribute("aria-expanded"), "false");
    assert.equal(ui.active(), ui.opener);
  }
});

test("month cutoff, alternate sort, favorite and each tag can be independently removed outside the sheet", async t => {
  const ui = setup(t, "?stage01=timeline&filters=active&panel=open");
  await ui.load(); await ui.ready();
  const strip = ui.id("active-conditions");
  const keys = () => strip.children.map(n => n.dataset.condition);
  assert.deepEqual(keys(), ["month", "favorite"]);
  ui.byTest("jump-month").value = "2026-10"; ui.byTest("jump-month").fire("change");
  await until(() => ui.records().length === 1);
  ui.byTest("order-toggle").fire("click");
  const tag = (name: string) => ui.id("tag-filter-chips").children.find(b => b.textContent === name)!;
  const colors = "tag:" + tag("色样").dataset.tagId, type = "tag:" + tag("排印").dataset.tagId;
  for (const name of ["色样", "排印"]) {
    tag(name).focus(); tag(name).fire("click");
    await until(() => tag(name).getAttribute("aria-pressed") === "true");
    assert.equal(ui.active(), tag(name));
  }
  ui.byTest("filters-close").fire("click");
  assert.deepEqual(keys(), ["month", "order", "favorite", colors, type]);
  async function remove(key: string, count: number) {
    const chip = strip.children.find(n => n.dataset.condition === key)!;
    assert.match(chip.getAttribute("aria-label")!, /移除条件/);
    chip.focus(); chip.fire("click");
    await until(() => !keys().includes(key) && ui.records().length === count);
    assert.ok(ui.active()?.isConnected);
  }
  await remove(colors, 0);
  await until(() => !!ui.findTest("clear-filters"));
  assert.match(ui.list.visibleText(), /没有符合筛选/);
  await remove("month", 1); assert.equal(ui.byTest("jump-month").value, "");
  await remove("favorite", 3); assert.equal(ui.byTest("favorite-filter").checked, false);
  await remove("order", 3); assert.equal(ui.byTest("order-toggle").textContent, "由近到远");
  await remove(type, 5);
  assert.equal(strip.hidden, true); assert.equal(ui.active(), ui.opener);
  ui.opener.fire("click");
  ui.byTest("jump-month").value = "2026-10"; ui.byTest("jump-month").fire("change");
  await until(() => ui.records().length === 2);
  ui.byTest("jump-latest").fire("click");
  await until(() => ui.records().length === 5 && strip.hidden);
});

for (const origin of ["timeline", "calendar"]) {
  test(`${origin} → reading → edit/commit → reading/back restores the source control, conditions, day and offsets`, async t => {
    const ui = setup(t, "?stage01=timeline&filters=active");
    await ui.load(); await ui.ready();
    const source = origin === "timeline" ? ui.list : ui.id("day-panel-list");
    if (origin === "calendar") {
      ui.byTest("calendar-tab").fire("click"); await until(() => ui.id("cal-grid").children.some(n => n.classList.contains("is-today")));
      assert.equal(ui.id("cal-grid").children.find(n => n.classList.contains("is-today"))?.dataset.date, "2026-11-25");
      ui.byTest("cal-month-input").value = "2026-11"; ui.byTest("cal-month-input").fire("change");
      await until(() => ui.id("cal-grid").children.some(n => n.dataset.date === "2026-11-21"));
      ui.id("cal-grid").children.find(n => n.dataset.date === "2026-11-21")!.fire("click");
      await until(() => !!source.querySelector('[data-testid="edit-button"]'));
    }
    const control = () => source.querySelector('[data-testid="edit-button"]')!;
    const main = ui.id("main-content");
    main.scrollTop = 320; window.scrollTo(0, 460);
    control().focus(); control().fire("click");
    await until(() => ui.id("view-reading").visible);
    main.scrollTop = 75; window.scrollTo(0, 84);
    ui.byTest("reading-edit").fire("click");
    await until(() => ui.id("view-editor").visible);
    assert.match(ui.byTest("back-to-drafts").textContent, /返回阅读/);
    const body = ui.byTest("editor-body"); body.value = "合成校对更新"; body.fire("input");
    ui.byTest("commit-button").fire("click");
    await until(() => ui.id("view-reading").visible);
    assert.match(ui.byTest("reading-content").visibleText(), /合成校对更新/);
    assert.equal(main.scrollTop, 75); assert.equal(window.scrollY, 84);
    ui.byTest("reading-back").fire("click");
    await until(() => source.visibleText().includes("合成校对更新") && ui.active() === control());
    assert.equal(main.scrollTop, 320); assert.equal(window.scrollY, 460);
    assert.equal(ui.byTest(origin + "-tab").getAttribute("aria-current"), "page");
    assert.deepEqual(ui.id("active-conditions").children.map(n => n.dataset.condition), ["month", "favorite"]);
    if (origin === "calendar") assert.match(ui.id("day-panel-date").textContent, /11月21日/);
  });
}

test("timeline paging appends stable entries; tab changes preserve deep timeline and calendar offsets", async t => {
  const ui = setup(t, "");
  const api = new MemoryAdapter({ storage: ui.storage, storageKey: PREVIEW_STORAGE_KEY, search: "" });
  for (let i = 0; i < 53; i++) {
    const { row } = await api.createDraft({ body: "合成分页 " + i, eventDate: "2026-10-03" });
    await api.commitRecord(row.recordId, 0);
  }
  await ui.load(); await ui.ready();
  assert.equal(ui.records().length, 50);
  const first = ui.records()[0];
  ui.intersect(ui.id("timeline-sentinel"));
  await until(() => ui.records().length === 53);
  assert.equal(ui.records()[0], first); assert.equal(ui.list.querySelectorAll("h2").length, 1);
  const main = ui.id("main-content");
  main.scrollTop = 530; window.scrollTo(0, 604);
  ui.byTest("calendar-tab").fire("click"); await until(() => ui.id("view-calendar").visible);
  main.scrollTop = 95; window.scrollTo(0, 123);
  ui.byTest("timeline-tab").fire("click"); await until(() => ui.list.visible && ui.records().length === 53);
  assert.equal(main.scrollTop, 530); assert.equal(window.scrollY, 604);
  ui.byTest("calendar-tab").fire("click"); await until(() => ui.id("view-calendar").visible);
  assert.equal(main.scrollTop, 95); assert.equal(window.scrollY, 123);
});

test("timeline search opens the real M05 formal query and large type uses a relative 200% root", async t => {
  const ui = setup(t);
  await ui.load(); await ui.ready();
  ui.byTest("timeline-search").fire("click");
  await until(() => ui.id("view-search").visible);
  const input = ui.byTest("search-input"); input.value = "薄荷"; input.fire("input");
  ui.byTest("search-form").fire("submit");
  await until(() => ui.byTest("search-list").querySelectorAll('[data-testid="search-item"]').length === 1);
  assert.match(ui.byTest("search-list").visibleText(), /薄荷/);
  ui.byTest("mine-tab").fire("click"); await until(() => ui.id("view-mine").visible);
  ui.byTest("appearance-link").fire("click"); await until(() => ui.id("view-appearance").visible);
  ui.byTest("font-scale").value = "2"; ui.byTest("font-scale").fire("change");
  assert.equal(document.documentElement.style.fontSize, "200%");
});

test("fixtures require explicit browser opt-in, repeat exactly, and the empty library has zero records, tags, or media", async t => {
  for (const q of ["", "demo=1", "stage01=sample", "theme=dark&lock=enabled&panel=open"]) {
    assert.equal(mobilePreview(new URLSearchParams(q), false), null);
  }
  assert.equal(mobilePreview(new URLSearchParams("stage01=timeline"), true), null);
  const model = (name: string) => mobilePreview(new URLSearchParams("stage01=" + name), false)!;
  const a = model("timeline"), b = model("timeline");
  await a.prepare(); await b.prepare();
  assert.deepEqual(await a.adapter.listFormalRecords(), await b.adapter.listFormalRecords());
  const empty = model("empty"); await empty.prepare();
  assert.deepEqual(await empty.adapter.listFormalRecords(), []);
  assert.deepEqual(await empty.adapter.listDrafts(), []);
  assert.deepEqual(await empty.adapter.listTags(), []);
  assert.equal((await empty.adapter.museumHomeSummary()).photoCount, 0);
  const ui = setup(t, "?stage01=empty&theme=dark");
  const keys = [PREVIEW_STORAGE_KEY, "shiguang.theme", "shiguang.fontScale", "shiguang.lastTab", "shiguang.lastDraft"];
  for (const key of keys) ui.storage.setItem(key, "synthetic sentinel");
  await ui.load(); await ui.ready();
  assert.equal(ui.records().length, 0); assert.equal(ui.list.querySelector("img"), null);
  assert.equal(ui.list.querySelector("time"), null); assert.equal(ui.byTest("write-first").visible, true);
  ui.byTest("write-first").fire("click"); await until(() => ui.id("view-editor").visible);
  for (const key of keys) assert.equal(ui.storage.getItem(key), "synthetic sentinel", key);
});

for (const lock of ["enabled", "slow", "error"]) {
  test(`isolated ${lock} startup keeps the populated fixture covered until the real preview verifier accepts 0042`, async t => {
    const ui = setup(t, `?stage01=timeline&theme=dark&panel=open&lock=${lock}`);
    const reads = t.mock.method(MemoryAdapter.prototype, "timelinePage");
    let release: (() => void) | undefined;
    if (lock === "slow") {
      // Hold only the explicitly selected fixture's latency; normal application timers still run.
      const original = globalThis.setTimeout;
      t.mock.method(globalThis, "setTimeout", (fn: () => void, ms: number) => {
        if (ms === 2400) { release = fn; return; }
        return original(fn, ms);
      });
    }
    await ui.load();
    const shell = ui.id("app-shell"), gate = ui.byTest("app-lock-screen"), pass = ui.byTest("app-passcode");
    if (lock === "slow") {
      await until(() => !!release);
      assert.equal(gate.visibleText(), "拾光"); assert.equal(shell.inert, true); assert.equal(pass.visible, false);
      release!();
    } else if (lock === "error") {
      await until(() => ui.byTest("startup-retry").visible);
      assert.equal(shell.visible, false); assert.equal(pass.visible, false);
      assert.equal(reads.mock.callCount(), 0); ui.byTest("startup-retry").fire("click");
    }
    await until(() => pass.visible);
    assert.equal(shell.visible, false); assert.equal(shell.inert, true);
    assert.equal(ui.sheet.open, false); assert.equal(reads.mock.callCount(), 0);
    pass.value = "1234"; ui.byTest("unlock-form").fire("submit");
    await until(() => ui.byTest("unlock-feedback").textContent.includes("不正确"));
    assert.equal(reads.mock.callCount(), 0);
    pass.value = "0042"; ui.byTest("unlock-form").fire("submit");
    await ui.ready();
    assert.equal(ui.records().length, 5); assert.equal(ui.sheet.open, true);
    ui.byTest("filters-close").focus();
    ui.setHidden(true);
    assert.equal(shell.visible, false); assert.equal(ui.sheet.open, false);
    assert.equal(gate.visibleText(), "拾光");
    ui.setHidden(false);
    await until(() => shell.visible);
    assert.equal(ui.active(), ui.opener);
  });
}

test("browser Back from an edited draft returns to formal reading, then to the same dated entry", async t => {
  const ui = setup(t);
  await ui.load(); await ui.ready();
  assert.equal(ui.history.scrollRestoration, "manual");
  const card = ui.records()[1], read = card.querySelector('[data-testid="edit-button"]')!;
  read.focus(); window.scrollTo(0, 378); read.fire("click");
  await until(() => ui.id("view-reading").visible);
  const formal = ui.byTest("reading-content").visibleText();
  ui.byTest("reading-edit").fire("click"); await until(() => ui.id("view-editor").visible);
  ui.byTest("editor-body").value = "只保留在草稿中的校对"; ui.byTest("editor-body").fire("input");
  ui.history.back();
  await until(() => ui.id("view-reading").visible);
  assert.equal(ui.byTest("reading-content").visibleText(), formal);
  ui.history.back();
  await until(() => ui.id("view-timeline").visible && ui.active() === read);
  assert.equal(window.scrollY, 378);
  assert.equal(ui.records()[1], card);
});

test("a formal edit reached through M05 returns to reading and restores the live matching result, keyword and focus", async t => {
  const ui = setup(t);
  await ui.load(); await ui.ready();
  ui.byTest("timeline-search").fire("click"); await until(() => ui.id("view-search").visible);
  const input = ui.byTest("search-input");
  input.value = "薄荷"; input.fire("input"); ui.byTest("search-form").fire("submit");
  const results = ui.byTest("search-list");
  await until(() => results.children.length === 1);
  const id = results.children[0].dataset.recordId;
  const read = () => ui.byTest("search-read-" + id);
  read().focus(); window.scrollTo(0, 178); read().fire("click");
  await until(() => ui.id("view-reading").visible);
  ui.byTest("reading-edit").fire("click"); await until(() => ui.id("view-editor").visible);
  ui.byTest("editor-body").value = "薄荷色样复核"; ui.byTest("editor-body").fire("input");
  ui.byTest("commit-button").fire("click"); await until(() => ui.id("view-reading").visible);
  assert.match(ui.byTest("reading-content").visibleText(), /薄荷色样复核/);
  ui.byTest("reading-back").fire("click"); await until(() => results.visibleText().includes("色样复核"));
  assert.equal(input.value, "薄荷"); assert.equal(results.children.length, 1);
  assert.equal(window.scrollY, 178); assert.equal(ui.active(), read());
});
