import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { describeError } from "../src/domain/errors.ts";
const fields = { title: "合成标题", body: "合成正文", eventDate: "2026-11-09" };
const hasCode = (code: string) => (error: unknown) => { assert.equal((error as { code: string }).code, code); return true; };
function storage() { let raw: string | null = null; return { getItem: (_key: string) => raw, setItem: (_key: string, value: string) => { raw = value; } }; }
async function formal(api: MemoryAdapter) { const { row } = await api.createDraft(fields); await api.commitRecord(row.recordId, 0); return row.recordId; }

test("U04 trash/restore 保留双槽、修订号，列表过滤并可重启", async () => {
  const saved = storage(); let api = new MemoryAdapter({ storage: saved }); const id = await formal(api);
  await api.saveDraft({ recordId: id, body: "合成修改草稿" }); const original = await api.getRecord(id);
  const { row } = await api.trashRecord(id); assert.equal(row.status, "trashed"); assert.ok(row.trashedAt);
  assert.deepEqual(row.formal, original.formal); assert.deepEqual(row.draft, original.draft);
  assert.deepEqual(await api.listDrafts(), []); assert.deepEqual(await api.listFormalRecords(), []);
  api = new MemoryAdapter({ storage: saved }); assert.deepEqual((await api.listTrash()).map((r) => r.recordId), [id]);
  const restored = (await api.restoreRecord(id)).row; assert.equal(restored.status, "active"); assert.equal(restored.trashedAt, null);
  assert.deepEqual(restored.formal, original.formal); assert.deepEqual(restored.draft, original.draft);
  assert.equal(restored.contentRevision, original.contentRevision); assert.equal(restored.baseRevision, original.baseRevision);
  assert.equal((await api.listDrafts()).length, 1); assert.equal((await api.listFormalRecords()).length, 1); assert.deepEqual(await api.listTrash(), []);
});
test("U04 listTrash 按移入时间倒序；打开不会自动永久删除", async () => {
  const saved = storage(); let now = "2026-01-01T00:00:00Z"; const api = new MemoryAdapter({ storage: saved, now: () => now });
  const a = await formal(api), b = await formal(api); await api.trashRecord(a);
  now = "2026-02-01T00:00:00Z"; await api.trashRecord(b);
  const reopened = new MemoryAdapter({ storage: saved, now: () => "2099-01-01T00:00:00Z" });
  assert.deepEqual((await reopened.listTrash()).map((r) => r.recordId), [b, a]);
});
for (const operation of ["save", "attach", "commit", "create", "discard"] as const) {
  test(`U04 trashed ${operation} 返回 RECORD_TRASHED 且存储不变`, async () => {
    const saved = storage(), api = new MemoryAdapter({ storage: saved }); const id = await formal(api);
    await api.saveDraft({ recordId: id, body: "合成草稿" }); await api.trashRecord(id); const before = saved.getItem("");
    const task = () => {
      switch (operation) {
        case "save": return api.saveDraft({ recordId: id, body: "不能写入" });
        case "attach": return api.attachPhotoBytes({ recordId: id, fileName: "s.png", bytes: [137, 80, 78, 71], caption: "合成" });
        case "commit": return api.commitRecord(id, 1);
        case "create": return api.createDraft({ baseRecordId: id });
        case "discard": return api.discardDraft(id);
      }
    };
    await assert.rejects(async () => task(), hasCode("RECORD_TRASHED")); assert.equal(saved.getItem(""), before);
  });
}
test("U04 纯草稿不可入回收站，active 不可 purge", async () => {
  const saved = storage(), api = new MemoryAdapter({ storage: saved }); const { row } = await api.createDraft(fields); const before = saved.getItem("");
  await assert.rejects(api.trashRecord(row.recordId)); assert.equal(saved.getItem(""), before);
  await assert.rejects(api.purgeRecord(row.recordId)); assert.equal(saved.getItem(""), before);
  await api.commitRecord(row.recordId, 0); const formalBytes = saved.getItem("");
  await assert.rejects(api.purgeRecord(row.recordId)); assert.equal(saved.getItem(""), formalBytes);
  assert.deepEqual(await api.listTrash(), []);
});
test("U04 purge 写无个人内容的 DeletionMarker、RECORD_DELETED、ID 不复用", async () => {
  const saved = storage(), api = new MemoryAdapter({ storage: saved }); const id = await formal(api); await api.trashRecord(id);
  const result = await api.purgeRecord(id); assert.equal(result.deletionMarkers.length, 1);
  assert.deepEqual(Object.keys(result.deletionMarkers[0]!).sort(), ["deletedAt", "lastContentRevision", "recordId"]);
  assert.equal(result.deletionMarkers[0]!.recordId, id); assert.equal(result.deletionMarkers[0]!.lastContentRevision, 1);
  assert.ok(result.deletionMarkers[0]!.deletedAt); assert.deepEqual(await api.listTrash(), []);
  for (const text of [fields.title, fields.body]) assert.ok(!saved.getItem("")!.includes(text));
  const restarted = new MemoryAdapter({ storage: saved }); await assert.rejects(restarted.getRecord(id), hasCode("RECORD_DELETED"));
  assert.notEqual((await restarted.createDraft(fields)).row.recordId, id);
});
test("U04 emptyTrash 只永久删除回收站，保留 active 与纯草稿", async () => {
  const api = new MemoryAdapter(), active = await formal(api), pending = (await api.createDraft(fields)).row.recordId;
  const a = await formal(api), b = await formal(api); await api.trashRecord(a); await api.trashRecord(b);
  const out = await api.emptyTrash(); assert.equal(out.deletionMarkers.length, 2); assert.deepEqual(await api.listTrash(), []);
  for (const id of [a, b]) await assert.rejects(api.getRecord(id), hasCode("RECORD_DELETED"));
  assert.ok((await api.getRecord(active)).formal); assert.ok((await api.getRecord(pending)).draft);
  assert.deepEqual((await api.emptyTrash()).deletionMarkers, []);
});
async function conflicted(occupied = false) {
  const saved = storage(), local = new MemoryAdapter({ storage: saved, now: () => "2099-01-01T00:00:00Z" }); const { row } = await local.createDraft(fields);
  const other = new MemoryAdapter({ storage: saved, now: () => "2000-01-01T00:00:00Z" });
  await other.saveDraft({ recordId: row.recordId, body: "合成其他正式版" }); await other.commitRecord(row.recordId, 0);
  if (occupied) await other.saveDraft({ recordId: row.recordId, body: "合成磁盘草稿" });
  await assert.rejects(local.commitRecord(row.recordId, 0), hasCode("REVISION_CONFLICT"));
  return { local, saved, id: row.recordId };
}
test("U04 resolveConflict keepMine 只改基线，不自动提交", async () => {
  const { local, saved, id } = await conflicted(); const { row } = await local.resolveConflict(id, "keepMine");
  assert.equal(row.baseRevision, 1); assert.equal(row.contentRevision, 1); assert.equal(row.formal?.body, "合成其他正式版"); assert.equal(row.draft?.body, fields.body);
  const reopened = new MemoryAdapter({ storage: saved }); assert.equal((await reopened.commitRecord(id, 1)).contentRevision, 2);
});
test("U04 keepFormal 保存可恢复副本，restore 使用最新正式基线", async () => {
  const { local, saved, id } = await conflicted(); assert.equal((await local.resolveConflict(id, "keepFormal")).row.draft, null);
  const copies = await local.listConflictCopies(); assert.equal(copies.length, 1); const c = copies[0]!;
  assert.equal(c.recordId, id); assert.equal(c.baseRevision, 0); assert.equal(c.snapshot.body, fields.body); assert.ok(c.createdAt); assert.ok(c.reason);
  const api = new MemoryAdapter({ storage: saved }); assert.deepEqual(await api.listConflictCopies(), copies);
  await api.saveDraft({ recordId: id, body: "合成第二次更新" }); await api.commitRecord(id, 1);
  const row = (await api.restoreConflictCopy(c.conflictId)).row; assert.equal(row.baseRevision, 2); assert.equal(row.contentRevision, 2); assert.deepEqual(row.draft, c.snapshot);
});
test("U04 磁盘草稿槽占用时本地草稿持久化到 conflictCopies", async () => {
  const { saved, id } = await conflicted(true); const api = new MemoryAdapter({ storage: saved });
  assert.equal((await api.getRecord(id)).draft?.body, "合成磁盘草稿");
  const copies = await api.listConflictCopies(); assert.ok(copies.some((c) => c.recordId === id && c.baseRevision === 0 && c.snapshot.body === fields.body));
  const before = saved.getItem(""); await assert.rejects(api.restoreConflictCopy(copies[0]!.conflictId)); assert.equal(saved.getItem(""), before);
});
for (const [code, expected] of [
  ["STORE_LOCKED", /另一个窗口|另一个.*程序/], ["STORE_BUSY", /正在写入.*稍后重试/],
  ["SCHEMA_TOO_NEW", /更新版本.*升级/], ["RECORD_TRASHED", /回收站.*恢复/], ["RECORD_DELETED", /永久删除/],
  ["MIGRATION_BACKUP_FAILED", /备份.*原.*未|备份.*原.*没有/], ["MIGRATION_FAILED", /迁移.*原.*未|迁移.*原.*没有/],
] as const) {
  test(`U04 describeError ${code} 提供明确中文提示与诊断`, () => {
    const result = describeError({ code, stage: "synthetic", message: "synthetic" });
    assert.notEqual(result.kind, "unknown"); assert.match(result.detail, expected); assert.match(result.detail, new RegExp(code));
    if (code.startsWith("MIGRATION")) assert.match(result.detail, /synthetic/);
  });
}
