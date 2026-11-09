import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { base64, sha256 } from "../src/platform/bytes.ts";
import { createTauriApi } from "../src/platform/tauri-adapter.ts";

const fields = { title: "合成标题", body: "合成正文", eventDate: "2026-11-09" };
const hasCode = (code: string) => (error: unknown) => {
  assert.equal((error as { code: string }).code, code); return true;
};
function storage() {
  let raw: string | null = null;
  return { getItem: (_key: string) => raw, setItem: (_key: string, value: string) => { raw = value; } };
}

test("内存 create/save/commit 和正式投影保持双槽语义", async () => {
  const api = new MemoryAdapter();
  const { row } = await api.createDraft(fields);
  assert.equal((await api.listFormalRecords()).length, 0);
  await api.commitRecord(row.recordId, 0);
  await api.createDraft({ baseRecordId: row.recordId, body: "不会覆盖正式版" });
  await api.saveDraft({ recordId: row.recordId, body: "修改正文", eventTime: "12:34" });
  const pending = await api.getRecord(row.recordId);
  assert.equal(pending.formal?.body, fields.body); assert.equal(pending.draft?.body, "修改正文");
  assert.equal(pending.baseRevision, 1);
  const result = await api.commitRecord(row.recordId, 1);
  assert.equal(result.contentRevision, 2);
  assert.equal((await api.getRecord(row.recordId)).draft, null);
});

test("storage 注入模拟重启并按更新时间、ID 恢复排序", async () => {
  const saved = storage(); let now = "2099-01-01T00:00:00Z";
  const api = new MemoryAdapter({ storage: saved, now: () => now });
  const a = (await api.createDraft(fields)).row;
  now = "2000-01-01T00:00:00Z";
  const b = (await api.createDraft(fields)).row, c = (await api.createDraft(fields)).row;
  const restarted = new MemoryAdapter({ storage: saved });
  assert.deepEqual((await restarted.listDrafts()).map((r) => r.recordId), [a.recordId, c.recordId, b.recordId]);
  assert.deepEqual(await restarted.getRecord(a.recordId), a);
});

test("commit 校验错误保留草稿和磁盘；save 校验错误不物化草稿", async () => {
  const saved = storage(), api = new MemoryAdapter({ storage: saved });
  const { row } = await api.createDraft({ title: "只有标题", eventDate: fields.eventDate });
  const before = saved.getItem("");
  await assert.rejects(api.commitRecord(row.recordId, 0), hasCode("EMPTY_CONTENT"));
  assert.equal(saved.getItem(""), before);
  for (const [input, code] of [
    [{ body: "正文", eventDate: "" }, "MISSING_EVENT_DATE"],
    [{ body: "正文", eventDate: "2026-02-30" }, "INVALID_EVENT_DATE"],
    [{ body: "正文", eventTime: "24:00" }, "INVALID_EVENT_TIME"],
  ] as const) {
    const fresh = (await api.createDraft({ ...fields, ...input })).row;
    await assert.rejects(api.commitRecord(fresh.recordId, 0), hasCode(code));
    assert.ok((await api.getRecord(fresh.recordId)).draft);
  }
  const formal = (await api.createDraft(fields)).row;
  await api.commitRecord(formal.recordId, 0);
  const old = await api.getRecord(formal.recordId);
  await assert.rejects(api.saveDraft({ recordId: formal.recordId, title: "不能留下", eventDate: "bad" }), hasCode("INVALID_EVENT_DATE"));
  assert.deepEqual(await api.getRecord(formal.recordId), old);
  await assert.rejects(api.saveDraft({ recordId: formal.recordId, eventTime: "25:00" }), hasCode("INVALID_EVENT_TIME"));
  assert.deepEqual(await api.getRecord(formal.recordId), old);
});

test("清空 eventTime 与 Tauri null 契约一致", async () => {
  const api = new MemoryAdapter(); const { row } = await api.createDraft({ ...fields, eventTime: " 12:34 " });
  assert.equal(row.draft?.eventTime, "12:34");
  assert.equal((await api.saveDraft({ recordId: row.recordId, eventTime: null })).row.draft?.eventTime, null);
  assert.equal((await api.saveDraft({ recordId: row.recordId, eventTime: "12:34", clearEventTime: true })).row.draft?.eventTime, null);
});

test("同实例错误 expectedBaseRevision 拒绝覆盖，正式版不变", async () => {
  const api = new MemoryAdapter(); const { row } = await api.createDraft(fields);
  const before = await api.getRecord(row.recordId);
  await assert.rejects(api.commitRecord(row.recordId, 1), hasCode("REVISION_CONFLICT"));
  assert.deepEqual(await api.getRecord(row.recordId), before);
});

