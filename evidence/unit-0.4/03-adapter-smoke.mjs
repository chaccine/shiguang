// 贯通层补充检查：只用合成内容，不修改 tests/ 中的既有断言。
import assert from "node:assert/strict";
import { MemoryAdapter } from "../../src/platform/memory-adapter.ts";
import { createTauriApi } from "../../src/platform/tauri-adapter.ts";

const fields = { body: "合成照片记录", eventDate: "2026-11-09" };
const hasCode = (code) => (error) => error?.code === code;
const storage = () => {
  let raw = null;
  return { getItem: () => raw, setItem: (_key, value) => { raw = value; } };
};
const photo = (recordId) => ({ recordId, fileName: "synthetic.png", bytes: [137, 80, 78, 71, 3], caption: "合成照片" });

for (const [query, code] of [["locked", "STORE_LOCKED"], ["schema", "SCHEMA_TOO_NEW"]]) {
  const saved = storage();
  globalThis.window = { location: { search: `?fail=${query}` } };
  const api = new MemoryAdapter({ storage: saved });
  delete globalThis.window;
  const status = await api.storeStatus();
  assert.equal(status.ok, false); assert.equal(status.code, code); assert.match(status.message, /[\u4e00-\u9fff]/);
  const operations = [
    () => api.listDrafts(), () => api.listFormalRecords(), () => api.getRecord("synthetic"),
    () => api.createDraft(fields), () => api.saveDraft({ recordId: "synthetic" }),
    () => api.attachPhotoBytes(photo("synthetic")), () => api.removeDraftPhoto("synthetic", "pu"),
    () => api.discardDraft("synthetic"), () => api.commitRecord("synthetic", 0),
    () => api.photoDataUrl("ast"), () => api.exportManifest("synthetic.json"),
    () => api.trashRecord("synthetic"), () => api.restoreRecord("synthetic"),
    () => api.purgeRecord("synthetic"), () => api.emptyTrash(), () => api.listTrash(),
    () => api.resolveConflict("synthetic", "keepMine"), () => api.listConflictCopies(),
    () => api.restoreConflictCopy("conflict"), () => api.mediaReport(), () => api.photoStatus("ast"),
  ];
  for (const run of operations) await assert.rejects(run(), hasCode(code));
  assert.equal(saved.getItem(""), null);
}
console.log("PASS URL 启动错误：storeStatus 中文提示、全部 21 个其他方法拒绝且不写存储");

const saved = storage(), api = new MemoryAdapter({ storage: saved });
const a = (await api.createDraft(fields)).row.recordId, b = (await api.createDraft(fields)).row.recordId;
const attached = (await api.attachPhotoBytes(photo(a))).row;
const assetId = attached.draft.photos[0].assetId;
await api.attachPhotoBytes(photo(b)); await api.commitRecord(a, 0); await api.commitRecord(b, 0);
await api.trashRecord(a);
assert.deepEqual((await api.purgeRecord(a)).quarantined, []);
assert.equal(await api.photoStatus(assetId), "available");
await api.trashRecord(b);
const purged = await api.purgeRecord(b);
assert.equal(purged.quarantined.length, 1); assert.equal(purged.durability, "durable");
const bytes = JSON.parse(saved.getItem(""));
assert.equal(Object.keys(bytes.assets).length, 0);
assert.ok(bytes.quarantine[purged.quarantined[0].movedTo].dataUrl.startsWith("data:image/png;base64,"));
const restarted = new MemoryAdapter({ storage: saved });
assert.deepEqual((await restarted.mediaReport()).quarantined, []);
await assert.rejects(restarted.getRecord(a), hasCode("RECORD_DELETED"));
console.log("PASS 共享原图在最后一个引用删除后才隔离；隔离保留内容并可重启");

