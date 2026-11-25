import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { PREVIEW_STORAGE_KEY } from "../src/ui/demo.ts";
import { SEARCH_DEMO_LITERAL, SEARCH_DEMO_STORAGE_KEY, searchDemoClock, searchDemoMode, seedSearchDemo } from "../src/ui/search-demo.ts";
import { ids, storage } from "./support/museum.ts";

const TODAY = "2026-11-25";
function device(saved = storage()) {
  return { saved, api: new MemoryAdapter({ storage: saved, storageKey: SEARCH_DEMO_STORAGE_KEY, search: "", now: searchDemoClock() }) };
}

test("U012 demo requires an explicit recognized browser-only query parameter", () => {
  for (const mode of ["mixed", "empty"] as const) {
    assert.equal(searchDemoMode(new URLSearchParams(`searchDemo=${mode}`), false), mode);
    assert.equal(searchDemoMode(new URLSearchParams(`searchDemo=${mode}`), true), null);
    assert.equal(searchDemoMode(new URLSearchParams(`demo=1&searchDemo=${mode}`), false), mode);
  }
  for (const query of ["", "demo=1", "searchDemo", "searchDemo=1", "searchDemo=auto", "searchDemo=Mixed", "searchDemo=EMPTY", "view=search"]) {
    assert.equal(searchDemoMode(new URLSearchParams(query), false), null, query);
    assert.equal(searchDemoMode(new URLSearchParams(query), true), null, query);
  }
  assert.notEqual(SEARCH_DEMO_STORAGE_KEY, PREVIEW_STORAGE_KEY);
});

test("U012 demo is repeatable byte-for-byte and leaves the ordinary preview store intact", async () => {
  const a = device(), b = device();
  const ordinary = new MemoryAdapter({ storage: a.saved, storageKey: PREVIEW_STORAGE_KEY, search: "", now: searchDemoClock() });
  const ordinaryRow = (await ordinary.createDraft({ body: "另一份合成预览的记录", eventDate: "2020-01-01" })).row;
  await ordinary.commitRecord(ordinaryRow.recordId, 0);
  const ordinaryBefore = a.saved.getItem(PREVIEW_STORAGE_KEY);
  const first = await seedSearchDemo(a.api, "mixed"), second = await seedSearchDemo(b.api, "mixed");
  assert.deepEqual(first, second);
  assert.equal(a.saved.getItem(SEARCH_DEMO_STORAGE_KEY), b.saved.getItem(SEARCH_DEMO_STORAGE_KEY));
  assert.equal(a.saved.getItem(PREVIEW_STORAGE_KEY), ordinaryBefore);
  assert.equal(first.formalCount, 32);
  assert.deepEqual(first.tags, { "旅行": "tag-000001", "朋友": "tag-000002", "星河主题": "tag-000003" });
  assert.equal(first.records.title, "rec-000004");
  assert.equal(first.records.caption, "rec-000007");
  assert.equal(first.records.literal, "rec-000013");
  assert.equal((await a.api.listFormalRecords()).length, 32);
  assert.equal((await a.api.listDrafts()).length, 2);
  assert.equal((await a.api.listTrash()).length, 1);
  await a.api.setFavorite(first.records.title, false);
  assert.equal(a.saved.getItem(PREVIEW_STORAGE_KEY), ordinaryBefore);
  const reopened = device(a.saved).api;
  assert.equal((await reopened.getRecord(first.records.title)).favorite, false);
  assert.equal((await reopened.searchPage({}, null, 24, TODAY)).total, 32);
  assert.equal((await ordinary.listFormalRecords()).length, 1);
});

test("U012 demo field fixtures reach title, long body, non-cover caption, location and live tag", async () => {
  const { api } = device(), fixture = await seedSearchDemo(api, "mixed");
  for (const [key, keyword] of [["title", "青苔书签"], ["body", "慢车"], ["caption", "玻璃倒影"], ["location", "海风车站"], ["tag", "星河主题"]]) {
    const result = await api.searchPage({ keyword }, null, 24, TODAY);
    assert.deepEqual(ids(result.items), [fixture.records[key]], keyword);
  }
  const body = (await api.getRecord(fixture.records.body)).formal!;
  assert.equal(body.title, ""); assert.ok(body.body.indexOf("慢车") > 120);
  const photoOnly = (await api.getRecord(fixture.records.caption)).formal!;
  assert.equal(photoOnly.title, ""); assert.equal(photoOnly.body, "");
  assert.equal(photoOnly.photos.length, 2);
  assert.equal(photoOnly.coverPhotoUseId, photoOnly.photos[0].photoUseId);
  assert.ok(photoOnly.photos[1].caption.includes("玻璃倒影"));
  assert.ok(!photoOnly.photos[0].caption.includes("玻璃倒影"));
  for (const keyword of [SEARCH_DEMO_LITERAL, "[a-z]+", ".*", "^$", "\\d", "(x|y)", "%_", "<img src=x onerror=alert(1)>"]) {
    assert.deepEqual(ids((await api.searchPage({ keyword }, null, 24, TODAY)).items), [fixture.records.literal], keyword);
  }
  assert.equal((await api.searchPage({ keyword: "[A-Z]*" }, null, 24, TODAY)).total, 0);
});

