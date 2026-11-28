import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { StoryEditor } from "../src/domain/story-editor.ts";
import { storyPhotos } from "../src/domain/story.ts";
import { createTauriApi } from "../src/platform/tauri-adapter.ts";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { sha256 } from "../src/platform/bytes.ts";
import { pick, storage } from "./support/museum.ts";

const image = (id: string) => ({ fileName: "sample.png", bytes: new Uint8Array(readFileSync(new URL(
  `../core/tests/fixtures/v5/media/ast-${id}.png`, import.meta.url))), mediaType: "image/png" });
const mint = image("336cf1dd4efe5ef1"), other = image("5be0e93dd09a92cb");
async function setup() {
  const ram = storage(), key = "synthetic-photo-test";
  const open = () => new MemoryAdapter({ storage: ram, storageKey: key, search: "" });
  const api = open();
  const id = (await api.createDraft({ body: "before", eventDate: "2026-11-21" })).row.recordId;
  for (const caption of ["first", "second\r\ncaption"]) await api.attachPhotoBytes({ recordId: id, ...mint, caption });
  const shared = (await api.createDraft({ eventDate: "2026-11-20" })).row.recordId;
  await api.attachPhotoBytes({ recordId: shared, ...mint, caption: "independent" }); await api.commitRecord(shared, 0);
  const [a, b] = (await api.getRecord(id)).draft!.photos;
  const story = { coverPhotoUseId: b.photoUseId, blocks: [
    { kind: "photo" as const, photoUse: a }, { kind: "quote" as const, runs: [{ text: "between", bold: true, italic: true }] },
    { kind: "photo" as const, photoUse: b },
  ] };
  await api.saveDraft({ recordId: id, story }); await api.commitRecord(id, 0);
  const editor = new StoryEditor({ api, row: await api.getRecord(id), defaultDate: "2026-11-21", schedule: () => 0, cancel() {} });
  return { ram, key, open, api, id, a, b, editor, story, shared };
}

test("same-use replacement, move and history preserve typed order, independent captions and exact backup contents", async () => {
  const { api, open, editor, id, a, b, story, shared } = await setup();
  const prior = structuredClone(await api.getRecord(shared));
  await editor.replacePhoto(b.photoUseId, other);
  const split = await open().getRecord(id), next = storyPhotos(editor.story)[1];
  assert.deepEqual(split.formal!.story, story);
  assert.deepEqual(split.draft!.story, editor.story);
  assert.equal(next.photoUseId, b.photoUseId); assert.equal(next.caption, b.caption);
  assert.equal(next.sha256, sha256(other.bytes)); assert.equal(next.bytes, other.bytes.length); assert.notEqual(next.assetId, b.assetId);
  assert.equal(editor.story.coverPhotoUseId, b.photoUseId); assert.deepEqual(editor.story.blocks.slice(0, 2), story.blocks.slice(0, 2));
  assert.notDeepEqual(editor.photoRenderKey(next), editor.photoRenderKey(b));
  await api.exportBackup();
  const pkg = api.lastExportedPackage()!, target = new MemoryAdapter();
  await target.mergeBackup(await pick(target, pkg));
  assert.deepEqual(await target.getRecord(id), split);
  assert.equal((await target.mergeBackup(await pick(target, pkg))).plan.counts.conflictCopiesAdded, 0);
  assert.deepEqual(await target.getRecord(id), split);
  editor.undo(); await editor.flush(); assert.deepEqual((await open().getRecord(id)).draft!.story, story);
  await api.mediaReport(); editor.redo(); await editor.flush();
  assert.deepEqual(editor.story, split.draft!.story);
  await editor.movePhoto(b.photoUseId, 0);
  const ordered = structuredClone(editor.story);
  assert.deepEqual(ordered.blocks, [{ kind: "photo", photoUse: next }, { kind: "photo", photoUse: a }, story.blocks[1]]);
  assert.equal(ordered.coverPhotoUseId, b.photoUseId);
  assert.deepEqual((await open().getRecord(id)).draft!.story, ordered);
  await editor.commit(); await api.exportBackup();
  await target.restoreBackup(await pick(target, api.lastExportedPackage()!));
  assert.deepEqual((await target.getRecord(id)).formal!.story, ordered);
  assert.deepEqual(await target.getRecord(shared), prior);
  assert.deepEqual(Buffer.from((await target.photoDataUrl(next.assetId)).split(",")[1], "base64"), Buffer.from(other.bytes));
  assert.deepEqual(Buffer.from((await target.photoDataUrl(b.assetId)).split(",")[1], "base64"), Buffer.from(mint.bytes));
});

