import test from "node:test";
import assert from "node:assert/strict";
import { DraftSession, recoverLastDraft } from "../src/domain/draft-session.ts";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import type { ShiguangApi, SaveResult, SaveDraftInput, CreateDraftInput } from "../src/platform/api.ts";
import type { CommitResult } from "../src/domain/types.ts";

class Scheduler {
  next = 0;
  jobs = new Map<number, { fn: () => void; ms: number }>();
  schedule = (fn: () => void, ms: number) => { const id = ++this.next; this.jobs.set(id, { fn, ms }); return id; };
  cancel = (id: number) => { this.jobs.delete(id); };
  run(): void { const jobs = [...this.jobs.values()]; this.jobs.clear(); for (const job of jobs) job.fn(); }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function override(api: MemoryAdapter, overrides: Partial<ShiguangApi>): ShiguangApi {
  return new Proxy(api, { get(target, key) {
    const value = Reflect.get(overrides, key) ?? Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
function setup(api: ShiguangApi = new MemoryAdapter(), debounceMs?: number) {
  const clock = new Scheduler();
  return { api, clock, session: new DraftSession({ api, schedule: clock.schedule, cancel: clock.cancel, debounceMs }) };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const fields = { body: "合成正文", eventDate: "2026-11-09" };
const hasCode = (code: string) => (error: unknown) => { assert.equal((error as { code: string }).code, code); return true; };

test("防抖合并所有字段，默认 800ms，首次只 create 一次", async () => {
  const memory = new MemoryAdapter(), calls: CreateDraftInput[] = [];
  const api = override(memory, { createDraft: async (input) => { calls.push(input); return memory.createDraft(input); } });
  const { session, clock } = setup(api);
  session.edit({ title: "标题" }); session.edit({ body: "正文" }); session.edit({ eventDate: fields.eventDate });
  assert.equal(clock.jobs.size, 1); assert.equal([...clock.jobs.values()][0]!.ms, 800);
  assert.equal(calls.length, 0); assert.equal(session.state.status, "dirty");
  clock.run(); await session.flush();
  assert.equal(calls.length, 1); assert.equal(calls[0]!.title, "标题"); assert.equal(calls[0]!.body, "正文");
  assert.equal(calls[0]!.eventDate, fields.eventDate); assert.equal(session.state.status, "saved");
  assert.ok(session.state.recordId); assert.ok(session.state.lastSavedAt); assert.equal(clock.jobs.size, 0);
  session.edit({ body: "第二次" }); await session.flush();
  assert.equal(calls.length, 1); assert.equal((await api.getRecord(session.state.recordId!)).draft?.body, "第二次");
});

test("保存期间排队只发最新值，旧响应不覆盖输入，同一时刻最多一个 save", async () => {
  const memory = new MemoryAdapter(), gate = deferred<SaveResult>();
  const row = (await memory.createDraft(fields)).row;
  const inputs: SaveDraftInput[] = []; let active = 0, maximum = 0;
  const api = override(memory, { saveDraft: async (input) => {
    inputs.push(input); active++; maximum = Math.max(maximum, active);
    try { if (inputs.length === 1) return await gate.promise; return await memory.saveDraft(input); }
    finally { active--; }
  } });
  const { session, clock } = setup(api); session.open(row); session.edit({ body: "第一版" });
  const flushing = session.flush(); await tick(); assert.equal(inputs.length, 1);
  session.edit({ title: "排队标题" }); session.edit({ body: "最终正文", eventTime: "12:34" });
  clock.run(); await tick(); assert.equal(inputs.length, 1); assert.equal(session.state.snapshot.body, "最终正文");
  gate.resolve(await memory.saveDraft(inputs[0]!)); await flushing; await session.flush();
  assert.equal(maximum, 1); assert.equal(inputs.length, 2);
  assert.equal(inputs[1]!.title, "排队标题"); assert.equal(inputs[1]!.body, "最终正文"); assert.equal(inputs[1]!.eventTime, "12:34");
  assert.equal(session.state.snapshot.body, "最终正文"); assert.equal(session.state.status, "saved");
});

test("首次 create 在途编辑排队，创建完成后用同一 ID 保存最新内容", async () => {
  const memory = new MemoryAdapter(), gate = deferred<SaveResult>(); let creates = 0;
  const api = override(memory, { createDraft: async () => { creates++; return gate.promise; } });
  const { session } = setup(api); session.edit({ title: "第一版" });
  const flushing = session.flush(); await tick(); session.edit(fields);
  gate.resolve(await memory.createDraft({ title: "第一版" })); await flushing;
  assert.equal(creates, 1); assert.equal((await memory.listDrafts()).length, 1);
  assert.equal((await memory.getRecord(session.state.recordId!)).draft?.body, fields.body);
});

test("保存失败保留所有输入，retry 成功；失败不会消耗 pending", async () => {
  const memory = new MemoryAdapter(); memory.failNext("PERSIST_REPLACE_FAILED", "createDraft");
  const { session, clock } = setup(memory); session.edit({ ...fields, title: "保留" });
  await assert.rejects(session.flush(), hasCode("PERSIST_REPLACE_FAILED"));
  assert.equal(session.state.status, "error"); assert.equal(session.state.lastError?.kind, "io");
  assert.equal(session.state.snapshot.body, fields.body); assert.equal(session.state.recordId, null); assert.equal(clock.jobs.size, 0);
  await session.retry(); assert.equal(session.state.status, "saved"); assert.equal(session.state.lastError, undefined);
  assert.equal((await memory.getRecord(session.state.recordId!)).draft?.title, "保留");
});

test("在途失败时保留新编辑，排队的自动 flush 不偷偷重试", async () => {
  const memory = new MemoryAdapter(), gate = deferred<SaveResult>(); let saves = 0;
  const row = (await memory.createDraft(fields)).row;
  const api = override(memory, { saveDraft: async (input) => { saves++; return saves === 1 ? gate.promise : memory.saveDraft(input); } });
  const { session, clock } = setup(api); session.open(row); session.edit({ body: "第一版" });
  const flushing = session.flush(); const rejected = assert.rejects(flushing, hasCode("IO_ERROR"));
  await tick(); session.edit({ title: "仍在输入", body: "最新输入" }); clock.run(); await tick();
  gate.reject({ code: "IO_ERROR", message: "合成失败" }); await rejected; await tick();
  assert.equal(saves, 1); assert.equal(session.state.status, "error"); assert.equal(session.state.snapshot.body, "最新输入");
  await session.retry(); assert.equal(saves, 2);
  assert.equal((await memory.getRecord(row.recordId)).draft?.title, "仍在输入");
});

test("自动保存失败通知 UI，显式 flush 仍拒绝，不吞错误", async () => {
  const memory = new MemoryAdapter(); const { session, clock } = setup(memory);
  const statuses: string[] = []; session.onChange((state) => statuses.push(state.status));
  memory.failNext("IO_ERROR", "createDraft"); session.edit(fields); clock.run(); await tick();
  assert.equal(session.state.status, "error"); assert.ok(statuses.includes("error"));
  memory.failNext("IO_ERROR", "createDraft"); await assert.rejects(session.flush(), hasCode("IO_ERROR"));
});

test("空白输入不落盘，清空已存在草稿仍必须保存", async () => {
  const { session, api, clock } = setup();
  session.edit({ title: "  ", body: "\n", eventTime: " " }); await session.flush();
  assert.equal(session.state.status, "idle"); assert.equal((await api.listDrafts()).length, 0);
  session.edit(fields); await session.flush(); const id = session.state.recordId!;
  session.edit({ title: "", body: "", eventDate: "", eventTime: null }); await session.flush();
  assert.equal((await api.getRecord(id)).draft?.body, ""); assert.equal(clock.jobs.size, 0);
});

test("flush 取消防抖，等待在途与所有最新编辑后才返回", async () => {
  const memory = new MemoryAdapter(), gate = deferred<SaveResult>(); let done = false;
  const api = override(memory, { createDraft: async () => gate.promise });
  const { session, clock } = setup(api, 1200); session.edit({ title: "待保存" });
  assert.equal([...clock.jobs.values()][0]!.ms, 1200);
  const flushing = session.flush().then(() => { done = true; }); await tick();
  assert.equal(clock.jobs.size, 0); assert.equal(done, false); session.edit(fields);
  gate.resolve(await memory.createDraft({ title: "待保存" })); await flushing;
  assert.equal(done, true); assert.equal((await memory.getRecord(session.state.recordId!)).draft?.body, fields.body);
});

test("前端提交校验先于 commit API，保留草稿并暴露 validation", async () => {
  const memory = new MemoryAdapter(); let commits = 0;
  const api = override(memory, { commitRecord: async () => { commits++; throw new Error("不应调用"); } });
  const { session } = setup(api); session.edit({ title: "只有标题", eventDate: fields.eventDate });
  await assert.rejects(session.commit(), hasCode("EMPTY_CONTENT"));
  assert.equal(commits, 0); assert.equal(session.state.lastError?.kind, "validation");
  assert.ok(session.state.recordId); assert.ok((await memory.getRecord(session.state.recordId!)).draft);
});

test("全空提交不会创建行，也不会调用 commit API", async () => {
  const { session, api } = setup(); await assert.rejects(session.commit(), hasCode("MISSING_EVENT_DATE"));
  assert.equal((await api.listDrafts()).length, 0); assert.equal(session.state.recordId, null);
});

test("commit 先 flush，再使用打开草稿的 baseRevision；冲突保留草稿且禁止重试", async () => {
  const memory = new MemoryAdapter(), calls: unknown[] = [];
  const initial = (await memory.createDraft(fields)).row; await memory.commitRecord(initial.recordId, 0);
  const row = (await memory.createDraft({ baseRecordId: initial.recordId })).row;
  const api = override(memory, {
    saveDraft: async (input) => { calls.push("save"); return memory.saveDraft(input); },
    commitRecord: async (id, base) => { calls.push([id, base]); throw { code: "REVISION_CONFLICT", message: "合成冲突" }; },
  });
  const { session, clock } = setup(api); session.open(row); session.edit({ body: "保留本地输入" });
  await assert.rejects(session.commit(), hasCode("REVISION_CONFLICT"));
  assert.deepEqual(calls, ["save", [row.recordId, 1]]); assert.equal(session.state.status, "conflict");
  assert.equal(session.state.snapshot.body, "保留本地输入"); assert.equal(session.state.lastError?.kind, "conflict");
  session.edit({ title: "冲突后继续输入" }); assert.equal(clock.jobs.size, 0); assert.equal(session.state.status, "conflict");
  await assert.rejects(session.retry(), hasCode("REVISION_CONFLICT"));
  await assert.rejects(session.flush(), hasCode("REVISION_CONFLICT"));
  await assert.rejects(session.commit(), hasCode("REVISION_CONFLICT"));
  assert.equal(calls.length, 2); assert.equal((await memory.getRecord(row.recordId)).formal?.body, fields.body);
});

test("保存响应不能把旧会话的基线悄悄提升为新正式版本", async () => {
  const memory = new MemoryAdapter(); const initial = (await memory.createDraft(fields)).row;
  const api = override(memory, { saveDraft: async (input) => {
    const result = await memory.saveDraft(input); result.row.baseRevision = 99; return result;
  } });
  const { session } = setup(api); session.open(initial); session.edit({ title: "合成修改" });
  await session.flush();
  // 若错误地采用响应中的 99，内存 core 会拒绝这次提交。
  assert.equal((await session.commit()).contentRevision, 1);
});

test("uncertain 保存和提交暴露给 UI，parentSyncUnsupported 视为已保存", async () => {
  const memory = new MemoryAdapter(); memory.durabilityMode = "uncertain";
  const { session } = setup(memory); session.edit(fields); await session.flush();
  assert.equal(session.state.status, "savedUncertain"); assert.equal(session.state.lastError?.kind, "durability");
  const committed = await session.commit(); assert.equal(committed.durability, "uncertain"); assert.equal(session.state.status, "savedUncertain");
  memory.durabilityMode = "parentSyncUnsupported"; session.edit({ body: "第二版" }); await session.flush();
  assert.equal(session.state.status, "saved"); assert.equal(session.state.lastError, undefined);
});

test("uncertain 显式 retry 再次写入，成功后更新状态", async () => {
  const memory = new MemoryAdapter(); memory.durabilityMode = "uncertain";
  const { session } = setup(memory); session.edit(fields); await session.flush(); memory.durabilityMode = "durable";
  await session.retry(); assert.equal(session.state.status, "saved"); assert.equal(session.state.lastError, undefined);
});

test("附图先 flush；附图期间编辑保留，后续自动保存不丢照片", async () => {
  const memory = new MemoryAdapter(), gate = deferred<SaveResult>(); const calls: string[] = [];
  const api = override(memory, {
    createDraft: async (input) => { calls.push("create"); return memory.createDraft(input); },
    attachPhotoBytes: async () => { calls.push("attach"); return gate.promise; },
  });
  const { session, clock } = setup(api); session.edit(fields);
  const attaching = session.attachPhoto({ fileName: "s.png", bytes: [1, 2, 3], caption: "合成图片" });
  await tick(); assert.deepEqual(calls, ["create", "attach"]);
  session.edit({ title: "附图期间输入" }); clock.run(); await tick();
  gate.resolve(await memory.attachPhotoBytes({ recordId: session.state.recordId!, fileName: "s.png", bytes: [1, 2, 3], caption: "合成图片" }));
  await attaching; await session.flush();
  const row = await memory.getRecord(session.state.recordId!);
  assert.equal(row.draft?.title, "附图期间输入"); assert.equal(row.draft?.photos.length, 1);
  await session.removePhoto(row.draft!.photos[0]!.photoUseId); assert.equal(session.state.snapshot.photos.length, 0);
});

test("照片可作为首个输入；附图失败保留已保存文字", async () => {
  const memory = new MemoryAdapter(), { session } = setup(memory);
  await session.attachPhoto({ fileName: "s.png", bytes: [1, 2, 3], caption: "合成" });
  assert.ok(session.state.recordId); assert.equal(session.state.snapshot.photos.length, 1);
  session.edit(fields); memory.failNext("ASSET_READ_FAILED", "attachPhotoBytes");
  await assert.rejects(session.attachPhoto({ fileName: "s.png", bytes: [4], caption: "失败" }), hasCode("ASSET_READ_FAILED"));
  assert.equal(session.state.snapshot.body, fields.body); assert.equal(session.state.snapshot.photos.length, 1);
  assert.equal(session.state.status, "error");
  assert.equal((await memory.getRecord(session.state.recordId!)).draft?.body, fields.body);
});

test("空照片和无效照片名不会在空会话创建空白草稿", async () => {
  const { session, api } = setup();
  await assert.rejects(session.attachPhoto({ fileName: "s.png", bytes: [], caption: "" }), hasCode("EMPTY_ASSET"));
  await assert.rejects(session.attachPhoto({ fileName: "../s.png", bytes: [1], caption: "" }), hasCode("INVALID_ASSET_NAME"));
  assert.equal(session.state.recordId, null); assert.equal((await api.listDrafts()).length, 0);
});

test("提交在途继续输入，已提交版本与下一份草稿分开，后续使用新基线", async () => {
  const memory = new MemoryAdapter(), gate = deferred<CommitResult>(); let commits = 0;
  const api = override(memory, { commitRecord: async (id, base) => { commits++; return commits === 1 ? gate.promise : memory.commitRecord(id, base); } });
  const { session, clock } = setup(api); session.edit(fields); const committing = session.commit(); await tick();
  const id = session.state.recordId!; session.edit({ body: "提交后继续写" }); clock.run();
  gate.resolve(await memory.commitRecord(id, 0)); await committing; await session.flush();
  const row = await memory.getRecord(id);
  assert.equal(row.formal?.body, fields.body); assert.equal(row.draft?.body, "提交后继续写"); assert.equal(row.baseRevision, 1);
  assert.equal((await session.commit()).contentRevision, 2);
});

test("订阅快照隔离，取消订阅有效；有未保存输入时拒绝直接切换", async () => {
  const { session } = setup(); let events = 0;
  const unsubscribe = session.onChange((state) => { events++; state.snapshot.body = "不可污染内部"; });
  session.edit(fields); assert.equal(session.state.snapshot.body, fields.body);
  assert.throws(() => session.open(null), hasCode("SESSION_BUSY"));
  const external = session.state; external.snapshot.title = "外部修改"; assert.equal(session.state.snapshot.title, "");
  await session.flush(); unsubscribe(); const before = events; session.open(null); assert.equal(events, before);
  assert.equal(session.state.status, "idle"); assert.equal(session.state.recordId, null);
});

test("恢复优先指定 ID，否则按 updatedAt 与 ID 降序；无草稿返回 null，错误透传", async () => {
  const memory = new MemoryAdapter(); assert.equal(await recoverLastDraft(memory), null);
  const a = (await memory.createDraft(fields)).row, b = (await memory.createDraft(fields)).row;
  a.updatedAt = "2099-01-01T00:00:00Z"; b.updatedAt = "2000-01-01T00:00:00Z";
  const api = override(memory, { listDrafts: async () => [b, a] });
  assert.equal((await recoverLastDraft(api, b.recordId))?.recordId, b.recordId);
  assert.equal((await recoverLastDraft(api, "missing"))?.recordId, a.recordId);
  assert.equal((await recoverLastDraft(api))?.recordId, a.recordId);
  b.updatedAt = a.updatedAt; assert.equal((await recoverLastDraft(api))?.recordId, b.recordId);
  const { session } = setup(api); session.open(await recoverLastDraft(api)); assert.equal(session.state.snapshot.body, fields.body);
  memory.failNext("IO_ERROR", "listDrafts"); await assert.rejects(recoverLastDraft(memory), hasCode("IO_ERROR"));
});

test("已有草稿 save 失败仍保留 recordId、所有字段并可 retry", async () => {
  const memory = new MemoryAdapter(), row = (await memory.createDraft(fields)).row;
  const { session } = setup(memory); session.open(row);
  memory.failNext("PERSIST_TEMP_SYNC_FAILED", "saveDraft");
  session.edit({ body: "失败仍保留的正文", title: "保留标题", eventTime: "12:34" });
  await assert.rejects(session.flush(), hasCode("PERSIST_TEMP_SYNC_FAILED"));
  assert.equal(session.state.recordId, row.recordId); assert.equal(session.state.snapshot.title, "保留标题");
  assert.equal((await memory.getRecord(row.recordId)).draft?.body, fields.body);
  await session.retry(); const saved = await memory.getRecord(row.recordId);
  assert.equal(saved.draft?.body, "失败仍保留的正文"); assert.equal(saved.draft?.eventTime, "12:34");
});

test("排队的 commit 遇前序保存失败立即拒绝，不自动重试或调用 commit API", async () => {
  const memory = new MemoryAdapter(), gate = deferred<SaveResult>(); let creates = 0, commits = 0;
  const api = override(memory, {
    createDraft: async () => { creates++; return gate.promise; },
    commitRecord: async () => { commits++; throw new Error("不应调用"); },
  });
  const { session } = setup(api); session.edit(fields);
  const saving = assert.rejects(session.flush(), hasCode("IO_ERROR")); await tick();
  const committing = assert.rejects(session.commit(), hasCode("IO_ERROR"));
  gate.reject({ code: "IO_ERROR", message: "合成失败" }); await saving; await committing;
  assert.equal(creates, 1); assert.equal(commits, 0); assert.equal(session.state.status, "error");
  assert.equal(session.state.snapshot.body, fields.body);
});

test("真实跨实例冲突经过会话仍保留本地正文，不覆盖另一正式版", async () => {
  let raw: string | null = null;
  const storage = { getItem: (_key: string) => raw, setItem: (_key: string, value: string) => { raw = value; } };
  const a = new MemoryAdapter({ storage }), b = new MemoryAdapter({ storage });
  const { session } = setup(a); session.edit(fields); await session.flush();
  const id = session.state.recordId!; await b.getRecord(id);
  await b.saveDraft({ recordId: id, body: "另一实例的正式正文" }); await b.commitRecord(id, 0);
  await assert.rejects(session.commit(), hasCode("REVISION_CONFLICT"));
  assert.equal(session.state.status, "conflict"); assert.equal(session.state.snapshot.body, fields.body);
  const disk = await b.getRecord(id);
  assert.equal(disk.formal?.body, "另一实例的正式正文"); assert.equal(disk.draft?.body, fields.body);
  assert.equal(disk.baseRevision, 0);
});
