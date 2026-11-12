import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { MuseumUi, photoAlt } from "../src/ui/museum.ts";
import { dated, device, draftOnly, photos, record, syntheticRows, TODAY, trash } from "./support/museum.ts";
import { museumDom, settled } from "./support/museum-dom.ts";

function setup(rows = dated(["2024-11-12", "2023-11-12", "2022-04-02"])) {
  const env = museumDom(), { api } = device(rows), opened: string[] = [], errors: unknown[] = [];
  let active = true;
  const ui = new MuseumUi(env.root as unknown as HTMLElement, api, {
    read: async id => { opened.push(id); active = false; }, write: () => { opened.push("write"); }, active: () => active, error: error => errors.push(error),
  }, () => TODAY);
  const click = async (id: string, expected: string) => { env.byTest(id).fire("click"); await settled(() => !!env.content.querySelector(`[data-testid="${expected}"]`)); assert.deepEqual(errors, []); };
  return { ...env, api, ui, opened, errors, click, activate: () => { active = true; } };
}

test("M04 home has four real area entries and previews; no draft, trashed or F07 entry", async () => {
  const rows = dated(["2024-11-12", "2023-11-12", "2022-04-02", "2020-01-01", "2019-01-01"]);
  rows[0].favorite = true; photos(rows[0], 2); draftOnly(rows[3]); trash(rows[4]);
  rows[3].draft!.title = "绝不能出展的草稿";
  const env = setup(rows);
  try {
    await env.ui.enter(); assert.match(env.content.text(), /2 年前的今天/);
    assert.doesNotMatch(env.content.text(), /绝不能出展的草稿|手工主题展|建设中/);
    for (const [area, name] of [["reunion", "今日重逢"], ["favorites", "珍藏展柜"], ["photos", "照片展墙"], ["years", "年度展室"]]) {
      assert.ok(env.byTest(`museum-enter-${area}`)); assert.match(env.content.text(), new RegExp(name));
    }
    await env.click("museum-enter-reunion", "museum-reunion");
    assert.deepEqual(env.content.querySelectorAll("h2").map(n => n.textContent), ["2 年前的今天", "3 年前的今天"]);
    await env.click("museum-back", "museum-home");
    await env.click("museum-enter-favorites", "museum-favorites");
    assert.equal(env.byTest("museum-list").children.length, 1);
    env.byTest("museum-order").fire("click"); await settled(() => env.byTest("museum-order").textContent.includes("从远到近"));
    await env.click("museum-back", "museum-home"); await env.click("museum-enter-photos", "museum-photos");
    assert.equal(env.byTest("museum-list").children.length, 2);
    assert.equal(env.byTest("museum-list").getAttribute("role"), "group");
    await env.click("museum-back", "museum-home"); await env.click("museum-enter-years", "museum-years");
    assert.equal(env.content.querySelectorAll(".museum-year-card").length, 3);
    const chart = env.content.querySelector(".museum-months")!;
    assert.equal(chart.children.length, 12); assert.equal(chart.children[10].getAttribute("aria-label"), "11 月：1 条记录");
    assert.equal(chart.children[10].children[0].textContent, "1");
    await env.click("museum-year-2024", "museum-year"); assert.match(env.content.text(), /精选|全部记录/);
    assert.deepEqual(env.errors, []);
  } finally { env.restore(); }
});

test("M04 new-user and draft-only empty states offer gentle, working record guidance in all areas", async () => {
  const rows = dated(["2024-11-12"]); draftOnly(rows[0]); const env = setup(rows);
  try {
    await env.ui.enter(); assert.ok(env.byTest("museum-empty")); assert.equal(env.byTest("museum-reshuffle").disabled, true);
    env.byTest("museum-write").fire("click"); assert.deepEqual(env.opened, ["write"]);
    for (const area of ["reunion", "favorites", "photos", "years"]) {
      await env.click(`museum-enter-${area}`, `museum-${area}`); assert.ok(env.byTest("museum-empty"));
      assert.doesNotMatch(env.content.text(), /什么都没做|落后|签到/); await env.click("museum-back", "museum-home");
    }
  } finally { env.restore(); }
});

