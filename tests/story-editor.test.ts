import assert from "node:assert/strict";
import test from "node:test";
import { StoryEditor } from "../src/domain/story-editor.ts";
import { plainText, storyPhotos, toLegacy } from "../src/domain/story.ts";
import type { RecordRow } from "../src/domain/types.ts";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { createTauriApi } from "../src/platform/tauri-adapter.ts";

const today = "2026-11-25";
const image = { fileName: "synthetic.png", bytes: Uint8Array.of(137, 80, 78, 71, 1), mediaType: "image/png", caption: " 图\r\n" };
const refusal = { code: "STORY_SESSION_ONLY" };
function setup(api = new MemoryAdapter(), row: RecordRow | null = null) {
  let next = 0;
  const jobs = new Map<number, () => void>();
  const editor = new StoryEditor({ api, row, defaultDate: today,
    schedule: fn => { jobs.set(++next, fn); return next; }, cancel: id => { jobs.delete(id); } });
  return { editor, jobs, api };
}
async function saved(api: MemoryAdapter) {
  const { row } = await api.createDraft({ body: " 旧\r\n正文 ", eventDate: today, location: "原地" });
  for (const caption of [" 甲\r\n", "乙\n"]) await api.attachPhotoBytes({ recordId: row.recordId, ...image, caption });
  const photos = (await api.getRecord(row.recordId)).draft!.photos;
  await api.setDraftCover(row.recordId, photos[1].photoUseId);
  return (await api.getRecord(row.recordId));
}
test("new opens quick; mode, preview and accepting the prefilled date create no record", async () => {
  const { api, editor, jobs } = setup();
  assert.equal(editor.mode, "quick"); editor.editMeta({ eventDate: today }); editor.switchMode("story");
  editor.setPreview(true); await assert.rejects(editor.commit(), refusal); editor.setPreview(false);
  await editor.settle(); assert.equal(jobs.size, 0); assert.deepEqual(await api.listDrafts(), []);
  editor.quickBody("合成"); editor.undo(); await editor.flush(); assert.deepEqual(await api.listDrafts(), []);
});
test("autosave retains undo/redo and exact v5 bytes after typed, formatted and ordered edits", async () => {
  const api = new MemoryAdapter(), row = await saved(api), prior = structuredClone(row.draft!);
  const { editor, jobs } = setup(api, row); editor.switchMode("story");
  editor.text(0, " 旧\n正文 。"); await editor.flush(); assert.equal(jobs.size, 0);
  assert.equal((await api.getRecord(row.recordId)).draft!.body, prior.body + "。");
  editor.mark(0, 0, 2, "bold"); await assert.rejects(editor.flush(), refusal);
  editor.mark(0, 0, 2, "italic"); editor.undo(); editor.undo(); await editor.flush();
  editor.undo(); await editor.flush(); assert.deepEqual((await api.getRecord(row.recordId)).draft, prior);
  editor.redo(); editor.move(2, -1); await editor.flush();
  const now = (await api.getRecord(row.recordId)).draft!;
  assert.deepEqual(now.photos, [...prior.photos].reverse()); assert.equal(now.coverPhotoUseId, prior.coverPhotoUseId);
  editor.undo(); await editor.flush(); assert.deepEqual((await api.getRecord(row.recordId)).draft!.photos, prior.photos);
});
test("complex quick protects the whole document and publish, including after navigation or preview", async () => {
  const api = new MemoryAdapter(), row = await saved(api), { editor, jobs } = setup(api, row);
  editor.switchMode("story"); editor.insert(1, "quote"); editor.text(1, "仅在本次会话");
  const before = structuredClone(editor.story);
  editor.switchMode("quick");
  assert.ok(editor.protected); assert.ok(!editor.canUndo && !editor.canRedo);
  editor.quickBody("x"); editor.text(0, "x"); editor.editMeta({ title: "x", eventDate: "", location: "x", mood: "开心" });
  editor.move(1, 1); editor.remove(0); editor.cover(row.draft!.photos[0].photoUseId);
  editor.insertPhoto(0, image); editor.caption(row.draft!.photos[0].photoUseId, "x");
  editor.undo(); editor.redo(); await assert.rejects(editor.ensureTagRecord(), refusal);
  await assert.rejects(editor.flush(), refusal); await assert.rejects(editor.commit(), refusal);
  assert.deepEqual(editor.story, before); assert.equal(editor.meta.eventDate, today);
  assert.equal(jobs.size, 0); await editor.settle(); assert.deepEqual(await api.getRecord(row.recordId), row);
  editor.resume(); assert.equal(editor.mode, "story"); editor.remove(1);
  editor.switchMode("quick"); assert.equal(editor.protected, false);
  editor.quickBody("修改"); await editor.flush(); assert.equal((await api.getRecord(row.recordId)).draft!.body, "修改");
});
test("complex changes, including metadata and a contextual new photo, stay in RAM until simplified", async () => {
  const api = new MemoryAdapter(), row = await saved(api);
  await api.commitRecord(row.recordId, 0);
  const formal = await api.getRecord(row.recordId);
  const { editor } = setup(api, formal); editor.switchMode("story");
  editor.insert(1, "smallHeading"); editor.text(1, "插图"); editor.insertPhoto(2, image);
  editor.editMeta({ location: "新地点" }); editor.caption(row.draft!.photos[0].photoUseId, "新说明");
  const local = storyPhotos(editor.story)[0].photoUseId; editor.cover(local);
  await editor.settle(); assert.deepEqual(await api.getRecord(row.recordId), formal);
  editor.setPreview(true); assert.equal(plainText(editor.story), row.draft!.body + "\n插图");
  await assert.rejects(editor.commit(), refusal); editor.setPreview(false);
  editor.remove(1); assert.ok(editor.simple); await editor.flush();
  const draft = (await api.getRecord(row.recordId)).draft!;
  assert.notEqual(draft.photos[0].photoUseId, local); assert.equal(draft.coverPhotoUseId, draft.photos[0].photoUseId);
  assert.deepEqual(draft.photos.slice(1).map(p => p.photoUseId), row.draft!.photos.map(p => p.photoUseId));
  assert.deepEqual({ ...draft, ...toLegacy(editor.story) }, draft);
  assert.equal(draft.photos[0].caption, image.caption); assert.equal(draft.photos[1].caption, "新说明");
  assert.equal(draft.location, "新地点"); assert.equal(draft.body, row.draft!.body);
  assert.deepEqual((await api.getRecord(row.recordId)).formal, formal.formal);
  const result = await editor.commit(); assert.equal(result.contentRevision, 2);
  assert.deepEqual((await api.getRecord(row.recordId)).formal, draft); assert.equal((await api.getRecord(row.recordId)).draft, null);
});
test("undo/redo persisted insertion and deletion restore the same occurrence, caption, order and cover", async () => {
  const api = new MemoryAdapter(), row = await saved(api); await api.commitRecord(row.recordId, 0);
  const formal = await api.getRecord(row.recordId), { editor } = setup(api, formal); editor.switchMode("story");
  editor.remove(2); await editor.flush(); // first edit of a formal-only row is an unlink
  assert.equal((await api.getRecord(row.recordId)).draft!.coverPhotoUseId, formal.formal!.photos[0].photoUseId);
  editor.undo(); await editor.flush(); assert.deepEqual((await api.getRecord(row.recordId)).draft, formal.formal);
  editor.redo(); await editor.flush(); editor.insertPhoto(1, image); await editor.flush();
  const inserted = (await api.getRecord(row.recordId)).draft!;
  editor.undo(); await editor.flush(); assert.equal((await api.getRecord(row.recordId)).draft!.photos.length, 1);
  editor.redo(); await editor.flush(); assert.deepEqual((await api.getRecord(row.recordId)).draft, inserted);
  assert.deepEqual((await api.getRecord(row.recordId)).formal, formal.formal);
});
test("complex transition during an in-flight simple save cannot send a scalar projection or lose newer input", async t => {
  const api = new MemoryAdapter(), row = await saved(api), { editor } = setup(api, row);
  const save = api.saveDraft.bind(api);
  let signal!: () => void, release!: () => void;
  const sent = new Promise<void>(resolve => { signal = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const spy = t.mock.method(api, "saveDraft", async (input: Parameters<typeof save>[0]) => {
    signal(); await resume; return save(input);
  });
  editor.quickBody("已发出的普通文字"); const flush = editor.flush(); await sent;
  editor.switchMode("story"); editor.insert(0, "divider"); editor.editMeta({ title: "内存标题" });
  editor.text(1, "未保存的内文"); release(); await flush; await editor.settle();
  assert.equal(spy.mock.callCount(), 1); assert.equal((await api.getRecord(row.recordId)).draft!.body, "已发出的普通文字");
  assert.equal((await api.getRecord(row.recordId)).draft!.title, row.draft!.title);
  assert.equal(plainText(editor.story), "未保存的内文");
  editor.remove(0); await editor.flush(); assert.equal(spy.mock.callCount(), 2);
});
test("failed durable photo operation retains the working story and a retry is idempotent", async () => {
  const api = new MemoryAdapter(), row = await saved(api), { editor } = setup(api, row);
  editor.caption(row.draft!.photos[1].photoUseId, "复核");
  api.failNext("DISK_FULL", "setDraftPhotoCaption"); await assert.rejects(editor.flush(), { code: "DISK_FULL" });
  assert.equal(editor.saveState.status, "error"); assert.equal((await api.getRecord(row.recordId)).draft!.photos[1].caption, "乙\n");
  await editor.flush(); assert.equal((await api.getRecord(row.recordId)).draft!.photos[1].caption, "复核");
  editor.undo(); await editor.flush(); assert.deepEqual((await api.getRecord(row.recordId)).draft, row.draft);
});
test("late formal publication still uses the revision observed when Edit opened", async () => {
  const api = new MemoryAdapter(), row = await saved(api); await api.commitRecord(row.recordId, 0);
  const { editor } = setup(api, await api.getRecord(row.recordId));
  await api.saveDraft({ recordId: row.recordId, body: "另一次正式修订" }); await api.commitRecord(row.recordId, 1);
  editor.quickBody("本次草稿"); await assert.rejects(editor.commit(), { code: "REVISION_CONFLICT" });
  assert.equal((await api.getRecord(row.recordId)).formal!.body, "另一次正式修订");
  assert.equal(editor.saveState.status, "conflict");
});
test("native undo sends only an editor token and the occurrence ID over the existing unlink command", async () => {
  const calls: unknown[] = [];
  const api = createTauriApi(async <T>(name: string, args?: unknown) => { calls.push([name, args]); return {} as T; });
  await api.removeDraftPhoto("record", "use"); await api.removeDraftPhoto("record", "use", "editor", true);
  assert.deepEqual(calls, [
    ["remove_draft_photo", { recordId: "record", photoUseId: "use" }],
    ["remove_draft_photo", { recordId: "record", photoUseId: "use", undoSession: "editor", undo: true }],
  ]);
});

test("later scalar acknowledgements keep uncertain durability from the same photo save visible", async t => {
  const api = new MemoryAdapter(), { editor } = setup(api);
  const attach = api.attachPhotoBytes.bind(api);
  t.mock.method(api, "attachPhotoBytes", async (input: Parameters<typeof attach>[0]) => ({ ...await attach(input), durability: "uncertain" }));
  editor.insertPhoto(0, image); editor.editMeta({ title: "合成照片" }); await editor.flush();
  assert.equal((await api.listDrafts())[0].draft!.title, "合成照片"); assert.equal(editor.saveState.status, "savedUncertain");
});

test("simplifying a parked story preserves a newer saved draft's photo, caption and cover", async () => {
  const api = new MemoryAdapter(), row = await saved(api), { editor } = setup(api, row);
  editor.switchMode("story"); editor.insert(1, "divider"); editor.editMeta({ title: "本次编辑" });
  await api.attachPhotoBytes({ ...image, recordId: row.recordId, caption: "别处的新使用位" });
  const current = (await api.getRecord(row.recordId)).draft!;
  editor.remove(1); await assert.rejects(editor.flush(), /照片/); assert.equal(editor.needsReload, true);
  await assert.rejects(editor.commit(), /核对/);
  assert.deepEqual((await api.getRecord(row.recordId)).draft, current); assert.equal(editor.meta.title, "本次编辑");
  await editor.settle();
});
