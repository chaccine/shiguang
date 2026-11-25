import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchPage } from "../src/domain/search.ts";
import { timelinePage } from "../src/domain/timeline.ts";
import type { SearchFilter, TagDef } from "../src/domain/types.ts";
import { createTauriApi } from "../src/platform/tauri-adapter.ts";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { code, device, draftOnly, ids, KEY, photos, pick, record, rid, syntheticRows, TODAY, trash } from "./support/museum.ts";

const tag = (tagId: string, name: string): TagDef => ({ tagId, name, normName: name.toLowerCase(), createdAt: "2026-01-01T00:00:00Z" });

test("U012 each field is literal, trimmed, English-insensitive; no cross-field or image inference", () => {
  const rows = syntheticRows(8), tags = [tag("tag-a", "Needle校园")];
  rows.forEach(r => { r.formal!.title = ""; r.formal!.body = "neutral"; });
  rows[0]!.formal!.title = "Needle标题";
  rows[1]!.formal!.body = "正文Needle";
  photos(rows[2]!, 2); rows[2]!.formal!.body = ""; rows[2]!.formal!.photos[1]!.caption = "Needle说明";
  rows[3]!.formal!.location = "Needle车站"; rows[4]!.tagIds = ["tag-a"];
  rows[5]!.formal!.title = "Needle"; rows[5]!.formal!.body = "Needle"; rows[5]!.tagIds = ["tag-a"];
  rows[6]!.formal!.title = "Nee"; rows[6]!.formal!.body = "dle";
  photos(rows[7]!, 1); rows[7]!.formal!.photos[0]!.assetId = "Needle-image-name";
  const run = (keyword: string) => searchPage(rows,tags,{keyword},null,50,TODAY);
  assert.deepEqual(ids(run(" \uFEFFnEeDlE　\n").items).sort(), [1,2,3,4,5,6].map(rid));
  for (const [query,n] of [["标题",1],["正文nE",2],["说明",3],["车站",4]] as const) assert.deepEqual(ids(run(query).items), [rid(n)]);
  assert.deepEqual(ids(run("校园").items).sort(), [rid(5),rid(6)]);
  assert.equal(run("Needle-image-name").total,0);
  assert.equal(run("没有 OCR").total,0);
  assert.equal(run("").total,8);
});

test("U012 Unicode and regex/script-looking input remain contiguous plain data", () => {
  const rows = syntheticRows(1);
  rows[0]!.formal!.body = '第一次坐火车 café e\u0301 🚂👩‍👩‍👧‍👦 [a-z]+ .* ^$ \\d (x|y) <script>alert("x")</script> %_';
  for (const keyword of ["次坐火", "café", "e\u0301", "🚂", "👩‍👩‍👧‍👦", "[a-z]+", ".*", "^$", "\\d", "(x|y)", '<script>alert("x")</script>', "%_"]) {
    assert.equal(searchPage(rows,[],{keyword},null,50,TODAY).total,1,keyword);
  }
  for (const keyword of ["第一次 火车", "[A-Z]*", "<img onerror=alert(1)>", "CAFÉ", "é 🚂"]) {
    assert.equal(searchPage(rows,[],{keyword},null,50,TODAY).total,0,keyword);
  }
});

test("U012 exhaustive 192 combinations: keyword, OR tags, date, favorite, photo and order", () => {
  const rows = syntheticRows(32), tags = [tag("tag-a","Alpha"),tag("tag-b","Beta")];
  rows.forEach((r,i) => {
    r.formal!.body = i & 1 ? "Needle" : "neutral";
    r.tagIds = i & 2 ? ["tag-a","tag-b"] : i & 4 ? ["tag-b"] : [];
    r.formal!.eventDate = i & 4 ? "2024-02-29" : "2024-03-01";
    r.favorite = !!(i & 8); if (i & 16) photos(r,2);
  });
  let combinations = 0;
  for (const keyword of ["","needle"]) for (const tagIds of [[],["tag-a"],["tag-a","tag-b"],["missing"]])
    for (const range of [false,true]) for (const favoriteOnly of [false,true]) for (const hasPhoto of [null,true,false]) {
      const filter: SearchFilter = { keyword, tagIds, favoriteOnly, hasPhoto, ...(range ? {from:"2024-02-29",to:"2024-02-29"} : {}) };
      const expected = rows.filter((r,i) => (!keyword || !!(i & 1))
        && (!tagIds.length || tagIds.some(t => r.tagIds.includes(t)))
        && (!range || !!(i & 4)) && (!favoriteOnly || !!(i & 8)) && (hasPhoto === null || hasPhoto === !!(i & 16)));
      for (const order of ["asc","desc"] as const) {
        const result = searchPage(rows,tags,{...filter,order},null,500,TODAY);
        assert.deepEqual(ids(result.items).sort(),ids(expected).sort(),JSON.stringify(filter));
        assert.equal(result.total,expected.length); combinations++;
      }
    }
  assert.equal(combinations,192);
  assert.equal(searchPage(rows,tags,{},null,500,TODAY).total,32);
  assert.equal(searchPage(rows,tags,{keyword:" 　 ",tagIds:[],from:"",to:"",favoriteOnly:false,hasPhoto:null},null,500,TODAY).total,32);
});

