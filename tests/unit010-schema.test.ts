import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryAdapter, migrateToV5 } from "../src/platform/memory-adapter.ts";
import type { PreviewBackup } from "../src/platform/memory-adapter.ts";
import { createTauriApi } from "../src/platform/tauri-adapter.ts";
import { sha256 } from "../src/platform/bytes.ts";
import { MOODS } from "../src/domain/types.ts";
import type { Mood, Snapshot } from "../src/domain/types.ts";
import { DraftSession } from "../src/domain/draft-session.ts";

const key = "u010-synthetic";
const code = (wanted: string) => (e: unknown) => { assert.equal((e as { code: string }).code, wanted); return true; };
function storage() { const data = new Map<string,string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string,v: string) => { data.set(k,v); } }; }
function device() { const saved = storage(); return { saved, api: new MemoryAdapter({ storage: saved, storageKey: key, search: "" }) }; }
async function seeded(api: MemoryAdapter) {
  const id = (await api.createDraft({ body: "合成正文", eventDate: "2026-11-09" })).row.recordId;
  for (const n of [1,2,3]) await api.attachPhotoBytes({ recordId: id, fileName: "s.png", bytes: [137,80,78,71,n], caption: `合成说明${n}` });
  await api.commitRecord(id,0); return id;
}
async function pick(api: MemoryAdapter, pkg: PreviewBackup) {
  api.setNextPickedPackage(pkg); const picked = await api.pickBackup(); assert.equal(picked.cancelled,false);
  if (picked.cancelled) throw new Error("missing synthetic package"); return picked.token;
}

test("U010 v3 frozen content migrates defaults and preserves caption/order, draft slots and metadata", () => {
  // Rust state and browser-preview storage have different media envelopes. Consume
  // the frozen record snapshots directly; Rust tests verify real .sgbak bytes.
  const original = JSON.parse(readFileSync(new URL("../core/tests/fixtures/v3/state.json",import.meta.url),"utf8"));
  const incoming = { ...structuredClone(original), assets: {}, quarantine: {} };
  const migrated = migrateToV5(incoming);
  assert.equal(migrated.schemaVersion,5); assert.deepEqual(migrated.settings,{ theme: "system", appLock: null });
  for (let i=0;i<migrated.records.length;i++) {
    const row = migrated.records[i]!;
    for (const slot of ["formal","draft"] as const) {
      const snap = row[slot]; if (!snap) continue;
      assert.equal(snap.location,""); assert.equal(snap.mood,null);
      assert.equal(snap.coverPhotoUseId,snap.photos[0]?.photoUseId ?? null);
      const { location: _l, mood: _m, coverPhotoUseId: _c, ...old } = snap;
      assert.deepEqual(old,original.records[i][slot]);
    }
    assert.equal(row.favorite,original.records[i].favorite); assert.deepEqual(row.tagIds,original.records[i].tagIds);
  }
  const conflict: Snapshot = structuredClone(migrated.records[0]!.formal!);
  const legacy = { ...structuredClone(migrated), schemaVersion: 3, conflictCopies: [{ conflictId: "conflict-000099", recordId: migrated.records[0]!.recordId, snapshot: conflict, baseRevision: 1, reason: "synthetic", createdAt: "synthetic" }] };
  assert.equal(migrateToV5(legacy).conflictCopies[0]!.snapshot.coverPhotoUseId,conflict.photos[0]!.photoUseId);
});

test("U010 all content fields stay in draft until commit, discard leaves formal unchanged", async () => {
  const { api, saved } = device(), id = await seeded(api), original = (await api.getRecord(id)).formal!;
  const [a,b,c] = original.photos;
  await api.setDraftPhotoCaption(id,a!.photoUseId,"<script>纯文本</script>\n新说明");
  await api.setDraftCover(id,b!.photoUseId);
  await api.reorderDraftPhotos(id,[c!.photoUseId,b!.photoUseId,a!.photoUseId]);
  await api.saveDraft({ recordId: id, location: "合成地点 <&>\n😀", mood: "感动" });
  const row = await api.getRecord(id), draft = structuredClone(row.draft!);
  assert.deepEqual(row.formal,original); assert.equal(row.baseRevision,1);
  assert.equal((await api.timelinePage({},null,50)).items[0]!.cover!.photoUseId,a!.photoUseId);
  await api.discardDraft(id); assert.deepEqual((await api.getRecord(id)).formal,original);
  await api.setDraftPhotoCaption(id,a!.photoUseId,draft.photos[2]!.caption);
  await api.setDraftCover(id,b!.photoUseId); await api.reorderDraftPhotos(id,[c!.photoUseId,b!.photoUseId,a!.photoUseId]);
  await api.saveDraft({ recordId: id, location: draft.location, mood: draft.mood }); await api.commitRecord(id,1);
  assert.deepEqual((await api.getRecord(id)).formal,draft);
  const restarted = new MemoryAdapter({ storage: saved, storageKey: key }); assert.deepEqual((await restarted.getRecord(id)).formal,draft);
  assert.equal((await restarted.timelinePage({},null,50)).items[0]!.cover!.photoUseId,b!.photoUseId);
});

