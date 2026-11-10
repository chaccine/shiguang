import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { describeError } from "../src/domain/errors.ts";
const hasCode = (code: string) => (error: unknown) => { assert.equal((error as { code: string }).code, code); return true; };
function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
const KEY = "shiguang.synthetic.unit02";
async function seed(api: MemoryAdapter) {
  const a = (await api.createDraft({ title: "合成A", body: "合成正文A", eventDate: "2026-11-01" })).row.recordId;
  await api.attachPhotoBytes({ recordId: a, fileName: "a.png", bytes: [137, 80, 78, 71, 1, 2, 3], caption: "合成说明" });
  await api.commitRecord(a, 0);
  const b = (await api.createDraft({ title: "合成B", body: "合成正文B", eventDate: "2026-11-02" })).row.recordId;
  await api.commitRecord(b, 0); await api.trashRecord(b);
  const c = (await api.createDraft({ title: "合成C", body: "合成正文C", eventDate: "2026-11-03" })).row.recordId;
  await api.commitRecord(c, 0); await api.trashRecord(c); await api.purgeRecord(c);
  await api.createDraft({ title: "合成草稿", body: "未存入", eventDate: "2026-11-04" });
  return { a, b, c };
}

test("U05 导出只读：存储字节不变，摘要计数正确，能力如实报告未实现项", async () => {
  const saved = storage(), api = new MemoryAdapter({ storage: saved }); await seed(api);
  const before = saved.getItem(KEY);
  const result = await api.exportBackup();
  assert.equal(result.cancelled, false);
  if (result.cancelled) return;
  assert.equal(saved.getItem(KEY), before);
  assert.deepEqual(result.summary.counts, { formal: 1, drafts: 1, trashed: 1, deletionMarkers: 1, conflictCopies: 0, mediaFiles: 1, missingMedia: 0 });
  assert.equal(result.summary.encryption, "none");
  assert.match(result.fileName, /\.sgbak$/);
  const caps = await api.backupCapabilities();
  assert.equal(caps.overwriteRestore, true);
  assert.equal(caps.merge, false); assert.equal(caps.encryption, false); assert.equal(caps.antiResurrection, false);
});

test("U05 往返：导出→改动→覆盖恢复后状态与导出时一致；留安全副本；墓碑随包恢复", async () => {
  const saved = storage(), api = new MemoryAdapter({ storage: saved }); const { a, c } = await seed(api);
  const exported = saved.getItem(KEY)!;
  await api.exportBackup();
  await api.trashRecord(a);
  await api.createDraft({ title: "恢复后应消失", body: "合成", eventDate: "2026-11-05" });
  const changed = saved.getItem(KEY)!;
  const picked = await api.pickBackup(); assert.equal(picked.cancelled, false); if (picked.cancelled) return;
  assert.equal(saved.getItem(KEY), changed, "选择/校验不改数据");
  const restored = await api.restoreBackup(picked.token);
  assert.deepEqual(JSON.parse(saved.getItem(KEY)!).records, JSON.parse(exported).records);
  assert.deepEqual(JSON.parse(saved.getItem(KEY)!).deletionMarkers.map((m: { recordId: string }) => m.recordId), [c]);
  const safety = [...saved.data.keys()].find((k) => k.startsWith(`${KEY}.pre-restore.`));
  assert.ok(safety); assert.equal(saved.data.get(safety!), changed);
  assert.match(restored.safetyBackup, /^backups\/pre-restore-/);
  const reopened = new MemoryAdapter({ storage: saved });
  assert.deepEqual((await reopened.listFormalRecords()).map((r) => r.recordId), [a]);
  await assert.rejects(reopened.getRecord(c), hasCode("RECORD_DELETED"));
  await assert.rejects(api.restoreBackup(picked.token), hasCode("BACKUP_TOKEN_INVALID"));
});

for (const [kind, code] of [["corrupt", "BACKUP_CORRUPT"], ["truncated", "BACKUP_TRUNCATED"], ["schemaTooNew", "BACKUP_SCHEMA_TOO_NEW"],
  ["encrypted", "BACKUP_ENCRYPTED_UNSUPPORTED"], ["notBackup", "BACKUP_INVALID"]] as const) {
  test(`U05 ${kind} 包被拒（${code}），当前数据不变`, async () => {
    const saved = storage(), api = new MemoryAdapter({ storage: saved }); await seed(api); await api.exportBackup();
    const before = saved.getItem(KEY);
    api.setNextPickedBackup(kind);
    await assert.rejects(api.pickBackup(), hasCode(code));
    assert.equal(saved.getItem(KEY), before);
    const text = describeError({ code });
    assert.equal(text.kind, "io"); assert.match(text.detail, /当前数据没有任何改动/);
  });
}

test("U05 恢复中途失败（安全副本写入失败）→ 当前数据不变", async () => {
  const saved = storage(), api = new MemoryAdapter({ storage: saved }); await seed(api); await api.exportBackup();
  const picked = await api.pickBackup(); if (picked.cancelled) assert.fail("应选中");
  await api.createDraft({ title: "合成新草稿", body: "x", eventDate: "2026-11-06" });
  const before = saved.getItem(KEY);
  api.failNext("RESTORE_FAILED", "restoreBackup");
  await assert.rejects(api.restoreBackup(picked.token), hasCode("RESTORE_FAILED"));
  assert.equal(saved.getItem(KEY), before);
});

test("U05 空库导出与恢复", async () => {
  const saved = storage(), api = new MemoryAdapter({ storage: saved });
  const result = await api.exportBackup(); if (result.cancelled) assert.fail("应导出");
  assert.equal(result.summary.counts.formal, 0);
  await api.createDraft({ title: "合成", body: "x", eventDate: "2026-11-06" });
  const picked = await api.pickBackup(); if (picked.cancelled) assert.fail("应选中");
  await api.restoreBackup(picked.token);
  assert.deepEqual(await api.listDrafts(), []);
});

test("U05 未导出过时预览选择返回 cancelled", async () => {
  const api = new MemoryAdapter({ storage: storage() });
  assert.deepEqual(await api.pickBackup(), { cancelled: true });
});

test("U05 所有备份/恢复错误码都有中文文案", () => {
  for (const code of ["BACKUP_INVALID", "BACKUP_TRUNCATED", "BACKUP_CORRUPT", "BACKUP_SCHEMA_TOO_NEW", "BACKUP_FORMAT_TOO_NEW",
    "BACKUP_ENCRYPTED_UNSUPPORTED", "BACKUP_TOKEN_INVALID", "BACKUP_DEST_EXISTS", "BACKUP_SOURCE_CHANGED", "BACKUP_WRITE_FAILED",
    "BACKUP_IO_FAILED", "RESTORE_SAFETY_BACKUP_FAILED", "RESTORE_FAILED"]) {
    const d = describeError({ code }); assert.notEqual(d.kind, "unknown", code); assert.match(d.title, /[\u4e00-\u9fff]/);
  }
});
