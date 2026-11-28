import assert from "node:assert/strict";
import test from "node:test";
import { StoryEditor } from "../src/domain/story-editor.ts";
import { plainText, storyPhotos, toLegacy } from "../src/domain/story.ts";
import type { RecordRow } from "../src/domain/types.ts";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { createTauriApi } from "../src/platform/tauri-adapter.ts";

const today = "2026-11-25";
const image = { fileName: "synthetic.png", bytes: Uint8Array.of(137, 80, 78, 71, 1), mediaType: "image/png", caption: " 图\r\n" };
const refusal = { code: "EDITOR_READ_ONLY" };
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
test("autosave retains undo/redo and exact legacy text and photo identity after typed, formatted and ordered edits", async () => {
  const api = new MemoryAdapter(), row = await saved(api), prior = structuredClone(row.draft!);
  const { editor, jobs } = setup(api, row); editor.switchMode("story");
  editor.text(0, " 旧\n正文 。"); await editor.flush(); assert.equal(jobs.size, 0);
  assert.equal((await api.getRecord(row.recordId)).draft!.body, prior.body + "。");
  editor.mark(0, 0, 2, "bold"); await editor.flush();
  assert.deepEqual((await api.getRecord(row.recordId)).draft!.story, editor.story);
  editor.mark(0, 0, 2, "italic"); editor.undo(); editor.undo(); await editor.flush();
  editor.undo(); await editor.flush(); assert.deepEqual((await api.getRecord(row.recordId)).draft, prior);
  editor.redo(); editor.move(2, -1); await editor.flush();
  const now = (await api.getRecord(row.recordId)).draft!;
  assert.deepEqual(now.photos, [...prior.photos].reverse()); assert.equal(now.coverPhotoUseId, prior.coverPhotoUseId);
  editor.undo(); await editor.flush(); assert.deepEqual((await api.getRecord(row.recordId)).draft!.photos, prior.photos);
});
test("complex quick protects the whole document and publish, including after navigation or preview", async () => {
  const api = new MemoryAdapter(), row = await saved(api), { editor, jobs } = setup(api, row);
  editor.switchMode("story"); editor.insert(1, "quote"); editor.text(1, "合成引用");
  const before = structuredClone(editor.story);
  editor.switchMode("quick");
  assert.ok(editor.protected); assert.ok(!editor.canUndo && !editor.canRedo);
  editor.quickBody("x"); editor.text(0, "x"); editor.editMeta({ title: "x", eventDate: "", location: "x", mood: "开心" });
  editor.move(1, 1); editor.remove(0); editor.cover(row.draft!.photos[0].photoUseId);
  editor.insertPhoto(0, image); editor.caption(row.draft!.photos[0].photoUseId, "x");
  editor.undo(); editor.redo(); await assert.rejects(editor.ensureTagRecord(), refusal);
  await editor.flush(); await assert.rejects(editor.commit(), refusal);
  assert.deepEqual(editor.story, before); assert.equal(editor.meta.eventDate, today);
  assert.equal(jobs.size, 0); await editor.settle();
  const current = await api.getRecord(row.recordId);
  assert.deepEqual(current.draft!.story, before); assert.equal(current.draft!.title, row.draft!.title);
  assert.equal(current.draft!.location, row.draft!.location); assert.deepEqual(current.formal, row.formal);
  editor.resume(); assert.equal(editor.mode, "story"); editor.remove(1);
  editor.switchMode("quick"); assert.equal(editor.protected, false);
  editor.quickBody("修改"); await editor.flush(); assert.equal((await api.getRecord(row.recordId)).draft!.body, "修改");
});
test("complex changes, including metadata and a contextual new photo, survive draft saves before and after simplification", async () => {
  const api = new MemoryAdapter(), row = await saved(api);
  await api.commitRecord(row.recordId, 0);
  const formal = await api.getRecord(row.recordId);
  const { editor } = setup(api, formal); editor.switchMode("story");
  editor.insert(1, "smallHeading"); editor.text(1, "插图"); editor.insertPhoto(2, image);
  editor.editMeta({ location: "新地点" }); editor.caption(row.draft!.photos[0].photoUseId, "新说明");
  const local = storyPhotos(editor.story)[0].photoUseId; editor.cover(local);
  await editor.settle();
  const persisted = await api.getRecord(row.recordId);
  assert.deepEqual(persisted.draft!.story, editor.story); assert.deepEqual(persisted.formal, formal.formal);
  assert.equal(persisted.draftMode, "story"); assert.equal(persisted.draft!.location, "新地点");
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
  assert.equal(spy.mock.callCount(), 2);
  for (const call of spy.mock.calls) { assert.ok(call.arguments[0].story); assert.equal(call.arguments[0].body, undefined); }
  const acknowledged = (await api.getRecord(row.recordId)).draft!;
  assert.deepEqual(acknowledged.story, editor.story); assert.equal(acknowledged.title, "内存标题");
  assert.equal(plainText(editor.story), "未保存的内文");
  editor.remove(0); await editor.flush(); assert.equal(spy.mock.callCount(), 3);
});
test("failed durable photo operation retains the working story and a retry is idempotent", async () => {
  const api = new MemoryAdapter(), row = await saved(api), { editor } = setup(api, row);
  editor.caption(row.draft!.photos[1].photoUseId, "复核");
  api.failNext("DISK_FULL", "saveDraft"); await assert.rejects(editor.flush(), { code: "DISK_FULL" });
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

test("ordered story survives a fresh editor, publication, preview backup restore, repeated merge and re-export", async () => {
  const { storage, pick } = await import("./support/museum.ts");
  const saved = storage(), storageKey = "schema6-synthetic";
  const reopen = () => new MemoryAdapter({ storage: saved, storageKey });
  const api = reopen(), { editor } = setup(api);
  editor.switchMode("story");
  editor.insert(0, "smallHeading"); editor.text(0, "Heading"); editor.mark(0, 0, 7, "bold"); editor.mark(0, 0, 7, "italic");
  editor.insert(1, "paragraph"); editor.text(1, "First paragraph");
  editor.insertPhoto(2, { ...image, caption: "one" });
  editor.insert(3, "quote"); editor.text(3, "<quote>");
  editor.insert(4, "divider"); editor.insertPhoto(5, { ...image, caption: " second\r\n " });
  editor.insert(6, "paragraph"); editor.text(6, "After photo");
  editor.cover(storyPhotos(editor.story)[1].photoUseId);
  await editor.flush();
  const story = structuredClone(editor.story), id = editor.recordId!;
  const photos = storyPhotos(story); assert.equal(photos[0].assetId, photos[1].assetId);
  assert.notEqual(photos[0].photoUseId, photos[1].photoUseId); assert.equal(story.coverPhotoUseId, photos[1].photoUseId);
  assert.deepEqual(story.blocks[0], { kind: "smallHeading", runs: [{ text: "Heading", bold: true, italic: true }] });
  const disk = JSON.parse(saved.getItem(storageKey)!);
  assert.equal(disk.version, 2); assert.equal(disk.schemaVersion, 6);
  assert.deepEqual(disk.records[0].draft.story, story);
  for (const key of ["body", "photos", "coverPhotoUseId"]) assert.ok(!(key in disk.records[0].draft));
  const fresh = reopen(), draft = await fresh.getRecord(id);
  const { editor: continued } = setup(fresh, draft);
  assert.equal(continued.mode, "story"); assert.deepEqual(continued.story, story); assert.equal(draft.formal, null);
  assert.equal((await continued.commit()).contentRevision, 1);
  assert.deepEqual((await reopen().getRecord(id)).formal!.story, story);
  const committed = saved.getItem(storageKey);
  await assert.rejects(fresh.saveDraft({ recordId: id, body: "flatten" }), { code: "STORY_COMPLEX" });
  await assert.rejects(fresh.saveDraft({ recordId: id, expectedStory: { blocks: [], coverPhotoUseId: null }, story }), { code: "STORY_CHANGED" });
  assert.equal(saved.getItem(storageKey), committed);
  const exported = await fresh.exportBackup();
  assert.ok(!exported.cancelled); assert.equal(exported.summary.schemaVersion, 6);
  const pkg = fresh.lastExportedPackage()!;
  const dest = storage(), target = new MemoryAdapter({ storage: dest, storageKey });
  await target.createDraft({ body: "unrelated local draft" });
  await target.restoreBackup(await pick(target, pkg));
  for (let i = 0; i < 2; i++) {
    const before = dest.getItem(storageKey);
    assert.equal((await target.mergeBackup(await pick(target, pkg))).plan.counts.conflictCopiesAdded, 0);
    if (i === 1) assert.equal(dest.getItem(storageKey), before);
    assert.deepEqual((await target.getRecord(id)).formal!.story, story);
  }
  await target.exportBackup();
  const restored = new MemoryAdapter();
  await restored.restoreBackup(await pick(restored, target.lastExportedPackage()!));
  const result = await restored.getRecord(id);
  assert.deepEqual(result.formal, (await fresh.getRecord(id)).formal); assert.equal(result.draft, null);
  assert.equal(await restored.photoDataUrl(photos[1].assetId), await fresh.photoDataUrl(photos[0].assetId));
});

test("Tauri draft and editor photo commands carry typed story and comparison operands intact", async () => {
  const calls: unknown[] = [];
  const api = createTauriApi(async <T>(name: string, args?: unknown) => { calls.push([name, args]); return {} as T; });
  const story = { blocks: [{ kind: "divider" as const }], coverPhotoUseId: null };
  const expectedStory = { blocks: [], coverPhotoUseId: null };
  await api.createDraft({ story, editorMode: "story" });
  await api.saveDraft({ recordId: "r", expectedStory, story, editorMode: "story" });
  await api.attachPhotoBytes({ recordId: "r", ...image, expectedStory });
  await api.removeDraftPhoto("r", "p", "session", false, expectedStory);
  assert.deepEqual(calls, [
    ["create_draft", { input: { story, editorMode: "story" } }],
    ["save_draft", { input: { recordId: "r", expectedStory, story, editorMode: "story", clearEventTime: false } }],
    ["attach_photo_bytes", { input: { recordId: "r", ...image, bytes: [...image.bytes], expectedStory } }],
    ["remove_draft_photo", { recordId: "r", photoUseId: "p", undoSession: "session", undo: false, expectedStory }],
  ]);
});