test("M04 lists and photo wall page incrementally through IntersectionObserver without duplicates", async () => {
  const rows = dated(Array<string>(65).fill("2024-11-12")); rows.forEach(r => { r.favorite = true; photos(r, 1); });
  const env = setup(rows);
  try {
    for (const area of ["favorites", "photos", "reunion"]) {
      await env.ui.enter(); await env.click(`museum-enter-${area}`, `museum-${area}`);
      const count = () => area === "photos" ? env.byTest("museum-list").children.length : env.byTest("museum-list").querySelectorAll("article").length;
      assert.equal(count(), 24); env.observers.at(-1)!.intersect(); await settled(() => count() === 48);
      env.byTest("museum-more").fire("click"); await settled(() => count() === 65);
      assert.equal(env.content.querySelector('[data-testid="museum-more"]'), null);
      const nodes = area === "photos" ? env.byTest("museum-list").children : env.byTest("museum-list").querySelectorAll("article");
      assert.equal(new Set(nodes.map(n => area === "photos" ? n.dataset.testid : n.dataset.recordId)).size, 65);
    }
  } finally { env.restore(); }
});

test("M04 photo viewer preserves per-use caption/context, arrows, Escape and focus return", async () => {
  const env = setup([]);
  try {
    const id = await record(env.api, "2024-11-12", 2);
    await env.api.saveDraft({ recordId: id, title: "未提交故事标题", body: "未提交正文" });
    await env.ui.enter(); await env.click("museum-enter-photos", "museum-photos");
    const grid = env.byTest("museum-list"), [first, second] = grid.children;
    const image = first.querySelector("img")!; assert.equal(image.loading, "lazy"); assert.equal(image.alt, "合成说明 0\n<&>");
    first.focus(); first.fire("keydown", { key: "ArrowRight" }); assert.equal(env.active(), second);
    assert.equal(second.tabIndex, 0); assert.equal(first.tabIndex, -1);
    second.fire("keydown", { key: "Home" }); assert.equal(env.active(), first);
    first.fire("click"); await settled(() => env.byTest("museum-viewer").open);
    const viewer = env.byTest("museum-viewer"); assert.equal(viewer.getAttribute("aria-modal"), "true"); assert.equal(viewer.getAttribute("aria-label"), "照片查看");
    assert.match(viewer.text(), /合成说明 0\n<&>/); assert.doesNotMatch(viewer.text(), /未提交故事标题|未提交正文/);
    viewer.fire("keydown", { key: "ArrowRight" }); await settled(() => viewer.text().includes("合成说明 1"));
    assert.equal(env.active()?.dataset.testid, "museum-viewer-close");
    viewer.fire("keydown", { key: "ArrowLeft" }); await settled(() => viewer.text().includes("合成说明 0"));
    viewer.fire("keydown", { key: "Escape" }); assert.equal(viewer.open, false); assert.equal(env.active(), first);
    first.fire("click"); await settled(() => viewer.open); env.byTest("museum-viewer-story").fire("click");
    await settled(() => env.opened.length === 1); assert.equal(viewer.open, false); assert.deepEqual(env.opened, [id]);
    assert.ok((await env.api.getRecord(id)).draft); assert.equal((await env.api.getRecord(id)).formal!.body, "合成正式正文");
  } finally { env.restore(); }
});

test("M04 photo wall uses fallback alt for untitled uses and preserves HEIC failure context", async () => {
  const env = setup([]);
  try {
    const id = await record(env.api, "2024-11-12", 1); const draft = (await env.api.createDraft({ baseRecordId: id })).row.draft!;
    await env.api.setDraftPhotoCaption(id, draft.photos[0].photoUseId, ""); await env.api.commitRecord(id, 1);
    const tile = (await env.api.museumPhotosPage(null, 24)).items[0];
    assert.equal(photoAlt(tile), "照片 1，来自无标题记录");
    assert.equal(photoAlt({ ...tile, title: "标题" }), "照片 1，来自《标题》");
    await env.ui.enter(); env.api.photoThumbUrl = async () => { throw { code: "HEIC_UNSUPPORTED" }; };
    await env.click("museum-enter-photos", "museum-photos"); await settled(() => env.content.text().includes("无法预览 HEIC 图片"));
    env.byTest("museum-list").children[0].fire("click"); await settled(() => env.byTest("museum-viewer").open);
    assert.ok(env.byTest("museum-viewer-story"));
  } finally { env.restore(); }
});

