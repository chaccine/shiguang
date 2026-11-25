import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SearchUi } from "../src/ui/search.ts";
import { appendHighlight, hitExcerpts, projectionHasHit, renderSearchCard } from "../src/ui/search-card.ts";
import { searchAwareApi } from "../src/ui/search-source.ts";
import { initialTab, NAV_TABS, rememberableTab, visibleTabs } from "../src/domain/navigation.ts";
import type { SearchPage, TagInfo } from "../src/domain/types.ts";
import { dated, device, draftOnly, ids, photos, pick, record, syntheticRows, trash } from "./support/museum.ts";
import { manualTimers, searchDom, SearchNode, settled } from "./support/search-dom.ts";

function setup(rows = dated(["2024-02-29", "2024-03-01", "2023-01-01"]), observe = false) {
  const dom = searchDom(), { api, saved } = device(rows), timers = manualTimers();
  const opened: string[] = [];
  let active = true, managed = 0, changed = 0;
  const ui: SearchUi = new SearchUi(dom.root as unknown as HTMLElement, observe ? searchAwareApi(api, () => ui.invalidate()) : api, {
    active: () => active,
    read: async id => { opened.push(id); active = false; ui.leave(); },
    manageTags: () => { managed++; },
    changed: () => { changed++; },
    photo: item => {
      if (!item.cover) return null;
      const image = new SearchNode("img"); image.alt = item.cover.caption; image.loading = "lazy";
      return image as unknown as HTMLElement;
    },
  }, timers);
  const resultIds = () => dom.byTest("search-list").querySelectorAll("article").map(node => node.dataset.recordId);
  const input = (id: string, value: string) => { const node = dom.byTest(id); node.value = value; node.fire("input"); };
  return { ...dom, api, saved, ui, timers, opened, resultIds, input,
    activate: () => { active = true; }, managed: () => managed, changed: () => changed,
    finish: () => { ui.leave(); dom.restore(); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("M05 independent search route adds no mobile tab and retains favorites/tag routes", () => {
  assert.equal(initialTab({ param: "search" }), "search");
  assert.equal(rememberableTab("search"), null);
  assert.deepEqual(NAV_TABS.map(tab => tab.label), ["时光轴", "日历", "＋记录", "博物馆", "我的"]);
  assert.equal(visibleTabs("search", { formalCount: 0, draftCount: 0 }).length, 5);
  assert.equal(initialTab({ param: "favorites" }), "collect");
  assert.equal(initialTab({ param: "tags" }), "collect");
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/ui/main.ts", import.meta.url), "utf8");
  assert.match(html, /id="view-search"/);
  for (const id of ["timeline-search", "museum-search", "sidebar-search"]) assert.ok(html.includes(`data-testid="${id}"`), id);
  assert.match(main, /readingOrigin === "search"/);
  assert.match(main, /search\.resume\(\)/);
  const commitHandler = main.slice(main.indexOf("async function commitCurrent()"), main.indexOf("async function resolveKeepMine()"));
  assert.match(commitHandler, /if \(readingId && readingOrigin === "search"\) await openReading\(readingId, true\)/,
    "Formal edits opened through search must return to reading with the search origin intact");
});

test("M05 empty and mixed states contain only active formal records, including museum-hidden", async () => {
  const env = setup([]);
  try {
    await env.ui.enter();
    assert.deepEqual(env.resultIds(), []);
    assert.match(env.root.text(), /没有找到相符的时光/);
    assert.doesNotMatch(env.root.text(), /落后|签到|什么都没做/);
    assert.equal(env.byTest("search-status").getAttribute("role"), "status");
    env.byTest("search-manage-tags").fire("click"); assert.equal(env.managed(), 1);
  } finally { env.finish(); }
  const rows = syntheticRows(4); rows[0].museumHidden = true; rows[0].formal!.title = "";
  draftOnly(rows[1]); trash(rows[2]); photos(rows[3], 1); rows[3].formal!.body = ""; rows[3].formal!.title = "";
  const mixed = setup(rows);
  try {
    await mixed.ui.enter();
    assert.deepEqual(mixed.resultIds().sort(), [rows[0].recordId, rows[3].recordId].sort());
    assert.equal(mixed.byTest("search-list").querySelectorAll("h3").length, 0, "No fabricated title for untitled records");
    assert.equal(mixed.byTest("search-list").querySelector("img")?.loading, "lazy");
  } finally { mixed.finish(); }
});

test("M05 tag OR and cross-dimension AND use inclusive event dates and M02 ordering", async () => {
  const rows = dated(["2024-02-29", "2024-02-29", "2024-03-01", "2024-02-29", "2024-02-29", "2024-02-29"]);
  rows.forEach(row => { row.formal!.body = "出发 NEEDLE"; row.favorite = true; photos(row, 1); });
  rows[3].favorite = false; rows[4].formal!.photos = []; rows[4].formal!.coverPhotoUseId = null; rows[5].formal!.body = "不匹配";
  const env = setup(rows);
  try {
    const travel = await env.api.createTag("旅行"), campus = await env.api.createTag("校园");
    await env.api.setRecordTags(rows[0].recordId, [travel.tagId]);
    await env.api.setRecordTags(rows[1].recordId, [campus.tagId]);
    for (const row of rows.slice(2)) await env.api.setRecordTags(row.recordId, [travel.tagId, campus.tagId]);
    await env.ui.enter();
    assert.match(env.root.text(), /任一/); assert.match(env.root.text(), /同时/);
    env.input("search-input", "  needle  ");
    env.input("search-from", "2024-02-29"); env.input("search-to", "2024-02-29");
    env.byTest("search-favorite").checked = true; env.byTest("search-favorite").fire("change");
    env.byTest("search-photos").value = "with"; env.byTest("search-photos").fire("change");
    env.byTest(`search-tag-${travel.tagId}`).fire("click");
    env.byTest(`search-tag-${campus.tagId}`).fire("click");
    await env.ui.submit();
    const expected = await env.api.searchPage({ keyword: "needle", tagIds: [travel.tagId, campus.tagId], from: "2024-02-29", to: "2024-02-29", favoriteOnly: true, hasPhoto: true }, null, 24);
    assert.deepEqual(env.resultIds(), ids(expected.items)); assert.equal(env.resultIds().length, 2);
    for (const chip of ["keyword", "from", "to", "favorite", "photos", `tag-${travel.tagId}`, `tag-${campus.tagId}`]) assert.ok(env.byTest(`search-chip-${chip}`));
    env.byTest("search-order").value = "asc"; env.byTest("search-order").fire("change"); await env.ui.submit();
    assert.deepEqual(env.resultIds(), ids((await env.api.searchPage({ keyword: "needle", tagIds: [travel.tagId, campus.tagId], from: "2024-02-29", to: "2024-02-29", favoriteOnly: true, hasPhoto: true, order: "asc" }, null, 24)).items));
    env.byTest(`search-chip-tag-${campus.tagId}`).fire("click"); await env.ui.submit(); assert.deepEqual(env.resultIds(), [rows[0].recordId]);
    env.byTest("search-chip-photos").fire("click"); await env.ui.submit(); assert.ok(env.resultIds().includes(rows[4].recordId));
    env.byTest("search-clear").fire("click"); await env.ui.submit(); assert.equal(env.resultIds().length, 6);
  } finally { env.finish(); }
});

test("M05 without-photo filter and no-match reset are real query results", async () => {
  const rows = syntheticRows(3); photos(rows[1], 1); const env = setup(rows);
  try {
    await env.ui.enter(); env.byTest("search-photos").value = "without"; env.byTest("search-photos").fire("change"); await env.ui.submit();
    assert.deepEqual(env.resultIds().sort(), [rows[0].recordId, rows[2].recordId].sort());
    env.input("search-input", "没有这个连续词语"); await env.ui.submit(); assert.deepEqual(env.resultIds(), []);
    assert.match(env.root.text(), /没有找到相符的时光/); assert.ok(env.byTest("search-clear"));
    env.byTest("search-chip-keyword").fire("click"); await env.ui.submit(); assert.equal(env.resultIds().length, 2);
    env.byTest("search-clear").fire("click"); await env.ui.submit(); assert.equal(env.resultIds().length, 3);
  } finally { env.finish(); }
});

test("M05 IME composition never searches partial input, debounce is cancellable and submit is explicit", async () => {
  const env = setup();
  try {
    await env.ui.enter(); const original = env.api.searchPage.bind(env.api), queries: string[] = [];
    env.api.searchPage = async (filter, ...rest) => { queries.push(filter.keyword ?? ""); return original(filter, ...rest); };
    const input = env.byTest("search-input"); input.fire("compositionstart");
    env.input("search-input", "he"); env.timers.flush(); await env.ui.submit();
    assert.deepEqual(queries, []); assert.deepEqual(env.resultIds(), [], "Old response invalidated while composing");
    input.value = "合成"; input.fire("compositionend");
    assert.deepEqual(env.timers.pending(), [450]);
    env.input("search-input", "合成正文"); assert.deepEqual(env.timers.pending(), [450]);
    env.timers.flush(); await settled(() => queries.length === 1);
    assert.deepEqual(queries, ["合成正文"]);
    env.input("search-input", "合成"); env.byTest("search-form").fire("submit");
    await settled(() => queries.length === 2); assert.deepEqual(env.timers.pending(), []);
    assert.equal(queries[1], "合成");
  } finally { env.finish(); }
});

test("M05 new input invalidates an in-flight IPC result before the next debounce dispatch", async () => {
  const rows = dated(["2024-02-29", "2024-03-01"]); rows[0].formal!.title = "old"; rows[1].formal!.title = "new";
  const env = setup(rows);
  try {
    await env.ui.enter(); const original = env.api.searchPage.bind(env.api), old = deferred<SearchPage>();
    const oldPage = await original({ keyword: "old" }, null, 24);
    env.api.searchPage = (filter, ...rest) => filter.keyword === "old" ? old.promise : original(filter, ...rest);
    env.input("search-input", "old"); const pending = env.ui.submit();
    await new Promise(resolve => setTimeout(resolve, 0));
    env.input("search-input", "new"); old.resolve(oldPage); await pending;
    assert.deepEqual(env.resultIds(), [], "Stale old IPC result cannot be shown during debounce");
    assert.equal(env.byTest("search-input").value, "new");
    await env.ui.submit(); assert.deepEqual(env.resultIds(), [rows[1].recordId]);
  } finally { env.finish(); }
});

test("M05 reversed response delivery and a late failure cannot overwrite current results/status", async () => {
  const rows = dated(["2024-02-29", "2024-03-01"]); rows[0].formal!.title = "old"; rows[1].formal!.title = "new";
  const env = setup(rows);
  try {
    await env.ui.enter(); const original = env.api.searchPage.bind(env.api), first = deferred<SearchPage>(), failure = deferred<SearchPage>();
    const oldPage = await original({ keyword: "old" }, null, 24);
    env.api.searchPage = (filter, ...rest) => filter.keyword === "old" ? first.promise : filter.keyword === "failure" ? failure.promise : original(filter, ...rest);
    env.input("search-input", "old"); const a = env.ui.submit(); await new Promise(resolve => setTimeout(resolve, 0));
    env.input("search-input", "new"); await env.ui.submit(); first.resolve(oldPage); await a;
    assert.deepEqual(env.resultIds(), [rows[1].recordId]);
    env.input("search-input", "failure"); const b = env.ui.submit(); await new Promise(resolve => setTimeout(resolve, 0));
    env.input("search-input", "new"); await env.ui.submit(); failure.reject({ code: "DISK_FULL" }); await b;
    assert.deepEqual(env.resultIds(), [rows[1].recordId]); assert.equal(env.byTest("search-error").hidden, true);
  } finally { env.finish(); }
});

test("M05 source-stale cursor discards accumulated pages and restarts at the first page", async () => {
  const rows = dated(Array<string>(60).fill("2024-02-29")); const env = setup(rows);
  try {
    await env.ui.enter(); await env.ui.more(); assert.equal(env.resultIds().length, 48);
    const removed = env.resultIds()[0]; await env.api.trashRecord(removed);
    const original = env.api.searchPage.bind(env.api), cursors: Array<string | null> = [];
    env.api.searchPage = (filter, cursor, ...rest) => { cursors.push(cursor); return original(filter, cursor, ...rest); };
    await env.ui.more();
    assert.equal(env.resultIds().length, 24); assert.ok(!env.resultIds().includes(removed));
    assert.ok(cursors[0]); assert.equal(cursors.at(-1), null);
    assert.equal(new Set(env.resultIds()).size, 24);
    assert.match(env.byTest("search-status").text(), /更新|重新/);
  } finally { env.finish(); }
});

test("M05 invalid/mismatched cursor recovers once without infinite automatic retry", async () => {
  for (const code of ["SEARCH_CURSOR_MISMATCH", "INVALID_CURSOR"]) {
    const env = setup(dated(Array<string>(30).fill("2024-02-29")));
    try {
      await env.ui.enter(); const original = env.api.searchPage.bind(env.api); let calls = 0;
      env.api.searchPage = async (filter, cursor, ...rest) => { calls++; if (cursor) throw { code }; return original(filter, cursor, ...rest); };
      await env.ui.more(); assert.equal(calls, 2); assert.equal(env.resultIds().length, 24);
      env.api.searchPage = async () => { calls++; throw { code }; };
      const before = calls; await env.ui.more(); assert.ok(calls - before <= 2);
      assert.equal(env.byTest("search-error").hidden, false);
    } finally { env.finish(); }
  }
});

test("M05 invalid dates and backend errors expose actionable accessible retry states", async () => {
  const env = setup();
  try {
    await env.ui.enter(); const original = env.api.searchPage.bind(env.api); let calls = 0;
    env.api.searchPage = (filter, ...rest) => { calls++; return original(filter, ...rest); };
    env.input("search-from", "2023-02-29"); await env.ui.submit(); assert.equal(calls, 0);
    assert.equal(env.byTest("search-error").getAttribute("role"), "alert");
    assert.match(env.byTest("search-error").text(), /日期/); assert.equal(env.byTest("search-from").getAttribute("aria-invalid"), "true");
    env.input("search-from", "2024-03-01"); env.input("search-to", "2024-02-29"); await env.ui.submit(); assert.equal(calls, 0);
    env.input("search-from", "2024-02-29"); await env.ui.submit(); assert.equal(env.resultIds().length, 1);
    assert.notEqual(env.byTest("search-from").getAttribute("aria-invalid"), "true");
    env.byTest("search-from").value = ""; env.byTest("search-from").validity.badInput = true;
    const validCalls = calls; await env.ui.submit(); assert.equal(calls, validCalls); assert.equal(env.byTest("search-error").hidden, false);
    env.byTest("search-from").validity.badInput = false; env.input("search-from", "2024-02-29");
    env.api.failNext("DISK_FULL", "searchPage"); await env.ui.submit();
    assert.equal(env.byTest("search-error").hidden, false); assert.match(env.root.text(), /重试|查找/);
    await env.ui.submit(); assert.equal(env.byTest("search-error").hidden, true); assert.equal(env.resultIds().length, 1);
  } finally { env.finish(); }
});

test("M05 literal highlight builds text/mark nodes for script, regexp metacharacters and ASCII case", () => {
  const env = searchDom();
  try {
    for (const literal of ['<script>alert("x")</script>', '<img src=x onerror=alert(1)>', "[a-z]+", ".*", "^$", "\\d", "(a|b)", "%_", "🚂"]) {
      const holder = new SearchNode("p"), text = `前文 ${literal} 后文 ${literal}`;
      appendHighlight(holder as unknown as HTMLElement, text, literal);
      assert.equal(holder.text(), text, literal);
      assert.deepEqual(holder.querySelectorAll("mark").map(node => node.text()), [literal, literal]);
      assert.equal(holder.querySelectorAll("script").length, 0); assert.equal(holder.querySelectorAll("img").length, 0);
      assert.ok(holder.children.every(node => node.nodeType === 3 || node.tagName === "mark"));
    }
    const mixed = new SearchNode("p"); appendHighlight(mixed as unknown as HTMLElement, "Needle nEeDlE CAFÉ café", " needle ");
    assert.deepEqual(mixed.querySelectorAll("mark").map(node => node.text()), ["Needle", "nEeDlE"]);
    const noMatch = new SearchNode("p"); appendHighlight(noMatch as unknown as HTMLElement, "literal abc", "a.c"); assert.equal(noMatch.querySelectorAll("mark").length, 0);
  } finally { env.restore(); }
});

test("M05 excerpts locate formal body, non-cover caption, location and current tags without draft leaks", async () => {
  const rows = syntheticRows(1), row = rows[0]; row.formal!.title = "";
  row.formal!.body = "很长的开头".repeat(100) + " 正文Needle 的末尾";
  row.formal!.location = "Needle车站"; photos(row, 2); row.formal!.photos[0].caption = "第一张Needle说明"; row.formal!.photos[1].caption = "封面没有关键词";
  row.draft = { ...row.formal!, body: "草稿秘密", location: "草稿秘密" };
  row.tagIds = ["tag-a"];
  const tags = [{ tagId: "tag-a", name: "Needle校园", normName: "needle校园", createdAt: "2024-01-01T00:00:00Z", formalCount: 1, draftCount: 0 }] as unknown as TagInfo[];
  const excerpts = hitExcerpts(row, tags, "needle");
  assert.deepEqual(excerpts.map(hit => hit.label), ["正文", "图片说明 · 第 1 张", "地点", "标签"]);
  assert.ok(excerpts.every(hit => hit.text.includes("Needle")));
  assert.ok(excerpts[0].text.length < row.formal!.body.length); assert.doesNotMatch(excerpts.map(hit => hit.text).join(""), /草稿秘密/);
  assert.deepEqual(hitExcerpts(row, tags, "草稿秘密"), []);
  row.tagIds = [];
  const env = setup(rows);
  try {
    const tag = await env.api.createTag("Needle校园"); await env.api.setRecordTags(row.recordId, [tag.tagId]);
    await env.ui.enter(); env.input("search-input", "needle"); await env.ui.submit();
    await settled(() => env.byTest("search-list").text().includes("Needle车站"));
    assert.equal(env.byTest("search-list").querySelectorAll("h3").length, 0);
  } finally { env.finish(); }
});

test("M05 late excerpt hydration cannot replace a newer query's card", async () => {
  const rows = dated(["2024-02-29", "2024-03-01"]);
  rows[0].formal!.body = "普通开头。".repeat(80) + "旧关键词"; rows[0].formal!.title = ""; rows[1].formal!.title = "新关键词";
  const env = setup(rows);
  try {
    await env.ui.enter(); const original = env.api.getRecord.bind(env.api), old = deferred<Awaited<ReturnType<typeof original>>>(); let reads = 0;
    const oldRow = await original(rows[0].recordId);
    env.api.getRecord = id => { if (id === rows[0].recordId) { reads++; return old.promise; } return original(id); };
    env.input("search-input", "旧关键词"); await env.ui.submit(); await settled(() => reads === 1);
    env.input("search-input", "新关键词"); await env.ui.submit(); old.resolve(oldRow);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(env.resultIds(), [rows[1].recordId]); assert.doesNotMatch(env.byTest("search-list").text(), /旧关键词/);
  } finally { env.finish(); }
});

test("M05 late-body-only and non-cover-caption-only hits hydrate useful literal summaries", async () => {
  const rows = dated(["2024-02-29", "2024-03-01"]);
  rows[0].formal!.body = "没有命中的开头。".repeat(80) + "尾部专属关键词"; rows[0].formal!.title = "";
  photos(rows[1], 2); rows[1].formal!.photos[0].caption = "非封面专属关键词"; rows[1].formal!.photos[1].caption = "普通封面";
  const env = setup(rows);
  try {
    await env.ui.enter(); env.input("search-input", "尾部专属"); await env.ui.submit();
    await settled(() => env.byTest("search-list").text().includes("尾部专属关键词"));
    assert.equal(env.byTest("search-list").querySelectorAll("mark").length > 0, true);
    env.input("search-input", "非封面专属"); await env.ui.submit();
    await settled(() => env.byTest("search-list").text().includes("非封面专属关键词"));
    assert.match(env.byTest("search-list").text(), /图片说明/);
  } finally { env.finish(); }
});

test("M05 load-more stays bounded and reading/back preserves conditions, loaded results, scroll and focus", async () => {
  const rows = dated(Array<string>(65).fill("2024-02-29")); rows.forEach(row => { row.favorite = true; });
  const env = setup(rows);
  try {
    await env.ui.enter(); assert.equal(env.resultIds().length, 24);
    env.input("search-input", "合成"); env.byTest("search-favorite").checked = true; env.byTest("search-favorite").fire("change");
    env.byTest("search-order").value = "asc"; env.byTest("search-order").fire("change"); await env.ui.submit();
    env.byTest("search-more").fire("click"); await settled(() => env.resultIds().length === 48);
    const loaded = env.resultIds(), read = env.byTest(`search-read-${loaded[30]}`);
    env.main.scrollTop = 1340; env.win.scrollY = 82; read.focus(); read.fire("click"); await settled(() => env.opened.length === 1);
    env.main.scrollTop = 0; env.win.scrollY = 0; env.activate(); await env.ui.resume();
    assert.equal(env.byTest("search-input").value, "合成"); assert.equal(env.byTest("search-order").value, "asc"); assert.equal(env.byTest("search-favorite").checked, true);
    assert.deepEqual(env.resultIds(), loaded); assert.equal(env.main.scrollTop, 1340); assert.equal(env.win.scrollY, 82);
    assert.equal(env.active()?.dataset.testid, read.dataset.testid);
    await env.ui.more(); assert.equal(env.resultIds().length, 65); assert.equal(new Set(env.resultIds()).size, 65);
    const more = env.find("search-more"); assert.ok(!more || more.hidden || more.disabled);
  } finally { env.finish(); }
});

test("M05 reading edit commit refreshes membership while keeping search context and loaded depth", async () => {
  const rows = dated(Array<string>(60).fill("2024-02-29")); const env = setup(rows);
  try {
    await env.ui.enter(); env.input("search-input", "合成"); await env.ui.submit(); await env.ui.more();
    const id = env.resultIds()[10]; env.main.scrollTop = 610; env.byTest(`search-read-${id}`).fire("click"); await settled(() => env.opened.length === 1);
    await env.api.saveDraft({ recordId: id, title: "已修改", body: "正式内容改成不匹配" }); await env.api.commitRecord(id, 1);
    env.activate(); await env.ui.resume();
    assert.equal(env.byTest("search-input").value, "合成"); assert.ok(!env.resultIds().includes(id)); assert.equal(env.resultIds().length, 48); assert.equal(env.main.scrollTop, 610);
  } finally { env.finish(); }
});

test("M05 favorite control uses durable formal metadata, preserves draft and links museum favorites", async () => {
  const env = setup([]);
  try {
    const id = await record(env.api); await env.api.saveDraft({ recordId: id, title: "不公开草稿", body: "不公开正文", eventDate: "2030-01-01" });
    const before = await env.api.getRecord(id); await env.ui.enter();
    env.api.failNext("DISK_FULL", "setFavorite"); env.byTest(`search-favorite-${id}`).fire("click");
    await settled(() => !env.byTest("search-error").hidden); assert.equal((await env.api.getRecord(id)).favorite, false);
    env.byTest(`search-favorite-${id}`).fire("click"); await settled(() => env.byTest(`search-favorite-${id}`).getAttribute("aria-pressed") === "true");
    const after = await env.api.getRecord(id); assert.equal(after.favorite, true); assert.deepEqual(after.formal, before.formal); assert.deepEqual(after.draft, before.draft); assert.equal(after.contentRevision, before.contentRevision);
    assert.deepEqual(ids((await env.api.museumFavoritesPage(null, 24)).items), [id]);
    assert.doesNotMatch(env.byTest("search-list").text(), /不公开/);
    env.byTest("search-favorite").checked = true; env.byTest("search-favorite").fire("change"); await env.ui.submit();
    env.byTest(`search-favorite-${id}`).fire("click"); await settled(() => env.resultIds().length === 0);
    assert.equal((await env.api.museumFavoritesPage(null, 24)).total, 0); assert.ok((await env.api.getRecord(id)).draft);
  } finally { env.finish(); }
});

test("M05 tag rename/merge/delete and re-entry refresh current dictionary without creating records", async () => {
  const env = setup([]);
  try {
    const id = await record(env.api), first = await env.api.createTag("旧标签"), second = await env.api.createTag("目的标签");
    await env.api.setRecordTags(id, [first.tagId]); await env.ui.enter();
    env.input("search-input", "旧标签"); await env.ui.submit(); assert.deepEqual(env.resultIds(), [id]);
    await env.api.renameTag(first.tagId, "新标签"); env.ui.invalidate(); await env.ui.submit();
    assert.match(env.byTest(`search-tag-${first.tagId}`).text(), /新标签/); assert.deepEqual(env.resultIds(), []);
    env.input("search-input", "新标签"); await env.ui.submit(); assert.deepEqual(env.resultIds(), [id]);
    await env.api.mergeTags(first.tagId, second.tagId); env.ui.leave(); env.activate(); await env.ui.enter();
    assert.equal(env.find(`search-tag-${first.tagId}`), null); assert.ok(env.byTest(`search-tag-${second.tagId}`)); assert.deepEqual(env.resultIds(), []);
    env.input("search-input", "目的标签"); await env.ui.submit(); assert.deepEqual(env.resultIds(), [id]);
    await env.api.deleteTag(second.tagId); env.ui.invalidate(); await env.ui.submit(); assert.deepEqual(env.resultIds(), []);
    assert.equal(env.find(`search-tag-${second.tagId}`), null); assert.equal((await env.api.listFormalRecords()).length, 1);
  } finally { env.finish(); }
});

test("M05 deleting a selected tag keeps a removable condition instead of silently broadening", async () => {
  const env = setup([]);
  try {
    const id = await record(env.api); await record(env.api); const tag = await env.api.createTag("待移除标签");
    await env.api.setRecordTags(id, [tag.tagId]); await env.ui.enter();
    env.byTest(`search-tag-${tag.tagId}`).fire("click"); await env.ui.submit(); assert.deepEqual(env.resultIds(), [id]);
    await env.api.deleteTag(tag.tagId); env.ui.invalidate(); await env.ui.submit();
    assert.deepEqual(env.resultIds(), []); assert.equal(env.find(`search-tag-${tag.tagId}`), null);
    assert.match(env.byTest(`search-chip-tag-${tag.tagId}`).text(), /已移除/);
    env.byTest(`search-chip-tag-${tag.tagId}`).fire("click"); await env.ui.submit(); assert.equal(env.resultIds().length, 2);
  } finally { env.finish(); }
});

test("M05 re-entry observes trash, restore, backup overwrite and merge from authority", async () => {
  const env = setup([]);
  try {
    const id = await record(env.api); await env.ui.enter(); assert.deepEqual(env.resultIds(), [id]);
    env.ui.leave(); await env.api.trashRecord(id); await env.ui.enter(); assert.deepEqual(env.resultIds(), []);
    env.ui.leave(); await env.api.restoreRecord(id); await env.ui.enter(); assert.deepEqual(env.resultIds(), [id]);
    const source = device(), imported = await record(source.api); await source.api.saveDraft({ recordId: imported, body: "导入正式关键词" }); await source.api.commitRecord(imported, 1);
    await source.api.exportBackup(); const pkg = source.api.lastExportedPackage()!;
    env.ui.leave(); await env.api.restoreBackup(await pick(env.api, pkg)); await env.ui.enter();
    env.input("search-input", "导入正式关键词"); await env.ui.submit(); assert.equal(env.resultIds().length, 1);
    const added = await record(source.api); await source.api.saveDraft({ recordId: added, body: "合并专属正文" }); await source.api.commitRecord(added, 1); await source.api.exportBackup();
    env.ui.leave(); await env.api.mergeBackup(await pick(env.api, source.api.lastExportedPackage()!)); await env.ui.enter();
    env.input("search-input", "合并专属正文"); await env.ui.submit(); assert.equal(env.resultIds().length, 1);
  } finally { env.finish(); }
});

test("M05 mutation observer refreshes only successful authority writes and never publishes drafts", async () => {
  const { api } = device(); let changes = 0;
  const observed = searchAwareApi(api, () => { changes++; });
  const id = (await observed.createDraft({ body: "正式正文", eventDate: "2024-02-29" })).row.recordId;
  await observed.saveDraft({ recordId: id, title: "待提交" }); assert.equal(changes, 0);
  await observed.commitRecord(id, 0); assert.equal(changes, 1);
  await observed.saveDraft({ recordId: id, body: "绝不公开的草稿" }); assert.equal(changes, 1);
  const a = await observed.createTag("来源"), b = await observed.createTag("目的"); assert.equal(changes, 3);
  await observed.renameTag(a.tagId, "改名"); await observed.setRecordTags(id, [a.tagId]); assert.equal(changes, 5);
  await observed.mergeTags(a.tagId, b.tagId); await observed.deleteTag(b.tagId); assert.equal(changes, 7);
  api.failNext("DISK_FULL", "setFavorite"); await assert.rejects(observed.setFavorite(id, true)); assert.equal(changes, 7);
  await observed.setFavorite(id, true); assert.equal(changes, 8);
  assert.equal((await observed.getRecord(id)).formal!.body, "正式正文"); assert.equal((await observed.getRecord(id)).draft!.body, "绝不公开的草稿");
  await observed.trashRecord(id); await observed.restoreRecord(id); assert.equal(changes, 10);
  await observed.exportBackup(); const pkg = api.lastExportedPackage()!;
  await observed.searchPage({}, null, 24); await observed.listTags(); assert.equal(changes, 10);
  await observed.trashRecord(id); await observed.purgeRecord(id); assert.equal(changes, 12);
  await observed.restoreBackup(await pick(api, pkg)); assert.equal(changes, 13);
  await observed.emptyTrash(); assert.equal(changes, 14);
  await observed.mergeBackup(await pick(api, pkg)); assert.equal(changes, 15);
});

test("M05 returning to unchanged cached results resumes interrupted hit hydration", async () => {
  const rows = dated(["2024-02-29"]); rows[0].formal!.title = ""; rows[0].formal!.body = "无命中开头。".repeat(80) + "待加载的片段";
  const env = setup(rows);
  try {
    await env.ui.enter(); const original = env.api.getRecord.bind(env.api), deferredRow = deferred<Awaited<ReturnType<typeof original>>>();
    const row = await original(rows[0].recordId); let reads = 0;
    env.api.getRecord = id => { reads++; return reads === 1 ? deferredRow.promise : original(id); };
    env.input("search-input", "待加载的片段"); await env.ui.submit(); await settled(() => reads === 1);
    const read = env.byTest(`search-read-${rows[0].recordId}`); read.focus(); read.fire("click"); await settled(() => env.opened.length === 1);
    deferredRow.resolve(row); env.activate(); await env.ui.resume();
    await settled(() => env.byTest("search-list").text().includes("正文：待加载的片段") || env.byTest("search-list").querySelectorAll("mark").some(mark => mark.text().includes("待加载的片段")));
    assert.ok(reads >= 2); assert.equal(env.find(`search-hit-${row.recordId}`), null);
  } finally { env.finish(); }
});

test("M05 interrupted multi-page refresh never reuses an unrendered staged first page", async () => {
  const rows = dated(Array<string>(60).fill("2024-02-29")); const env = setup(rows);
  try {
    await env.ui.enter(); await env.ui.more(); const original = env.api.searchPage.bind(env.api);
    await env.api.setFavorite(rows[0].recordId, true);
    const held = deferred<SearchPage>(); let cursorReads = 0;
    env.api.searchPage = (filter, cursor, ...rest) => { if (cursor) { cursorReads++; return held.promise; } return original(filter, cursor, ...rest); };
    const refreshing = env.ui.resume(); await settled(() => cursorReads === 1); env.ui.leave();
    env.api.searchPage = original; await env.ui.resume();
    assert.equal(env.resultIds().length, 48, "Cached result reuse must require a fully rendered matching result set");
    const first = await original({}, null, 24); held.resolve(await original({}, first.nextCursor, 24)); await refreshing;
    assert.equal(env.resultIds().length, 48);
  } finally { env.finish(); }
});

test("M05 tag query completion and durable favorite refresh retain connected keyboard focus", async () => {
  const env = setup([], true);
  try {
    const id = await record(env.api), tag = await env.api.createTag("键盘标签"); await env.api.setRecordTags(id, [tag.tagId]); await env.ui.enter();
    const select = env.byTest(`search-tag-${tag.tagId}`); select.focus(); select.fire("click"); await env.ui.submit();
    assert.equal(env.active()?.dataset.testid, `search-tag-${tag.tagId}`); assert.equal(env.active()?.isConnected, true);
    const favorite = env.byTest(`search-favorite-${id}`); favorite.focus(); favorite.fire("click");
    await settled(() => env.find(`search-favorite-${id}`)?.getAttribute("aria-pressed") === "true");
    assert.equal(env.active()?.dataset.testid, `search-favorite-${id}`); assert.equal(env.active()?.isConnected, true);
    env.byTest("search-favorite").checked = true; env.byTest("search-favorite").fire("change"); await env.ui.submit();
    const remove = env.byTest(`search-favorite-${id}`); remove.focus(); remove.fire("click"); await settled(() => env.resultIds().length === 0 && !env.byTest("search-more").disabled);
    assert.equal(env.active()?.isConnected, true, "Removing a focused filtered card must move focus to a surviving control");
  } finally { env.finish(); }
});

test("M05 long literal hits remain visibly marked in bounded excerpts; no cross-tag invented hit", async () => {
  const env = searchDom();
  try {
    const rows = dated(["2024-02-29"]), row = rows[0], literal = "很长的逐字短语".repeat(55);
    row.formal!.title = ""; row.formal!.body = "前文。".repeat(70) + literal + "后文";
    const { api } = device(rows), item = (await api.searchPage({ keyword: literal }, null, 24)).items[0];
    const card = renderSearchCard(item, row, [], literal, { read() {}, favorite() {}, photo: () => null }) as unknown as SearchNode;
    const hit = card.querySelector(".search-hit")!; assert.ok(hit.text().length < 260); assert.ok(hit.querySelector("mark")!.text().length > 0);
    assert.ok(literal.includes(hit.querySelector("mark")!.text()));
    const tags = [{ tagId: "a", name: "x · x" }, { tagId: "b", name: "x · x" }] as TagInfo[];
    const projected = { ...item, tagIds: ["a", "b"], title: "", excerpt: "ordinary", location: "", cover: null };
    assert.equal(projectionHasHit(projected, tags, "x · x · x"), false);
    row.tagIds = ["a", "b"]; assert.deepEqual(hitExcerpts(row, tags, "x · x · x"), []);
  } finally { env.restore(); }
});

test("M05 whitespace-normalized body and generated ellipsis never get highlighted as literal hits", async () => {
  const env = searchDom();
  try {
    const rows = dated(["2024-02-29"]); rows[0].formal!.title = "A B"; rows[0].formal!.body = "A\nB";
    const { api } = device(rows), item = (await api.searchPage({ keyword: "A B" }, null, 24)).items[0];
    assert.equal(item.excerpt, "A B");
    const card = renderSearchCard(item, null, [], "A B", { read() {}, favorite() {}, photo: () => null }) as unknown as SearchNode;
    assert.equal(card.querySelector("h3")!.querySelectorAll("mark").length, 1);
    assert.equal(card.querySelector(".card-excerpt")!.querySelectorAll("mark").length, 0, "M02's flattened whitespace is not a body hit");
    assert.equal(projectionHasHit({ ...item, title: "", excerpt: "A…" }, [], "…"), false);
  } finally { env.restore(); }
});

test("M05 hydrated record changed after the page read restarts instead of combining stale projection and fresh body", async () => {
  const rows = dated(["2024-02-29"]); rows[0].formal!.title = ""; rows[0].formal!.body = "普通开头。".repeat(80) + "原来命中的词";
  const env = setup(rows);
  try {
    await env.ui.enter(); const original = env.api.getRecord.bind(env.api), delayed = deferred<Awaited<ReturnType<typeof original>>>(); let requested = false;
    env.api.getRecord = () => { requested = true; return delayed.promise; };
    env.input("search-input", "原来命中的词"); await env.ui.submit(); await settled(() => requested);
    await env.api.saveDraft({ recordId: rows[0].recordId, body: "新的正式内容，不再包含该词" }); await env.api.commitRecord(rows[0].recordId, 1);
    delayed.resolve(await original(rows[0].recordId)); await settled(() => env.timers.pending().length > 0);
    assert.deepEqual(env.resultIds(), []); assert.doesNotMatch(env.byTest("search-list").text(), /新的正式内容/);
    env.timers.flush(); await settled(() => !!env.find("search-empty")); assert.deepEqual(env.resultIds(), []);
  } finally { env.finish(); }
});

test("M05 favorite feedback preserves uncertain and unsupported-sync durability without publishing draft", async () => {
  const env = setup([], true);
  try {
    const id = await record(env.api);
    await env.api.saveDraft({ recordId: id, body: "未提交草稿仍然私有", eventDate: "2030-01-01" });
    const before = await env.api.getRecord(id); await env.ui.enter();
    for (const [mode, expected, favorite] of [
      ["uncertain", "珍藏状态已保存，但系统未确认写入磁盘。", true],
      ["parentSyncUnsupported", "珍藏状态已保存（系统未提供目录同步确认）。", false],
    ] as const) {
      env.api.durabilityMode = mode;
      env.byTest(`search-favorite-${id}`).fire("click");
      await settled(() => env.byTest("search-status").text().includes(expected));
      assert.equal(env.byTest("search-status").getAttribute("role"), "status");
      assert.equal(env.byTest("search-status").getAttribute("aria-live"), "polite");
      assert.doesNotMatch(env.byTest("search-status").text(), /已安全保存|珍藏状态已保存。/);
      assert.equal(env.byTest(`search-favorite-${id}`).getAttribute("aria-pressed"), String(favorite));
      const after = await env.api.getRecord(id);
      assert.equal(after.favorite, favorite); assert.deepEqual(after.formal, before.formal);
      assert.deepEqual(after.draft, before.draft); assert.equal(after.contentRevision, before.contentRevision);
    }
  } finally { env.finish(); }
});