test("U012 leap dates, inclusive/open ranges, invalid ranges and bounded paging", () => {
  const rows = syntheticRows(4);
  ["2000-02-29","2024-02-29","2024-03-01","2100-03-01"].forEach((d,i) => rows[i]!.formal!.eventDate = d);
  const run = (filter: SearchFilter, limit = 50) => searchPage(rows,[],filter,null,limit,TODAY);
  assert.equal(run({from:"2024-02-29",to:"2024-03-01"}).total,2);
  assert.equal(run({to:"2000-02-29"}).total,1); assert.equal(run({from:"2100-03-01"}).total,1);
  for (const date of ["1900-02-29","2100-02-29","2023-02-29","2024-2-29","2024-04-31","2024-00-01","2024-01-00","x"]) {
    assert.throws(() => run({from:date}),code("INVALID_EVENT_DATE"));
    assert.throws(() => run({to:date}),code("INVALID_EVENT_DATE"));
  }
  assert.throws(() => run({from:"2024-03-01",to:"2024-02-29"}),code("INVALID_EVENT_DATE"));
  for (const n of [0,501,-1,NaN,1.5,Infinity]) assert.throws(() => run({},n),code("INVALID_LIMIT"));
  assert.throws(() => searchPage(rows,[],{},null,50,"2100-02-29"),code("INVALID_EVENT_DATE"));
});

test("U012 FORMAL only, hidden active records included, no-title/no-photo and no source writes", async () => {
  const rows = syntheticRows(5);
  rows[0]!.formal!.title = ""; rows[0]!.museumHidden = true;
  rows[0]!.draft = {...rows[0]!.formal!,body:"DRAFT-only",eventDate:"2030-01-01"};
  draftOnly(rows[1]!); trash(rows[2]!);
  photos(rows[3]!,1); rows[3]!.formal!.body = ""; rows[3]!.formal!.title = "";
  const {api,saved} = device(rows), disk = saved.getItem(KEY);
  const result = await api.searchPage({},null,50);
  assert.deepEqual(ids(result.items).sort(),[rid(1),rid(4),rid(5)]);
  assert.equal((await api.searchPage({keyword:"DRAFT-only"},null,50)).total,0);
  assert.equal(result.items.find(r => r.recordId === rid(1))!.cover,null);
  assert.equal(result.items.find(r => r.recordId === rid(4))!.title,"");
  assert.equal(saved.getItem(KEY),disk);
  assert.equal(searchPage([...rows,rows[0]!],[],{},null,50,TODAY).total,3,"record ID dedupe");
});

test("U012 same-day pagination reuses full M02 order in both directions without gaps", async () => {
  const rows = syntheticRows(103);
  rows.forEach((r,i) => {r.formal!.eventDate = "2024-02-29"; r.createdAt = i % 4 ? "same" : "early";
    r.formal!.eventTime = i % 3 === 0 ? null : i % 2 ? "09:00" : "10:00";});
  const {api} = device(rows);
  for (const order of ["asc","desc"] as const) {
    const expected = ids(timelinePage(rows,{order},null,500,TODAY).items), seen: string[] = [];
    let cursor: string | null = null;
    do { const page = await api.searchPage({order},cursor,7); assert.equal(page.total,103);
      seen.push(...ids(page.items)); cursor = page.nextCursor; assert.ok(seen.length <= 103);
    } while (cursor !== null);
    assert.deepEqual(seen,expected); assert.equal(new Set(seen).size,103);
    const sorted = timelinePage(rows,{order},null,500,TODAY).items;
    const firstNoTime = sorted.findIndex(r => !r.eventTime);
    assert.ok(sorted.slice(firstNoTime).every(r => !r.eventTime));
  }
});