test("bad input, uncertain original, failed state save, corrupt reused bytes and stale comparison keep working history and saved bytes", async () => {
  const { ram, key, api, editor, id, b, story } = await setup();
  const original = ram.getItem(key);
  for (const bytes of [[], [-1], [NaN]]) {
    await assert.rejects(editor.replacePhoto(b.photoUseId, { ...other, bytes }));
    assert.deepEqual(editor.story, story); assert.equal(ram.getItem(key), original); assert.equal(editor.canUndo, false);
  }
  api.durabilityMode = "uncertain";
  await assert.rejects(editor.replacePhoto(b.photoUseId, other), { code: "MEDIA_STATE_WRITE_FAILED" });
  api.durabilityMode = "durable";
  ram.arm(); await assert.rejects(editor.replacePhoto(b.photoUseId, other), { code: "PERSIST_REPLACE_FAILED" });
  ram.arm(); await assert.rejects(editor.movePhoto(b.photoUseId, 0), { code: "PERSIST_REPLACE_FAILED" });
  assert.deepEqual(editor.story, story); assert.equal(ram.getItem(key), original); assert.equal(editor.canUndo, false);
  const stored = JSON.parse(original!);
  const hash = sha256(other.bytes), assetId = `ast-${hash.slice(0, 16)}`, bad = Buffer.from(other.bytes);
  bad[16] ^= 1;
  stored.assets[assetId] = { bytes: other.bytes.length, sha256: hash, dataUrl: "data:image/png;base64," + bad.toString("base64") };
  ram.setItem(key, JSON.stringify(stored)); const corrupt = ram.getItem(key);
  await assert.rejects(editor.replacePhoto(b.photoUseId, other), { code: "ASSET_CONFLICT" });
  assert.deepEqual(editor.story, story); assert.equal(ram.getItem(key), corrupt);
  await api.setDraftPhotoCaption(id, b.photoUseId, "newer caption");
  const concurrent = ram.getItem(key);
  await assert.rejects(editor.replacePhoto(b.photoUseId, mint), { code: "STORY_CHANGED" });
  assert.equal(editor.needsReload, true); assert.equal(ram.getItem(key), concurrent);
});

test("Tauri carries replacement bytes, expected layout and session-scoped history", async () => {
  const calls: unknown[] = [];
  const api = createTauriApi(async <T>(name: string, args?: unknown) => { calls.push([name, args]); return {} as T; });
  const base = { recordId: "r", photoUseId: "p", undoSession: "s", expectedStory: { blocks: [], coverPhotoUseId: null } };
  const source = { kind: "file" as const, fileName: "sample.png", bytes: Uint8Array.of(0, 255) };
  const history = { kind: "history" as const, assetId: "ast-336cf1dd4efe5ef1", sha256: sha256(mint.bytes), mediaType: "image/png" };
  await api.replaceDraftPhoto({ ...base, source }); await api.replaceDraftPhoto({ ...base, source: history });
  await api.releasePhotoHistory("r", "s");
  assert.deepEqual(calls, [
    ["replace_draft_photo", { input: { ...base, source: { ...source, bytes: [0, 255] } } }],
    ["replace_draft_photo", { input: { ...base, source: history } }],
    ["release_photo_history", { recordId: "r", undoSession: "s" }],
  ]);
});