test("U010 cover fallback and reorder preserve selection, caption and originals", async () => {
  const { api } = device(), id=await seeded(api), original=(await api.getRecord(id)).formal!, [a,b,c]=original.photos;
  await api.reorderDraftPhotos(id,[c!.photoUseId,b!.photoUseId,a!.photoUseId]);
  assert.equal((await api.getRecord(id)).draft!.coverPhotoUseId,a!.photoUseId);
  await api.setDraftCover(id,b!.photoUseId); await api.removeDraftPhoto(id,b!.photoUseId);
  assert.equal((await api.getRecord(id)).draft!.coverPhotoUseId,c!.photoUseId);
  await api.removeDraftPhoto(id,c!.photoUseId); await api.removeDraftPhoto(id,a!.photoUseId);
  assert.equal((await api.getRecord(id)).draft!.coverPhotoUseId,null); assert.deepEqual((await api.getRecord(id)).formal,original);
  for (const p of original.photos) assert.match(await api.photoDataUrl(p.assetId),/^data:/);
});

test("U010 invalid cover/order/location/mood writes are atomic, location preserves text and Unicode", async () => {
  const { api,saved }=device(), id=await seeded(api), [a,b,c]=(await api.getRecord(id)).formal!.photos;
  const before=saved.getItem(key);
  for (const order of [[a!.photoUseId], [a!.photoUseId,a!.photoUseId,c!.photoUseId], [a!.photoUseId,b!.photoUseId,"foreign"]]) await assert.rejects(api.reorderDraftPhotos(id,order),code("PHOTO_ORDER_INVALID"));
  await assert.rejects(api.setDraftCover(id,"foreign"),code("COVER_PHOTO_INVALID"));
  await assert.rejects(api.setDraftPhotoCaption(id,"foreign","合成"),code("PHOTO_USE_NOT_FOUND"));
  await assert.rejects(api.saveDraft({ recordId: id, location: "😀".repeat(201) }),code("LOCATION_TOO_LONG"));
  await assert.rejects(api.saveDraft({ recordId: id, mood: "unknown" as Mood }),code("MOOD_INVALID"));
  assert.equal(saved.getItem(key),before);
  await api.saveDraft({ recordId: id, location: "😀".repeat(200) });
  assert.equal((await api.getRecord(id)).draft!.location,"😀".repeat(200));
  const text="<img onerror=synthetic>\n\t\u0000合成地点"; await api.saveDraft({ recordId: id, location: text });
  assert.equal((await api.getRecord(id)).draft!.location,text);
  for (const mood of MOODS) { await api.saveDraft({ recordId: id,mood }); assert.equal((await api.getRecord(id)).draft!.mood,mood); }
  await api.saveDraft({ recordId: id,mood: null }); assert.equal((await api.getRecord(id)).draft!.mood,null);
});

test("U010 v4 preview backup roundtrip preserves formal and pending draft details", async () => {
  const a=device(), b=device(), id=await seeded(a.api), photos=(await a.api.getRecord(id)).formal!.photos;
  await a.api.setDraftCover(id,photos[2]!.photoUseId); await a.api.reorderDraftPhotos(id,photos.map((p)=>p.photoUseId).reverse());
  await a.api.setDraftPhotoCaption(id,photos[0]!.photoUseId,"合成新说明"); await a.api.saveDraft({ recordId: id, location: "合成地点", mood: "想念" });
  await a.api.commitRecord(id,1); await a.api.saveDraft({ recordId: id, location: "待提交地点", mood: "平静" });
  const exp=await a.api.exportBackup(); assert.equal(exp.cancelled,false); if(exp.cancelled) return; assert.equal(exp.summary.schemaVersion,5);
  await b.api.restoreBackup(await pick(b.api,a.api.lastExportedPackage()!)); assert.deepEqual(await b.api.getRecord(id),await a.api.getRecord(id));
});