test("U012 cursor rejects each changed query dimension, corrupt/oversize cursor and changed day", () => {
  const rows = syntheticRows(4), first = searchPage(rows,[],{},null,1,TODAY);
  assert.ok(first.nextCursor);
  for (const filter of [{keyword:"合成"},{tagIds:["x"]},{from:"2000-01-01"},{to:"2030-01-01"},{favoriteOnly:true},{hasPhoto:true},{hasPhoto:false},{order:"asc"}] as SearchFilter[]) {
    assert.throws(() => searchPage(rows,[],filter,first.nextCursor,1,TODAY),code("SEARCH_CURSOR_MISMATCH"));
  }
  assert.throws(() => searchPage(rows,[],{},first.nextCursor,1,"2026-11-13"),code("SEARCH_CURSOR_MISMATCH"));
  for (const cursor of ["[".repeat(1000)+"0"+"]".repeat(1000), JSON.stringify(["sg12",first.queryKey,first.sourceGeneration,"[".repeat(1000)+"0"+"]".repeat(1000)]), "", "oops", "[]", '"x"', "x".repeat(32769),JSON.stringify(["sg12",first.queryKey,first.sourceGeneration,"bad"])]) {
    assert.throws(() => searchPage(rows,[],{},cursor,1,TODAY),code("INVALID_CURSOR"));
  }
  const a = searchPage(rows,[],{keyword:"  合成  ",tagIds:[]},null,1,TODAY);
  assert.equal(searchPage(rows,[],{keyword:"合成"},a.nextCursor,2,TODAY).items.length,2);
});

test("U012 every source field invalidates cursor even with equal revisions; drafts/hidden do not", () => {
  const rows = syntheticRows(4); photos(rows[0]!,1); const tags = [tag("tag-a","A")]; rows[0]!.tagIds = ["tag-a"];
  const first = searchPage(rows,tags,{},null,1,TODAY);
  for (const mutate of [
    (r: typeof rows) => {r[0]!.formal!.title += "x";}, (r: typeof rows) => {r[0]!.formal!.body += "x";},
    (r: typeof rows) => {r[0]!.formal!.location += "x";}, (r: typeof rows) => {r[0]!.formal!.eventDate = "2024-02-29";},
    (r: typeof rows) => {r[0]!.formal!.photos[0]!.caption += "x";}, (r: typeof rows) => {r[0]!.favorite = true;},
    (r: typeof rows) => {r[0]!.tagIds = [];}, (r: typeof rows) => {r.pop();}, (r: typeof rows) => {trash(r[0]!);},
  ]) { const changed = structuredClone(rows); mutate(changed);
    assert.throws(() => searchPage(changed,tags,{},first.nextCursor,1,TODAY),code("SEARCH_CURSOR_STALE")); }
  assert.throws(() => searchPage(rows,[tag("tag-a","Renamed")],{},first.nextCursor,1,TODAY),code("SEARCH_CURSOR_STALE"));
  rows[0]!.draft = {...rows[0]!.formal!,body:"draft"}; rows[0]!.museumHidden = true;
  assert.equal(searchPage(rows,tags,{},first.nextCursor,1,TODAY).items.length,1);
});