test("M04 reading and nested year back restore area, order, loaded pages, scroll and focus", async () => {
  const rows = dated(Array<string>(60).fill("2024-11-12")); rows.forEach(r => { r.favorite = true; });
  const env = setup(rows);
  try {
    await env.ui.enter(); await env.click("museum-enter-favorites", "museum-favorites");
    env.byTest("museum-more").fire("click"); await settled(() => env.byTest("museum-list").children.length === 48);
    const read = env.byTest("museum-list").children[30].querySelector("button")!;
    env.main.scrollTop = 1370; env.win.scrollY = 84; read.focus(); read.fire("click"); await settled(() => env.opened.length > 0);
    env.main.scrollTop = 0; env.win.scrollY = 0; env.activate(); await env.ui.resume();
    assert.equal(env.main.scrollTop, 1370); assert.equal(env.win.scrollY, 84); assert.equal(env.byTest("museum-list").children.length, 48);
    assert.equal(env.active()?.dataset.testid, read.dataset.testid);
    await env.ui.enter(); await env.click("museum-enter-years", "museum-years");
    env.main.scrollTop = 210; const year = env.byTest("museum-year-2024"); year.focus();
    await env.click("museum-year-2024", "museum-year"); await env.click("museum-back", "museum-years");
    assert.equal(env.main.scrollTop, 210); assert.equal(env.active()?.dataset.testid, "museum-year-2024");
  } finally { env.restore(); }
});

test("M04 hide, undo, failure and reset keep originals and active-browsing areas available", async () => {
  const rows = dated(["2024-11-12", "2023-11-12"]); rows[0].favorite = true; const env = setup(rows);
  try {
    const original = (await env.api.getRecord(rows[0].recordId)).formal;
    await env.ui.enter(); await env.click("museum-enter-reunion", "museum-reunion");
    env.api.failNext("DISK_FULL", "setMuseumHidden"); env.byTest(`museum-hide-${rows[0].recordId}`).fire("click");
    await settled(() => env.errors.length === 1); assert.equal((await env.api.getRecord(rows[0].recordId)).museumHidden, false);
    assert.equal(env.feedback.hidden, true); env.errors.length = 0;
    env.byTest(`museum-hide-${rows[0].recordId}`).fire("click"); await settled(() => !env.undo.hidden);
    assert.equal((await env.api.getRecord(rows[0].recordId)).museumHidden, true);
    assert.equal(env.content.querySelector(`[data-testid="museum-read-${rows[0].recordId}"]`), null);
    env.undo.fire("click"); await settled(() => env.undo.hidden);
    assert.ok(env.byTest(`museum-read-${rows[0].recordId}`));
    env.byTest(`museum-hide-${rows[0].recordId}`).fire("click"); await settled(() => !env.undo.hidden);
    await env.click("museum-back", "museum-home"); await env.click("museum-enter-favorites", "museum-favorites");
    assert.ok(env.byTest(`museum-read-${rows[0].recordId}`));
    await env.api.resetMuseumHidden(); await env.ui.enter(); await env.click("museum-enter-reunion", "museum-reunion");
    assert.ok(env.byTest(`museum-read-${rows[0].recordId}`));
    assert.deepEqual((await env.api.getRecord(rows[0].recordId)).formal, original);
  } finally { env.restore(); }
});

test("M04 reshuffle prefers unseen records and resume reflects changed formal projections", async () => {
  const rows = dated(Array<string>(8).fill("2024-01-01")); const env = setup(rows);
  try {
    await env.ui.enter();
    const selected = () => env.content.querySelector(".museum-recommendation")!.querySelectorAll("article").map(n => n.dataset.recordId);
    const before = selected(); env.byTest("museum-reshuffle").fire("click");
    await settled(() => selected().some(id => !before.includes(id)));
    assert.ok(selected().every(id => !before.includes(id)));
    const id = selected()[0]; await env.api.trashRecord(id); await env.ui.resume();
    assert.ok(!selected().includes(id)); assert.deepEqual(env.errors, []);
  } finally { env.restore(); }
});

test("M04 MemoryAdapter-driven home renders 5000 synthetic formal records within 1000ms and bounded DOM/media work", async () => {
  const rows = syntheticRows(5000); rows.forEach((r, i) => { r.favorite = i % 3 === 0; photos(r, 1); });
  const env = setup(rows);
  try {
    let thumbs = 0; const original = env.api.photoThumbUrl.bind(env.api);
    env.api.photoThumbUrl = async id => { thumbs++; return original(id); };
    const start = performance.now(); await env.ui.enter(); const elapsed = performance.now() - start;
    assert.ok(elapsed < 1000, `museum home render: ${elapsed.toFixed(1)}ms ≥ 1000ms`);
    assert.ok(env.content.querySelectorAll("article").length <= 5); assert.ok(thumbs <= 8, `${thumbs} thumbnail requests`);
    assert.equal(env.content.querySelectorAll("img").length <= 8, true);
    console.log(`M04 5000-record home render: ${elapsed.toFixed(1)}ms, ${thumbs} bounded thumbnail requests (no layout/decoding)`);
  } finally { env.restore(); }
});