test("U012 demo has reproducible OR/AND, inclusive dates, photo counts and bounded pages", async () => {
  const { api } = device(), fixture = await seedSearchDemo(api, "mixed");
  const tagIds = [fixture.tags["旅行"], fixture.tags["朋友"]];
  assert.equal((await api.searchPage({ tagIds }, null, 24, TODAY)).total, 7);
  const filter = { keyword: "旅行", tagIds, from: "2024-02-29", to: "2024-03-03", favoriteOnly: true, hasPhoto: true };
  assert.deepEqual(ids((await api.searchPage(filter, null, 24, TODAY)).items), [fixture.records.caption, fixture.records.title]);
  assert.deepEqual(ids((await api.searchPage({ ...filter, order: "asc" }, null, 24, TODAY)).items), [fixture.records.title, fixture.records.caption]);
  assert.deepEqual(ids((await api.searchPage({ from: "2024-02-29", to: "2024-02-29" }, null, 24, TODAY)).items), [fixture.records.title]);
  assert.equal((await api.searchPage({ hasPhoto: true }, null, 24, TODAY)).total, 9);
  assert.equal((await api.searchPage({ hasPhoto: false }, null, 24, TODAY)).total, 23);
  assert.equal((await api.searchPage({ keyword: "合成" }, null, 24, TODAY)).total, 31);
  assert.equal((await api.searchPage({ keyword: "分页集合" }, null, 24, TODAY)).total, 22);
  const first = await api.searchPage({}, null, 24, TODAY);
  assert.equal(first.items.length, 24); assert.equal(first.total, 32); assert.ok(first.nextCursor);
  const second = await api.searchPage({}, first.nextCursor, 24, TODAY);
  assert.equal(second.items.length, 8); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...ids(first.items), ...ids(second.items)]).size, 32);
});

test("U012 demo preserves hidden searchability and favorite/formal/draft isolation", async () => {
  const { api } = device(), fixture = await seedSearchDemo(api, "mixed");
  const before = await api.getRecord(fixture.records.title);
  assert.ok(before.draft?.body.includes("草稿专属未发布"));
  assert.ok(before.formal?.body.startsWith("这是一条虚构的正式记录"));
  assert.equal((await api.getRecord(fixture.records.hidden)).museumHidden, true);
  assert.deepEqual(ids((await api.searchPage({ keyword: "隐蔽小径" }, null, 24, TODAY)).items), [fixture.records.hidden]);
  for (const keyword of ["草稿专属未发布", "草稿专属地点", "纯草稿线索", "回收站线索"]) {
    assert.equal((await api.searchPage({ keyword }, null, 24, TODAY)).total, 0, keyword);
  }
  await api.setFavorite(fixture.records.title, false);
  assert.ok(!ids((await api.museumFavoritesPage(null, 24, "desc", TODAY)).items).includes(fixture.records.title));
  await api.setFavorite(fixture.records.title, true);
  assert.ok(ids((await api.museumFavoritesPage(null, 24, "desc", TODAY)).items).includes(fixture.records.title));
  const after = await api.getRecord(fixture.records.title);
  assert.deepEqual(after.formal, before.formal); assert.deepEqual(after.draft, before.draft);
  assert.equal(after.contentRevision, before.contentRevision);
});

test("U012 empty demo is genuinely empty and does not write fabricated content", async () => {
  const { api, saved } = device(), writes = saved.writes;
  assert.deepEqual(await seedSearchDemo(api, "empty"), { records: {}, tags: {}, formalCount: 0 });
  assert.equal((await api.searchPage({}, null, 24, TODAY)).total, 0);
  assert.deepEqual(await api.listTags(), []);
  assert.equal(saved.writes, writes);
});

test("U012 demo refuses any existing formal, draft, trash or tag without modifying it", async () => {
  for (const kind of ["formal", "draft", "trash", "tag"]) {
    const { api, saved } = device();
    if (kind === "tag") await api.createTag("已有合成标签");
    else {
      const row = (await api.createDraft({ body: "已有合成内容", eventDate: "2024-01-01" })).row;
      if (kind !== "draft") await api.commitRecord(row.recordId, 0);
      if (kind === "trash") await api.trashRecord(row.recordId);
    }
    const before = saved.getItem(SEARCH_DEMO_STORAGE_KEY), writes = saved.writes;
    for (const mode of ["mixed", "empty"] as const) await assert.rejects(seedSearchDemo(api, mode), /搜索演示只可写入空的独立合成预览库/);
    assert.equal(saved.getItem(SEARCH_DEMO_STORAGE_KEY), before, kind);
    assert.equal(saved.writes, writes, kind);
  }
});
