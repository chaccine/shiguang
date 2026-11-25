import test from "node:test";
import assert from "node:assert/strict";
import { bootDom, until } from "./support/boot-dom.ts";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { PREVIEW_STORAGE_KEY } from "../src/ui/demo.ts";

test("real bootstrap opens timeline, all five navigation actions work, Mine reaches drafts, reading edit preserves formal",async()=>{
  const { id, byTest, findTest, query, body, storage, restore } = bootDom();
  const api=new MemoryAdapter({storage,storageKey:PREVIEW_STORAGE_KEY,search:""});
  const record=(await api.createDraft({body:"合成正式正文",eventDate:"2026-11-11"})).row.recordId;await api.commitRecord(record,0);
  const formal=(await api.getRecord(record)).formal;
  storage.setItem("shiguang.lastTab","settings");
  try {
    await import("../src/ui/main.ts");await until(()=>body.dataset.appReady==="1");
    assert.equal(id("view-timeline").hidden,false);assert.equal(byTest("app-lock-screen").hidden,true);
    const nav=id("nav-tabs");assert.equal(nav.children.length,5);
    assert.deepEqual(nav.children.map(n=>n.dataset.navTab),["timeline","calendar","create","museum","mine"]);
    assert.equal(nav.children.filter(n=>n.getAttribute("aria-current")==="page").length,1);
    assert.equal(byTest("timeline-tab").getAttribute("aria-current"),"page");
    for (const button of nav.children) assert.equal(button.getAttribute("role"),null);
    const create=byTest("create-tab");
    assert.equal(create.getAttribute("aria-label"),"＋记录");
    assert.equal(create.children.map(n=>n.textContent).join("").match(/[＋+]/g)?.length,1);
    byTest("museum-tab").fire("click");await until(()=>!id("view-museum").hidden);
    await until(()=>!!findTest("museum-enter-reunion"));
    byTest("museum-enter-reunion").fire("click");await until(()=>!!findTest("museum-reunion"));
    // Approved M04 replacement: the real app returns from formal reading to its museum area and offset.
    await api.setFavorite(record,true);
    await until(()=>!!byTest("museum-content").querySelector('[data-testid="museum-back"]'));
    byTest("museum-content").querySelector('[data-testid="museum-back"]')!.fire("click");
    await until(()=>!!byTest("museum-content").querySelector('[data-testid="museum-enter-favorites"]'));
    byTest("museum-content").querySelector('[data-testid="museum-enter-favorites"]')!.fire("click");
    await until(()=>!!byTest("museum-content").querySelector(`[data-testid="museum-read-${record}"]`));
    const main=query(".main")!;main.scrollTop=420;
    byTest("museum-content").querySelector(`[data-testid="museum-read-${record}"]`)!.fire("click");
    await until(()=>!id("view-reading").hidden);assert.equal((await api.getRecord(record)).draft,null);
    byTest("reading-back").fire("click");await until(()=>main.scrollTop===420);
    assert.equal(id("view-museum").hidden,false);
    assert.ok(byTest("museum-content").querySelector('[data-testid="museum-favorites"]'));
    byTest("mine-tab").fire("click");await until(()=>!id("view-mine").hidden);
    byTest("drafts-tab").fire("click");await until(()=>!id("view-drafts").hidden);
    byTest("create-tab").fire("click");await until(()=>!id("view-editor").hidden);
    byTest("editor-location").value="合成新地点";byTest("editor-location").fire("input");
    byTest("editor-mood").value="开心";byTest("editor-mood").fire("change");
    byTest("timeline-tab").fire("click");await until(()=>!id("view-timeline").hidden);
    const newDraft=(await api.listDrafts())[0];assert.equal(newDraft.draft!.location,"合成新地点");assert.equal(newDraft.draft!.mood,"开心");
    // A newly rendered card has a real click handler into the read-first view.
    const card=id("timeline-list").querySelector('[data-testid="edit-button"]')!;assert.ok(card);card.fire("click");
    await until(()=>!id("view-reading").hidden);assert.equal((await api.getRecord(record)).draft,null);
    byTest("reading-edit").fire("click");await until(()=>!id("view-editor").hidden);
    byTest("editor-body").value="合成修改草稿";byTest("editor-body").fire("input");
    byTest("back-to-drafts").fire("click");await until(()=>!id("view-reading").hidden);
    assert.deepEqual((await api.getRecord(record)).formal,formal);assert.equal((await api.getRecord(record)).draft!.body,"合成修改草稿");
    byTest("reading-back").fire("click");assert.equal(id("view-timeline").hidden,false);
    byTest("calendar-tab").fire("click");await until(()=>!id("view-calendar").hidden);
    byTest("cal-month-input").value="2026-11";byTest("cal-month-input").fire("change");
    await until(()=>id("cal-grid").children.some(n=>n.dataset.date==="2026-11-11"));
    for (const day of id("cal-grid").children.filter(n=>n.dataset.date)) {
      assert.match(day.getAttribute("aria-label")!,/2026.*11.*时光/);
      assert.equal(day.getAttribute("aria-controls"),"day-panel");
    }
    id("cal-grid").children.find(n=>n.dataset.date==="2026-11-11")!.fire("click");
    await until(()=>!!id("day-panel-list").querySelector('[data-testid="edit-button"]'));
    assert.equal(id("cal-grid").children.find(n=>n.dataset.date==="2026-11-11")!.getAttribute("aria-pressed"),"true");
    const dateText=id("day-panel-date").textContent;
    id("day-panel-list").querySelector('[data-testid="edit-button"]')!.fire("click");
    await until(()=>!id("view-reading").hidden);assert.equal(byTest("calendar-tab").getAttribute("aria-current"),"page");
    byTest("reading-back").fire("click");assert.equal(id("view-calendar").hidden,false);assert.equal(id("day-panel-date").textContent,dateText);
  } finally {restore();}
});