test("跨实例旧基线冲突保留原基线，重启后仍冲突，不按时间裁决", async () => {
  const saved = storage(), a = new MemoryAdapter({ storage: saved, now: () => "2099-01-01T00:00:00Z" });
  const { row } = await a.createDraft(fields);
  const b = new MemoryAdapter({ storage: saved, now: () => "2000-01-01T00:00:00Z" });
  await b.saveDraft({ recordId: row.recordId, body: "另一实例" });
  await b.commitRecord(row.recordId, 0);
  await assert.rejects(a.commitRecord(row.recordId, 0), hasCode("REVISION_CONFLICT"));
  const reopened = new MemoryAdapter({ storage: saved });
  const conflict = await reopened.getRecord(row.recordId);
  assert.equal(conflict.formal?.body, "另一实例"); assert.equal(conflict.draft?.body, fields.body);
  assert.equal(conflict.baseRevision, 0); assert.equal(conflict.contentRevision, 1);
  await assert.rejects(reopened.commitRecord(row.recordId, 1), hasCode("REVISION_CONFLICT"));
});

test("磁盘已有另一草稿时冲突不得覆盖磁盘，本地草稿保留", async () => {
  const saved = storage(), a = new MemoryAdapter({ storage: saved });
  const { row } = await a.createDraft(fields); const b = new MemoryAdapter({ storage: saved });
  await b.commitRecord(row.recordId, 0);
  await b.saveDraft({ recordId: row.recordId, body: "另一份草稿" });
  const before = saved.getItem("");
  await assert.rejects(a.commitRecord(row.recordId, 0), hasCode("REVISION_CONFLICT"));
  assert.equal(saved.getItem(""), before);
  // 重复提交仍使用 a 原先的基线与草稿。
  await assert.rejects(a.commitRecord(row.recordId, 0), hasCode("REVISION_CONFLICT"));
  assert.equal((await b.getRecord(row.recordId)).draft?.body, "另一份草稿");
});

test("照片 data URL、SHA、caption 与 photoUse 独立；移除及丢弃不删原图", async () => {
  const api = new MemoryAdapter(); const { row } = await api.createDraft({ eventDate: fields.eventDate });
  const input = { recordId: row.recordId, fileName: "s.bin", bytes: new Uint8Array([137, 80, 78, 71, 1]), caption: "第一张" };
  await api.attachPhotoBytes(input);
  const attached = await api.attachPhotoBytes({ ...input, caption: "第二张" });
  const [a, b] = attached.row.draft!.photos;
  assert.equal(a!.assetId, b!.assetId); assert.notEqual(a!.photoUseId, b!.photoUseId);
  assert.equal(a!.caption, "第一张"); assert.equal(b!.caption, "第二张");
  assert.equal(a!.sha256, createHash("sha256").update(input.bytes).digest("hex"));
  assert.equal(await api.photoDataUrl(a!.assetId), "data:image/png;base64,iVBORwE=");
  await api.commitRecord(row.recordId, 0); await api.createDraft({ baseRecordId: row.recordId });
  await api.removeDraftPhoto(row.recordId, a!.photoUseId);
  assert.equal((await api.getRecord(row.recordId)).formal?.photos.length, 2);
  assert.equal((await api.getRecord(row.recordId)).draft?.photos.length, 1);
  await assert.rejects(api.removeDraftPhoto(row.recordId, "missing"), hasCode("PHOTO_USE_NOT_FOUND"));
  await api.discardDraft(row.recordId); assert.ok(await api.photoDataUrl(a!.assetId));
  assert.equal((await api.getRecord(row.recordId)).draft, null);
});

test("照片错误校验与 8MB 预览上限，失败状态不变", async () => {
  const saved = storage(), api = new MemoryAdapter({ storage: saved }); const { row } = await api.createDraft(fields);
  const before = saved.getItem("");
  const input = { recordId: row.recordId, fileName: "s.png", caption: "", bytes: [1] };
  for (const name of ["../s.png", "a\\s.png", "C:s.png", ".", "..", "", "s\0.png"]) {
    await assert.rejects(api.attachPhotoBytes({ ...input, fileName: name }), hasCode("INVALID_ASSET_NAME"));
  }
  await assert.rejects(api.attachPhotoBytes({ ...input, bytes: [] }), hasCode("EMPTY_ASSET"));
  await assert.rejects(api.attachPhotoBytes({ ...input, bytes: [256] }), hasCode("INVALID_ASSET_BYTES"));
  await assert.rejects(api.attachPhotoBytes({ ...input, bytes: new Uint8Array(25 * 1024 * 1024 + 1) }), hasCode("ASSET_TOO_LARGE"));
  assert.equal(saved.getItem(""), before);
  const large = await api.attachPhotoBytes({ ...input, bytes: new Uint8Array(8 * 1024 * 1024 + 1) });
  await assert.rejects(api.photoDataUrl(large.row.draft!.photos[0]!.assetId), hasCode("PREVIEW_TOO_LARGE"));
  await assert.rejects(api.photoDataUrl("missing"), hasCode("ASSET_MISSING"));
});

