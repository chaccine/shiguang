import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { DraftSession } from "../src/domain/draft-session.ts";
import { LockLifecycle, storageRows } from "../src/domain/personal.ts";
import { renderReading } from "../src/ui/reading.ts";
import { createTauriApi } from "../src/platform/tauri-adapter.ts";
import { readFileSync } from "node:fs";

// Small DOM fixture for the actual reading renderer, not an HTML string snapshot.
class Element {
  tagName: string; textContent = ""; className = ""; dataset: Record<string,string> = {}; children: Element[] = [];
  constructor(tagName: string) { this.tagName = tagName; }
  append(...nodes: Element[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]): void { this.children = nodes; }
}
const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]);
const sessionFor = (api: MemoryAdapter) => new DraftSession({api, schedule: () => 1, cancel: () => {}});
async function fixture() {
  const api = new MemoryAdapter();
  const id = (await api.createDraft({body:"合成正文",title:"合成标题",eventDate:"2026-11-11",location:"合成公园",mood:"平静"})).row.recordId;
  await api.attachPhotoBytes({recordId:id,fileName:"one.png",bytes:png,caption:"第一张\n说明"});
  await api.attachPhotoBytes({recordId:id,fileName:"two.png",bytes:png,caption:"第二张 <b>纯文本</b>"});
  return {api,id};
}
test("reading renderer uses formal order, literal captions and explicit cover; editing creates draft without publishing", async () => {
  const {api,id}=await fixture(); const draft=(await api.getRecord(id)).draft!;
  await api.setDraftCover(id,draft.photos[1].photoUseId); await api.commitRecord(id,0);
  const formal=structuredClone((await api.getRecord(id)).formal);
  await api.createDraft({baseRecordId:id}); await api.saveDraft({recordId:id,body:"未发布，不得出现在阅读页"});
  const savedDocument=globalThis.document;
  Object.assign(globalThis,{document:{createElement:(tag:string)=>new Element(tag)}});
  try {
    const holder=new Element("article"); const loaded:string[]=[];
    renderReading(holder as unknown as HTMLElement,await api.getRecord(id),()=>"合成标签",(_img,p)=>loaded.push(p.photoUseId));
    const cover=holder.children.find(e=>e.dataset.testid==="reading-cover")!;
    assert.equal(cover.dataset.photoId,draft.photos[1].photoUseId);
    assert.deepEqual(holder.children.filter(e=>e.dataset.testid==="reading-photo").map(e=>e.dataset.photoId),draft.photos.map(p=>p.photoUseId));
    assert.equal(cover.children[1].textContent,"第二张 <b>纯文本</b>");
    assert.equal(holder.children.find(e=>e.className==="reading-body")!.textContent,"合成正文");
    assert.match(holder.children[1].textContent,/合成公园 · 平静/);
    assert.equal(loaded.length,3);
  } finally { Object.assign(globalThis,{document:savedDocument}); }
  assert.deepEqual((await api.getRecord(id)).formal,formal);
});
test("editor session autosaves location/mood, photo captions, cover and order; failures retain photo writes for retry",async()=>{
  const {api,id}=await fixture(); await api.commitRecord(id,0); const formal=(await api.getRecord(id)).formal;
  const row=(await api.createDraft({baseRecordId:id})).row; const session=sessionFor(api); session.open(row);
  session.edit({location:"新地点",mood:"开心"});
  const photos=session.state.snapshot.photos;
  await session.updatePhoto("caption",photos[0].photoUseId,"草稿说明");
  await session.updatePhoto("cover",photos[1].photoUseId);
  await session.updatePhoto("order",photos[0].photoUseId,photos.map(p=>p.photoUseId).reverse());
  const saved=(await api.getRecord(id)).draft!;
  assert.equal(saved.location,"新地点"); assert.equal(saved.mood,"开心"); assert.equal(saved.photos[1].caption,"草稿说明");
  assert.equal(saved.coverPhotoUseId,photos[1].photoUseId); assert.equal(session.state.status,"saved");
  api.failNext("DISK_FULL","setDraftPhotoCaption");
  await assert.rejects(session.updatePhoto("caption",photos[0].photoUseId,"失败后仍保留"));
  assert.equal(session.state.status,"error"); assert.equal(session.state.snapshot.photos[1].caption,"失败后仍保留");
  await session.retry(); assert.equal((await api.getRecord(id)).draft!.photos[1].caption,"失败后仍保留");
  assert.deepEqual((await api.getRecord(id)).formal,formal);
});
test("storage view rows include every category and total; native command agrees with TS contract",async()=>{
  const api=new MemoryAdapter(); const stats=await api.storageStats();
  assert.equal(stats.total,stats.media+stats.previews+stats.backups+stats.data+stats.other);
  assert.equal(stats.available,null);
  assert.deepEqual(storageRows(stats).map(r=>r[0]),["原图 / 媒体","预览缓存 / 缩略图","本机备份文件","数据文件 state.json","其他本机文件","合计"]);
  const calls:string[]=[]; const native=createTauriApi(async <T>(command:string)=>{calls.push(command);return stats as T;});
  assert.deepEqual(await native.storageStats(),stats); assert.deepEqual(calls,["storage_stats"]);
});
test("lock lifecycle starts locked, short resume remains open, repeated hidden signals do not extend timeout",()=>{
  const gate=new LockLifecycle(); assert.equal(gate.locked,true); gate.unlock();
  gate.background(1000); assert.equal(gate.resume(60999),false);
  gate.background(100000); gate.background(159000); assert.equal(gate.resume(160000),true);
  gate.unlock(); gate.lock(); assert.equal(gate.resume(160001),true);
});
test("UI navigation wires drafts under Mine, museum is honest placeholder, reading edit and numeric password controls exist",()=>{
  const html=readFileSync(new URL("../src/ui/index.html",import.meta.url),"utf8");
  const mine=html.slice(html.indexOf('id="view-mine"'),html.indexOf('id="view-storage"'));
  assert.match(mine,/data-testid="drafts-tab" data-go="drafts"/);
  assert.match(html.slice(html.indexOf('id="view-museum"'),html.indexOf('id="view-mine"')),/建设中/);
  for(const id of ["app-passcode","lock-current","lock-new","lock-confirm"]) assert.match(html,new RegExp(`data-testid="${id}" type="password" inputmode="numeric"`));
  assert.match(html,/data-testid="reading-edit">编辑/);
  assert.match(html,/href="\.\/ui\/styles.css"/);
  assert.match(readFileSync(new URL("../src/ui/styles.css",import.meta.url),"utf8"),/safe-area-inset-bottom/);
});
