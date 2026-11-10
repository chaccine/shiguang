// Unit-0.6：安全合并 + 防复活 + 可选口令加密（MemoryAdapter 同语义预览实现）。全部为合成数据。
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { describeError } from "../src/domain/errors.ts";
const KEY = "shiguang.synthetic.unit02";
const PW = "合成口令-u06"; // 仅合成测试口令；断言里只检查“不出现”，不打印。
const hasCode = (code: string) => (error: unknown) => { assert.equal((error as { code: string }).code, code); return true; };
function storage(failOn?: (key: string) => boolean) {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => {
    if (failOn?.(key)) throw new Error("合成写入失败"); data.set(key, value); } };
}
function clock(base: number) { let t = base; return () => new Date(t += 1000).toISOString(); }
function device(base: number, failOn?: (key: string) => boolean) {
  const saved = storage(failOn);
  return { saved, api: new MemoryAdapter({ storage: saved, now: clock(base), search: "" }) };
}
async function seed(api: MemoryAdapter) {
  const a = (await api.createDraft({ title: "合成A", body: "合成正文A", eventDate: "2026-11-01" })).row.recordId;
  await api.attachPhotoBytes({ recordId: a, fileName: "a.png", bytes: [137, 80, 78, 71, 1, 2, 3], caption: "合成说明" });
  await api.commitRecord(a, 0);
  const b = (await api.createDraft({ title: "合成B", body: "合成正文B", eventDate: "2026-11-02" })).row.recordId;
  await api.commitRecord(b, 0);
  return { a, b };
}
async function pickLast(from: MemoryAdapter, into: MemoryAdapter) {
  into.setNextPickedPackage(from.lastExportedPackage()!);
  const picked = await into.pickBackup();
  assert.equal(picked.cancelled, false);
  if (picked.cancelled) throw new Error("unreachable");
  return picked;
}
async function edit(api: MemoryAdapter, recordId: string, body: string) {
  const row = await api.getRecord(recordId);
  await api.saveDraft({ recordId, body });
  await api.commitRecord(recordId, row.contentRevision);
}

test("U06 防复活：本机永久删除后，合并旧备份不会带回该记录", async () => {
  const { api } = device(Date.UTC(2026, 10, 1)); const { a } = await seed(api);
  await api.exportBackup();
  await api.trashRecord(a); await api.purgeRecord(a);
  const picked = await pickLast(api, api);
  const plan = await api.planMerge(picked.token);
  assert.equal(plan.counts.skippedDeleted, 1); assert.deepEqual(plan.skippedDeleted, [a]);
  const result = await api.mergeBackup(picked.token);
  assert.equal(result.plan.counts.added, 0);
  await assert.rejects(api.getRecord(a), hasCode("RECORD_DELETED"));
  assert.ok(result.safetyBackup.startsWith("backups/pre-merge-"));
});

test("U06 回收站中的记录不会被旧备份里的活动版本拉回", async () => {
  const { api } = device(Date.UTC(2026, 10, 1)); const { b } = await seed(api);
  await api.exportBackup(); await api.trashRecord(b);
  const picked = await pickLast(api, api);
  const result = await api.mergeBackup(picked.token);
  assert.equal(result.plan.counts.keptTrashed, 1);
  assert.equal((await api.getRecord(b)).status, "trashed");
});

test("U06 同记录：较新的 contentRevision 胜出，本机旧版保留为冲突副本（不静默覆盖）", async () => {
  const one = device(Date.UTC(2026, 10, 1)); const { a } = await seed(one.api); await one.api.exportBackup();
  const two = device(Date.UTC(2026, 10, 5));
  await two.api.restoreBackup((await pickLast(one.api, two.api)).token);
  await edit(two.api, a, "合成正文A-另一台设备改过");
  await two.api.exportBackup();
  const result = await one.api.mergeBackup((await pickLast(two.api, one.api)).token);
  assert.equal(result.plan.counts.updated, 1);
  const row = await one.api.getRecord(a);
  assert.equal(row.formal?.body, "合成正文A-另一台设备改过"); assert.equal(row.contentRevision, 2);
  const copies = await one.api.listConflictCopies();
  assert.ok(copies.some((c) => c.recordId === a && c.snapshot.body === "合成正文A"));
});

test("U06 同修订号不同内容：保留本机版本，备份版本存为冲突副本", async () => {
  const one = device(Date.UTC(2026, 10, 1)); const { a } = await seed(one.api); await one.api.exportBackup();
  const two = device(Date.UTC(2026, 10, 5));
  await two.api.restoreBackup((await pickLast(one.api, two.api)).token);
  await edit(two.api, a, "合成-设备二版本"); await two.api.exportBackup();
  await edit(one.api, a, "合成-设备一版本");
  const result = await one.api.mergeBackup((await pickLast(two.api, one.api)).token);
  assert.equal(result.plan.counts.conflicts, 1);
  assert.equal((await one.api.getRecord(a)).formal?.body, "合成-设备一版本");
  assert.ok((await one.api.listConflictCopies()).some((c) => c.snapshot.body === "合成-设备二版本"));
});