test("故障只消费匹配操作下一次调用；uncertain 保留成功结果", async () => {
  const api = new MemoryAdapter(); api.failNext("IO_ERROR", "saveDraft");
  const { row } = await api.createDraft(fields);
  await assert.rejects(api.saveDraft({ recordId: row.recordId, body: "修改" }), hasCode("IO_ERROR"));
  assert.equal((await api.getRecord(row.recordId)).draft?.body, fields.body);
  api.durabilityMode = "uncertain";
  assert.equal((await api.saveDraft({ recordId: row.recordId, body: "修改" })).durability, "uncertain");
  assert.equal((await api.commitRecord(row.recordId, 0)).durability, "uncertain");
  assert.equal((await api.discardDraft(row.recordId)).durability, "uncertain");
});

test("storage 写失败不污染内存，坏文件不自动重置或覆盖", async () => {
  const saved = storage(); let broken = false;
  const api = new MemoryAdapter({ storage: { ...saved, setItem: (k, v) => { if (broken) throw new Error("合成 quota"); saved.setItem(k, v); } } });
  const { row } = await api.createDraft(fields), before = saved.getItem(""); broken = true;
  await assert.rejects(api.saveDraft({ recordId: row.recordId, body: "失败输入" }), hasCode("PERSIST_REPLACE_FAILED"));
  assert.equal(saved.getItem(""), before); assert.equal((await api.getRecord(row.recordId)).draft?.body, fields.body);
  saved.setItem("", "{broken");
  await assert.rejects(api.saveDraft({ recordId: row.recordId, body: "失败输入" }), hasCode("STATE_CORRUPT"));
  assert.equal(saved.getItem(""), "{broken");
  assert.throws(() => new MemoryAdapter({ storage: saved }), hasCode("STATE_CORRUPT"));
});

test("纯草稿丢弃删除行；浏览器导出明确报错", async () => {
  const api = new MemoryAdapter(); const { row } = await api.createDraft(fields);
  assert.equal((await api.discardDraft(row.recordId)).row, null);
  await assert.rejects(api.getRecord(row.recordId), hasCode("NOT_FOUND"));
  await assert.rejects(api.exportManifest("synthetic.json"), hasCode("IO_ERROR"));
});

test("纯 TS Base64 / SHA 与标准编码逐字节对齐", () => {
  for (const size of [0, 1, 2, 3, 55, 56, 63, 64, 65, 128, 1024]) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 37) % 256);
    assert.equal(base64(bytes), Buffer.from(bytes).toString("base64"));
    assert.equal(sha256(bytes), createHash("sha256").update(bytes).digest("hex"));
  }
});

test("Tauri 新命令参数、字节数组与清空时刻契约", async () => {
  const calls: unknown[] = [];
  const api = createTauriApi(async <T>(command: string, args?: Record<string, unknown>) => { calls.push([command, args]); return {} as T; });
  await api.listDrafts(); await api.createDraft(fields);
  await api.saveDraft({ recordId: "rec", eventTime: null });
  await api.attachPhotoBytes({ recordId: "rec", fileName: "s.png", bytes: new Uint8Array([0, 255]), caption: "合成" });
  await api.removeDraftPhoto("rec", "pu"); await api.discardDraft("rec"); await api.photoDataUrl("ast");
  assert.deepEqual(calls, [
    ["list_drafts", undefined], ["create_draft", { input: fields }],
    ["save_draft", { input: { recordId: "rec", eventTime: null, clearEventTime: true } }],
    ["attach_photo_bytes", { input: { recordId: "rec", fileName: "s.png", bytes: [0, 255], caption: "合成" } }],
    ["remove_draft_photo", { recordId: "rec", photoUseId: "pu" }], ["discard_draft", { recordId: "rec" }], ["photo_data_url", { assetId: "ast" }],
  ]);
});