test("U010 v3 preview backup restores and merges into v4 with default content fields", async () => {
  const a=device(), id=await seeded(a.api); await a.api.exportBackup();
  const body=JSON.parse(a.api.lastExportedPackage()!.body); body.manifest.schemaVersion=3; body.state.schemaVersion=3; delete body.state.settings;
  for (const row of body.state.records) for(const slot of ["formal","draft"]) if(row[slot]) for(const field of ["location","mood","coverPhotoUseId"]) delete row[slot][field];
  const text=JSON.stringify(body), bytes=new TextEncoder().encode(text), pkg: PreviewBackup={magic:"SGBAK-PREVIEW",body:text,bytes:bytes.length,sha256:sha256(bytes)};
  for(const merge of [false,true]) {
    const b=device(),token=await pick(b.api,pkg); if(merge) await b.api.mergeBackup(token); else await b.api.restoreBackup(token);
    assert.deepEqual((await b.api.getRecord(id)).formal,(await a.api.getRecord(id)).formal); assert.equal(JSON.parse(b.saved.getItem(key)!).schemaVersion,5);
  }
});

for (const field of ["caption","cover","order","location","mood"] as const) test(`U010 differing ${field} produces a recoverable merge conflict and repeated import is idempotent`,async()=>{
  const a=device(), b=device(), id=await seeded(a.api); await a.api.exportBackup(); await b.api.restoreBackup(await pick(b.api,a.api.lastExportedPackage()!));
  const old=(await b.api.getRecord(id)).formal!, photos=old.photos;
  if(field==="caption") await a.api.setDraftPhotoCaption(id,photos[0]!.photoUseId,"仅说明不同");
  if(field==="cover") await a.api.setDraftCover(id,photos[1]!.photoUseId);
  if(field==="order") await a.api.reorderDraftPhotos(id,photos.map((p)=>p.photoUseId).reverse());
  if(field==="location") await a.api.saveDraft({recordId:id,location:"仅地点不同"});
  if(field==="mood") await a.api.saveDraft({recordId:id,mood:"难过"});
  // Same revision: local formal wins; incoming survives in a conflict copy.
  const source=JSON.parse(a.saved.getItem(key)!); source.records[0].formal=source.records[0].draft; source.records[0].draft=null; a.saved.setItem(key,JSON.stringify(source));
  await a.api.exportBackup(); const pkg=a.api.lastExportedPackage()!;
  const report=await b.api.mergeBackup(await pick(b.api,pkg)); assert.equal(report.plan.counts.conflicts,1);
  assert.deepEqual((await b.api.getRecord(id)).formal,old); const copies=await b.api.listConflictCopies(); assert.equal(copies.length,1);
  const copy=copies[0]!.snapshot; assert.ok(copy.coverPhotoUseId===null || copy.photos.some((p)=>p.photoUseId===copy.coverPhotoUseId));
  const before=b.saved.getItem(key); await b.api.mergeBackup(await pick(b.api,pkg)); assert.equal(b.saved.getItem(key),before);
});

test("U010 Tauri wires all new content operations and explicit mood clearing",async()=>{
  const calls: unknown[]=[]; const api=createTauriApi(async<T>(command:string,args?:Record<string,unknown>)=>{calls.push([command,args]);return {} as T;});
  await api.saveDraft({recordId:"rec",location:"合成",mood:null}); await api.setDraftPhotoCaption("rec","pu","合成说明"); await api.setDraftCover("rec","pu"); await api.reorderDraftPhotos("rec",["b","a"]);
  assert.deepEqual(calls,[
    ["save_draft",{input:{recordId:"rec",location:"合成",mood:null,clearEventTime:false,clearMood:true}}],
    ["set_draft_photo_caption",{recordId:"rec",photoUseId:"pu",caption:"合成说明"}],
    ["set_draft_cover",{recordId:"rec",photoUseId:"pu"}],["reorder_draft_photos",{recordId:"rec",photoUseIds:["b","a"]}],
  ]);
});

test("U010 DraftSession persists location/mood and keeps automatic cover after attachment",async()=>{
  const api=new MemoryAdapter(), session=new DraftSession({api,schedule:()=>0,cancel:()=>{}});
  session.edit({body:"合成正文",eventDate:"2026-11-09",location:"合成地点",mood:"开心"}); await session.flush();
  await session.attachPhoto({fileName:"s.png",bytes:[137,80,78,71,9],caption:"合成说明"}); await session.commit();
  const formal=(await api.getRecord(session.state.recordId!)).formal!;
  assert.equal(formal.location,"合成地点");assert.equal(formal.mood,"开心");assert.equal(formal.coverPhotoUseId,formal.photos[0]!.photoUseId);
});