const conflictStorage = storage(), conflicts = new MemoryAdapter({ storage: conflictStorage });
const conflictRecord = (await conflicts.createDraft(fields)).row.recordId;
await conflicts.commitRecord(conflictRecord, 0);
const conflictAsset = (await conflicts.attachPhotoBytes(photo(conflictRecord))).row.draft.photos[0].assetId;
await conflicts.resolveConflict(conflictRecord, "keepFormal");
await conflicts.trashRecord(conflictRecord);
assert.deepEqual((await conflicts.purgeRecord(conflictRecord)).quarantined, []);
const conflictReopened = new MemoryAdapter({ storage: conflictStorage });
assert.equal(await conflictReopened.photoStatus(conflictAsset), "available");
const retained = await conflictReopened.listConflictCopies();
assert.equal(retained.length, 1);
assert.deepEqual((await conflictReopened.mediaReport()).quarantined, []);
await assert.rejects(conflictReopened.restoreConflictCopy(retained[0].conflictId), hasCode("RECORD_DELETED"));
console.log("PASS 冲突副本引用保护原图；永久删除标记阻止副本复活已删除记录");

const mediaStorage = storage(), media = new MemoryAdapter({ storage: mediaStorage });
const id = (await media.createDraft(fields)).row.recordId;
const row = (await media.attachPhotoBytes(photo(id))).row, use = row.draft.photos[0];
const original = mediaStorage.getItem("");
media.setPhotoStatus(use.assetId, "missing");
assert.deepEqual((await media.mediaReport()).missing, [{ recordId: id, photoUseId: use.photoUseId, assetId: use.assetId }]);
await assert.rejects(media.photoDataUrl(use.assetId), hasCode("ASSET_MISSING"));
media.setPhotoStatus(use.assetId, "corrupt");
assert.equal((await media.mediaReport()).corrupt.length, 1);
await assert.rejects(media.photoDataUrl(use.assetId), hasCode("ASSET_HASH_MISMATCH"));
assert.equal(mediaStorage.getItem(""), original);
assert.deepEqual(await media.getRecord(id), row);
const preview = new MemoryAdapter({ storage: mediaStorage, search: "?media=missing" });
assert.equal((await preview.mediaReport()).missing.length, 1);
console.log("PASS 缺失/损坏原图及 URL 模拟：报告、photoStatus、预览错误，记录和存储字节不变");

media.setPhotoStatus(use.assetId, "available"); await media.discardDraft(id);
assert.equal((await media.mediaReport()).quarantined.length, 1);
assert.equal((await media.mediaReport()).quarantined.length, 1);
assert.deepEqual(await media.listDrafts(), []);
console.log("PASS 孤立原图移入隔离区，重复读取媒体报告保留首次隔离清单");

const calls = [], tauri = createTauriApi(async (command, args) => { calls.push([command, args]); return {}; });
await tauri.trashRecord("rec"); await tauri.restoreRecord("rec"); await tauri.purgeRecord("rec");
await tauri.emptyTrash(); await tauri.listTrash(); await tauri.resolveConflict("rec", "keepMine");
await tauri.resolveConflict("rec", "keepFormal"); await tauri.listConflictCopies();
await tauri.restoreConflictCopy("conflict"); await tauri.mediaReport(); await tauri.photoStatus("ast"); await tauri.storeStatus();
assert.deepEqual(calls, [
  ["trash_record", { recordId: "rec" }], ["restore_record", { recordId: "rec" }], ["purge_record", { recordId: "rec" }],
  ["empty_trash", undefined], ["list_trash", undefined], ["resolve_conflict", { recordId: "rec", choice: "keepMine" }],
  ["resolve_conflict", { recordId: "rec", choice: "keepFormal" }], ["list_conflict_copies", undefined],
  ["restore_conflict_copy", { conflictId: "conflict" }], ["media_report", undefined], ["photo_status", { assetId: "ast" }], ["store_status", undefined],
]);
console.log("PASS TS → Tauri 全部新命令及两种冲突选择的参数映射");