test("U012 G01 real mutations keep drafts private and use current favorite/tag authority", async () => {
  const {api,saved} = device(), a = await record(api), b = await record(api);
  const old = await api.createTag("OldName"), target = await api.createTag("TargetName");
  await api.setRecordTags(a,[old.tagId]);
  await api.saveDraft({recordId:a,body:"Uncommitted",eventDate:"2030-01-01",location:"Draft place"});
  const first = await api.searchPage({},null,1);
  await api.setFavorite(a,true);
  assert.equal((await api.searchPage({keyword:"Uncommitted"},null,50)).total,0);
  assert.deepEqual(ids((await api.searchPage({favoriteOnly:true},null,50)).items),[a]);
  await assert.rejects(api.searchPage({},first.nextCursor,1),code("SEARCH_CURSOR_STALE"));
  await api.renameTag(old.tagId,"Renamed");
  assert.equal((await api.searchPage({keyword:"OldName"},null,50)).total,0);
  assert.deepEqual(ids((await api.searchPage({keyword:"renamed"},null,50)).items),[a]);
  await api.mergeTags(old.tagId,target.tagId);
  assert.equal((await api.searchPage({keyword:"Renamed"},null,50)).total,0);
  assert.deepEqual(ids((await api.searchPage({tagIds:[target.tagId],keyword:"TargetName"},null,50)).items),[a]);
  await api.commitRecord(a,1);
  assert.deepEqual(ids((await api.searchPage({keyword:"Uncommitted",favoriteOnly:true},null,50)).items),[a]);
  assert.equal((await api.getRecord(a)).favorite,true);
  await api.deleteTag(target.tagId);
  assert.equal((await api.searchPage({keyword:"TargetName"},null,50)).total,0);
  assert.equal((await api.searchPage({},null,50)).total,2);
  await api.trashRecord(a); assert.equal((await api.searchPage({keyword:"Uncommitted"},null,50)).total,0);
  await api.restoreRecord(a); assert.equal((await api.searchPage({keyword:"Uncommitted"},null,50)).total,1);
  const reopened = new MemoryAdapter({storage:saved,storageKey:KEY,search:""});
  assert.deepEqual(ids((await reopened.searchPage({},null,50,TODAY)).items).sort(),[a,b].sort());
});

test("U012 failed metadata writes preserve results and valid cursors", async () => {
  const {api,saved} = device(), a = await record(api); await record(api);
  const t = await api.createTag("Before"); await api.setRecordTags(a,[t.tagId]);
  for (const change of [() => api.setFavorite(a,true),() => api.renameTag(t.tagId,"After"),() => api.deleteTag(t.tagId)]) {
    const before = await api.searchPage({},null,1); saved.arm(); await assert.rejects(change());
    assert.equal((await api.searchPage({},before.nextCursor,1)).items.length,1);
    assert.equal((await api.searchPage({keyword:"Before"},null,50)).total,1);
  }
});

test("U012 backup overwrite/merge immediately rebuild queries and cannot revive deleted records", async () => {
  const {api:src} = device(), a = await record(src,"2024-02-29",1), b = await record(src);
  const t = await src.createTag("BackupTag"); await src.setRecordTags(a,[t.tagId]); await src.setFavorite(a,true);
  await src.saveDraft({recordId:a,body:"backup draft secret"}); await src.exportBackup(); const pkg = src.lastExportedPackage()!;
  const {api:dst} = device(); await dst.restoreBackup(await pick(dst,pkg));
  assert.equal((await dst.searchPage({keyword:"BackupTag",favoriteOnly:true,hasPhoto:true},null,50)).total,1);
  assert.equal((await dst.searchPage({keyword:"backup draft secret"},null,50)).total,0);
  const first = await dst.searchPage({},null,1);
  await src.renameTag(t.tagId,"NewBackupTag");
  const added = await src.createTag("ImportedOnly"); await src.setRecordTags(b,[added.tagId]); await src.exportBackup();
  await dst.mergeBackup(await pick(dst,src.lastExportedPackage()!));
  await assert.rejects(dst.searchPage({},first.nextCursor,1),code("SEARCH_CURSOR_STALE"));
  assert.equal((await dst.searchPage({keyword:"ImportedOnly"},null,50)).total,1);
  // Existing merge policy keeps the local live tag name; search reads that authority.
  assert.equal((await dst.searchPage({keyword:"NewBackupTag"},null,50)).total,0);
  assert.equal((await dst.searchPage({keyword:"BackupTag"},null,50)).total,1);
  await dst.mergeBackup(await pick(dst,src.lastExportedPackage()!)); assert.equal((await dst.searchPage({},null,50)).total,2);
  await dst.trashRecord(a); await dst.mergeBackup(await pick(dst,pkg)); assert.deepEqual(ids((await dst.searchPage({},null,50)).items),[b]);
  await dst.purgeRecord(a); await dst.mergeBackup(await pick(dst,pkg)); assert.deepEqual(ids((await dst.searchPage({},null,50)).items),[b]);
  await dst.restoreBackup(await pick(dst,pkg)); assert.equal((await dst.searchPage({keyword:"BackupTag"},null,50)).total,1);
});