test("U010 reordering repeated identical photo uses is still differing content", async () => {
  const source = device(), target = device();
  const id = (await source.api.createDraft({ body: "合成重复图片", eventDate: "2026-11-09" })).row.recordId;
  for (let i = 0; i < 3; i++) await source.api.attachPhotoBytes({ recordId: id, fileName: "same.png", bytes: [137,80,78,71,7], caption: "相同合成说明" });
  await source.api.commitRecord(id, 0);
  const [a, b, c] = (await source.api.getRecord(id)).formal!.photos;
  await source.api.setDraftCover(id, c!.photoUseId); await source.api.commitRecord(id, 1);
  await source.api.exportBackup(); await target.api.restoreBackup(await pick(target.api, source.api.lastExportedPackage()!));
  const old = (await target.api.getRecord(id)).formal!;
  await source.api.reorderDraftPhotos(id, [b!.photoUseId, a!.photoUseId, c!.photoUseId]);
  await source.api.commitRecord(id, 2); await source.api.exportBackup();
  const pkg = source.api.lastExportedPackage()!;
  const result = await target.api.mergeBackup(await pick(target.api, pkg));
  assert.equal(result.plan.counts.updated, 1);
  assert.deepEqual((await target.api.getRecord(id)).formal, (await source.api.getRecord(id)).formal);
  assert.deepEqual((await target.api.listConflictCopies())[0]!.snapshot, old);
  const before = target.saved.getItem(key);
  await target.api.mergeBackup(await pick(target.api, pkg)); assert.equal(target.saved.getItem(key), before);
});

test("U010 collision remapping keeps one photo-use identity and cover across formal/draft/conflicts", async () => {
  const source = device(), target = device();
  const id = await seeded(source.api), ownId = await seeded(target.api);
  // Synthetic separate-device identity, with colliding record and photo-use IDs.
  const raw = JSON.parse(target.saved.getItem(key)!); raw.records[0].createdAt = "synthetic-other-device";
  target.saved.setItem(key, JSON.stringify(raw));
  const photos = (await source.api.getRecord(id)).formal!.photos;
  await source.api.setDraftCover(id, photos[1]!.photoUseId);
  await source.api.resolveConflict(id, "keepFormal");
  await source.api.setDraftCover(id, photos[2]!.photoUseId);
  await source.api.exportBackup(); const pkg = source.api.lastExportedPackage()!;
  assert.equal((await target.api.mergeBackup(await pick(target.api, pkg))).plan.counts.added, 1);
  const imported = (await target.api.listFormalRecords()).find((r) => r.recordId !== ownId)!;
  const formal = imported.formal!, draft = imported.draft!, conflict = (await target.api.listConflictCopies())[0]!.snapshot;
  assert.notEqual(formal.photos[0]!.photoUseId, photos[0]!.photoUseId);
  assert.deepEqual(formal.photos.map((p) => p.photoUseId), draft.photos.map((p) => p.photoUseId));
  assert.deepEqual(formal.photos.map((p) => p.photoUseId), conflict.photos.map((p) => p.photoUseId));
  assert.equal(formal.coverPhotoUseId, formal.photos[0]!.photoUseId);
  assert.equal(draft.coverPhotoUseId, draft.photos[2]!.photoUseId);
  assert.equal(conflict.coverPhotoUseId, conflict.photos[1]!.photoUseId);
  const before = target.saved.getItem(key);
  await target.api.mergeBackup(await pick(target.api, pkg)); assert.equal(target.saved.getItem(key), before);
  // A re-export from a device that remapped IDs still identifies the same uses.
  await target.api.exportBackup();
  const roundtrip = await source.api.mergeBackup(await pick(source.api, target.api.lastExportedPackage()!));
  assert.equal(roundtrip.plan.counts.added, 1); // only the other device's own record
  assert.equal(roundtrip.plan.counts.conflictCopiesAdded, 0);
  assert.deepEqual((await source.api.getRecord(id)).formal!.photos, photos);
  await target.api.trashRecord(imported.recordId); await target.api.purgeRecord(imported.recordId);
  const reimport = await target.api.mergeBackup(await pick(target.api, pkg));
  assert.equal(reimport.plan.counts.added, 0);
  assert.equal(reimport.plan.counts.skippedDeleted, 1);
  await assert.rejects(target.api.getRecord(imported.recordId), code("RECORD_DELETED"));
});