test("U06 跨设备撞号：不同记录同 recordId 改号新增，重复导入幂等", async () => {
  const one = device(Date.UTC(2026, 10, 1)); await seed(one.api); await one.api.exportBackup();
  const three = device(Date.UTC(2026, 10, 9));
  const own = (await three.api.createDraft({ title: "合成本机", body: "本机自己的", eventDate: "2026-11-09" })).row.recordId;
  await three.api.commitRecord(own, 0);
  const first = await three.api.mergeBackup((await pickLast(one.api, three.api)).token);
  assert.equal(first.plan.counts.added, 2);
  assert.equal((await three.api.getRecord(own)).formal?.body, "本机自己的");
  const formal = await three.api.listFormalRecords();
  assert.equal(formal.length, 3);
  assert.equal(new Set(formal.map((r) => r.recordId)).size, 3);
  assert.equal(first.plan.counts.mediaAdded, 1);
  const snapshot = three.saved.getItem(KEY);
  const second = await three.api.mergeBackup((await pickLast(one.api, three.api)).token);
  assert.equal(second.plan.counts.added, 0); assert.equal(second.plan.counts.conflictCopiesAdded, 0); assert.equal(second.plan.counts.mediaAdded, 0);
  assert.equal((await three.api.listFormalRecords()).length, 3);
  assert.deepEqual(JSON.parse(three.saved.getItem(KEY)!).records, JSON.parse(snapshot!).records);
});

test("U06 合并时备份里的删除标记：本机仍在的记录保持不动，并在计划里列出", async () => {
  const one = device(Date.UTC(2026, 10, 1)); const { a } = await seed(one.api); await one.api.exportBackup();
  const two = device(Date.UTC(2026, 10, 5));
  await two.api.restoreBackup((await pickLast(one.api, two.api)).token);
  await two.api.trashRecord(a); await two.api.purgeRecord(a); await two.api.exportBackup();
  const result = await one.api.mergeBackup((await pickLast(two.api, one.api)).token);
  assert.equal(result.plan.counts.deletedInBackup, 1); assert.deepEqual(result.plan.deletedInBackup, [a]);
  assert.equal((await one.api.getRecord(a)).status, "active");
});

test("U06 合并：安全副本写不进去就整体中止，当前数据不变", async () => {
  const one = device(Date.UTC(2026, 10, 1)); await seed(one.api); await one.api.exportBackup();
  const three = device(Date.UTC(2026, 10, 9), (key) => key.includes(".pre-merge."));
  await three.api.createDraft({ title: "合成本机", body: "本机", eventDate: "2026-11-09" });
  const before = three.saved.getItem(KEY);
  const picked = await pickLast(one.api, three.api);
  await assert.rejects(three.api.mergeBackup(picked.token), hasCode("RESTORE_SAFETY_BACKUP_FAILED"));
  assert.equal(three.saved.getItem(KEY), before);
});

test("U06 加密：导出包不含明文；缺口令/错口令/篡改一律拒绝且当前数据不变；对口令可合并", async () => {
  const one = device(Date.UTC(2026, 10, 1)); await seed(one.api);
  await assert.rejects(one.api.exportBackup({ password: "" }), hasCode("BACKUP_PASSWORD_EMPTY"));
  const exported = await one.api.exportBackup({ password: PW });
  assert.equal(exported.cancelled, false);
  const pkg = one.api.lastExportedPackage()!;
  assert.ok(!pkg.body.includes("合成正文A")); assert.ok(!JSON.stringify(pkg).includes(PW));
  const three = device(Date.UTC(2026, 10, 9));
  await three.api.createDraft({ title: "合成本机", body: "本机", eventDate: "2026-11-09" });
  const before = three.saved.getItem(KEY);
  three.api.setNextPickedPackage(pkg);
  const picked = await three.api.pickBackup();
  assert.ok(!picked.cancelled && picked.encrypted && picked.summary === null);
  if (picked.cancelled) return;
  await assert.rejects(three.api.planMerge(picked.token), hasCode("BACKUP_PASSWORD_REQUIRED"));
  await assert.rejects(three.api.restoreBackup(picked.token), hasCode("BACKUP_PASSWORD_REQUIRED"));
  await assert.rejects(three.api.unlockBackup(picked.token, "错误的合成口令"), (e: unknown) => {
    assert.equal((e as { code: string }).code, "BACKUP_PASSWORD_WRONG");
    assert.ok(!String((e as Error).message).includes("错误的合成口令")); return true; });
  assert.equal(three.saved.getItem(KEY), before);
  three.api.setNextPickedPackage({ ...pkg, body: pkg.body.slice(0, -3) + "xyz" });
  const tampered = await three.api.pickBackup();
  if (tampered.cancelled) throw new Error("unreachable");
  await assert.rejects(three.api.unlockBackup(tampered.token, PW), hasCode("BACKUP_CORRUPT"));
  assert.equal(three.saved.getItem(KEY), before);
  const { summary } = await three.api.unlockBackup(picked.token, PW);
  assert.equal(summary.counts.formal, 2);
  const merged = await three.api.mergeBackup(picked.token);
  assert.equal(merged.plan.counts.added, 2);
  assert.ok(!JSON.stringify([...three.saved.data.entries()]).includes(PW));
});

test("U06 新错误码都有中文说明，且说明当前数据未改动", () => {
  for (const code of ["BACKUP_PASSWORD_REQUIRED", "BACKUP_PASSWORD_WRONG", "BACKUP_KDF_PARAMS_INVALID", "MERGE_FAILED"]) {
    const d = describeError({ code, message: "x" });
    assert.ok(d.title.length > 0 && !/[A-Z_]{6,}/.test(d.title), code);
    assert.match(d.detail, /当前数据没有任何改动/);
  }
});