test("U012 Tauri adapter transports defaults, all dimensions, cursor and errors unchanged", async () => {
  const calls: Array<{command: string; args?: Record<string,unknown>}> = [];
  const api = createTauriApi(async <T>(command: string,args?: Record<string,unknown>) => {calls.push({command,args}); return {total:0} as T;});
  await api.searchPage({},null,24,TODAY);
  assert.deepEqual(calls[0],{command:"search_page",args:{filter:{keyword:"",from:null,to:null,favoriteOnly:false,tagIds:[],hasPhoto:null,order:"desc"},cursor:null,limit:24,today:TODAY}});
  const filter: SearchFilter = {keyword:'<script>.*</script>',from:"2024-02-29",to:"2025-01-01",tagIds:["a","b"],favoriteOnly:true,hasPhoto:false,order:"asc"};
  await api.searchPage(filter,"opaque",5,TODAY);
  assert.deepEqual(calls[1]!.args,{filter,cursor:"opaque",limit:5,today:TODAY});
  const failure = {code:"SEARCH_CURSOR_STALE",message:"refresh"};
  await assert.rejects(createTauriApi(async () => {throw failure;}).searchPage({},"cursor",1), e => e === failure);
  const shell = readFileSync(new URL("../src-tauri/src/lib.rs",import.meta.url),"utf8");
  assert.ok(shell.includes("u012_cmd::search_page"));
});

test("U012 equivalent normalized tag sets accept cursor; nonmatching source edits invalidate it", async () => {
  const {api} = device(), a = await record(api), b = await record(api);
  const t1 = await api.createTag("One"), t2 = await api.createTag("Two");
  await api.setRecordTags(a,[t1.tagId,t2.tagId]); await api.setRecordTags(b,[t1.tagId]);
  const first = await api.searchPage({keyword:"合成",tagIds:[t2.tagId,t1.tagId,t2.tagId]},null,1);
  assert.equal((await api.searchPage({keyword:" 合成 ",tagIds:[t1.tagId,t2.tagId]},first.nextCursor,5)).items.length,1);
  const all = await api.searchPage({keyword:"合成"},null,1);
  const c = await record(api); await api.saveDraft({recordId:c,body:"unrelated"}); await api.commitRecord(c,1);
  await assert.rejects(api.searchPage({keyword:"合成"},all.nextCursor,1),code("SEARCH_CURSOR_STALE"));
});

test("U012 shared-asset captions belong to FORMAL photo uses until explicit commit", async () => {
  const {api} = device(), a = await record(api,"2024-02-29",1), b = await record(api,"2024-03-01",1);
  const ra = await api.getRecord(a), rb = await api.getRecord(b);
  assert.equal(ra.formal!.photos[0]!.assetId,rb.formal!.photos[0]!.assetId);
  const first = await api.searchPage({},null,1);
  await api.setDraftPhotoCaption(a,ra.formal!.photos[0]!.photoUseId,"private caption");
  assert.equal((await api.searchPage({keyword:"private caption"},null,50)).total,0);
  assert.equal((await api.searchPage({},first.nextCursor,1)).items.length,1);
  await api.setFavorite(a,true); await api.commitRecord(a,1);
  assert.deepEqual(ids((await api.searchPage({keyword:"private caption",favoriteOnly:true,hasPhoto:true},null,50)).items),[a]);
  assert.equal((await api.searchPage({keyword:"合成说明"},null,50)).total,1);
  await api.setFavorite(a,false);
  assert.equal((await api.searchPage({keyword:"private caption",favoriteOnly:true},null,50)).total,0);
  assert.equal((await api.searchPage({keyword:"private caption",hasPhoto:true},null,50)).total,1);
  assert.notEqual((await api.getRecord(b)).formal!.photos[0]!.caption,"private caption");
});

// Independent SHA-256 golden values from the explicit UTF-8 JSON tuple contract.
test("U012 Rust/TS normalized query and formal-source fingerprint golden contract", () => {
  const page = searchPage(syntheticRows(1),[],{keyword:" 合成 "},null,50,"2026-11-12");
  assert.equal(page.queryKey,"3017d2cf42a5be4994d4780d4590e988557e5f3347e7814d6e40aaa91e8cada4");
  assert.equal(page.sourceGeneration,"6ef6687ef36739de6fb8cc7a21d8408cbdd76db060acc7810f126e866182766c");
});
