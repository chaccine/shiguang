import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { bootDom, until } from "./support/boot-dom.ts";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { PREVIEW_STORAGE_KEY } from "../src/ui/demo.ts";

type DomNode = ReturnType<ReturnType<typeof bootDom>["id"]>;
const input = (field: DomNode, value: string) => { field.value = value; field.setSelectionRange(value.length, value.length); field.fire("input"); };
function setup(t: TestContext) {
  const dom = bootDom();
  const api = new MemoryAdapter({ storage: dom.storage, storageKey: PREVIEW_STORAGE_KEY, search: "" });
  t.after(dom.restore);
  const blocks = () => dom.id("story-blocks").querySelectorAll('[data-testid="story-block"]');
  const insert = (gap: number, value: string) => {
    const control = dom.id("story-blocks").querySelectorAll('[data-testid="story-insert"]')[gap];
    control.value = value; control.fire("change");
  };
  const button = (id: string) => dom.byTest(id).fire("click");
  const load = async () => {
    await import(new URL(`../src/ui/main.ts?story=${encodeURIComponent(t.name)}`, import.meta.url).href);
    await until(() => dom.body.dataset.appReady === "1");
  };
  const editFormal = async () => {
    dom.id("timeline-list").querySelector('[data-testid="edit-button"]')!.fire("click");
    await until(() => dom.id("view-reading").visible); button("reading-edit");
  };
  return { ...dom, api, blocks, insert, button, load, editFormal };
}

test("new record, calendar default, empty preview and opening the tag dialog create no draft", async t => {
  const ui = setup(t); await ui.load(); ui.button("create-tab"); await until(() => ui.id("view-editor").visible);
  assert.equal(ui.byTest("mode-quick").getAttribute("aria-pressed"), "true");
  assert.ok(ui.byTest("editor-date").value); ui.byTest("editor-date").fire("input");
  ui.button("editor-tag-add"); await until(() => ui.id("tag-picker-dialog").open); ui.button("tag-picker-cancel");
  ui.button("mode-story"); ui.button("draft-preview-open");
  assert.equal(ui.byTest("draft-preview-content").visible, true); assert.equal(ui.byTest("commit-button").visible, false);
  ui.button("commit-button"); ui.button("draft-preview-back"); ui.button("calendar-tab");
  await until(() => ui.id("view-calendar").visible); ui.button("cal-empty-write"); await until(() => ui.id("view-editor").visible);
  ui.byTest("editor-date").fire("input"); ui.button("back-to-drafts"); await until(() => ui.id("view-drafts").visible);
  assert.deepEqual(await ui.api.listDrafts(), []); assert.deepEqual(await ui.api.listFormalRecords(), []);
});

test("real controls group Chinese composition into one undo, survive autosave, and restore selection and scroll after preview", async t => {
  const ui = setup(t); await ui.load(); ui.button("create-tab"); await until(() => ui.id("view-editor").visible);
  ui.button("mode-story"); ui.insert(0, "paragraph");
  const field = ui.blocks()[0].querySelector("textarea")!;
  field.fire("compositionstart"); input(field, "n"); input(field, "ni"); input(field, "你好");
  ui.setHidden(true); ui.setHidden(false); assert.deepEqual(await ui.api.listDrafts(), []);
  field.fire("compositionend"); field.fire("input");
  ui.setHidden(true); ui.setHidden(false); await until(() => ui.byTest("save-status").visibleText().includes("已自动保存"));
  ui.button("story-undo"); assert.equal(field.value, ""); ui.button("story-redo"); assert.equal(field.value, "你好");
  field.setSelectionRange(0, 1); field.fire("select"); ui.blocks()[0].querySelector('[data-testid="story-bold"]')!.fire("click");
  assert.equal(ui.byTest("commit-button").disabled, true); assert.equal(ui.id("story-limit").visible, true);
  field.focus(); ui.id("view-editor").fire("focusin", { target: field }); field.scrollTop = 7;
  ui.id("main-content").scrollTop = 290; window.scrollTo(0, 117); ui.button("draft-preview-open");
  assert.equal(ui.byTest("draft-preview-content").querySelector("strong")!.visibleText(), "你");
  assert.equal(ui.byTest("commit-button").visible, false); ui.button("commit-button");
  ui.history.back(); await until(() => ui.byTest("draft-preview-open").visible);
  assert.equal(ui.active(), field); assert.deepEqual([field.selectionStart, field.selectionEnd, field.scrollTop], [0, 1, 7]);
  assert.equal(ui.id("main-content").scrollTop, 290); assert.equal(window.scrollY, 117);
  ui.button("story-undo"); ui.button("mode-quick"); assert.equal(ui.byTest("editor-body").value, "你好");
  ui.button("mode-story"); ui.button("back-to-drafts"); await until(() => ui.id("view-drafts").visible && !!ui.findTest("draft-item"));
  ui.button("draft-item"); await until(() => ui.id("view-editor").visible);
  assert.equal(ui.byTest("mode-story").getAttribute("aria-pressed"), "true");
  assert.deepEqual(await ui.api.listFormalRecords(), []);
});

test("complex formal edit protects tags, fields, photo actions and publish in quick; preview, parking and simplification preserve the separate saved draft", async t => {
  const ui = setup(t), api = ui.api;
  const id = (await api.createDraft({ eventDate: "2026-11-09", body: "正式\r\n内文", title: "合成记录" })).row.recordId;
  for (const caption of ["一", "二"]) await api.attachPhotoBytes({ recordId: id, fileName: "sample.png", bytes: Uint8Array.of(1, 2), caption });
  const photos = (await api.getRecord(id)).draft!.photos;
  await api.setDraftCover(id, photos[1].photoUseId); await api.commitRecord(id, 0);
  const formal = (await api.getRecord(id)).formal!;
  await ui.load(); await ui.editFormal(); await until(() => ui.id("view-editor").visible);
  assert.equal((await api.getRecord(id)).draft, null);
  input(ui.byTest("editor-location"), "已存草稿"); ui.setHidden(true); ui.setHidden(false);
  await until(() => ui.byTest("save-status").visibleText().includes("已自动保存"));
  const baseline = ui.storage.getItem(PREVIEW_STORAGE_KEY);
  ui.button("mode-story"); ui.insert(2, "quote"); input(ui.blocks()[2].querySelector("textarea")!, "<em>合成引用</em>");
  input(ui.byTest("editor-title"), "内存标题");
  ui.blocks()[2].querySelector('[data-testid="story-down"]')!.fire("click");
  ui.button("mode-quick");
  assert.equal(ui.id("editor-fields").disabled, true); assert.equal(ui.byTest("enter-story").visibleText(), "进入故事编辑");
  assert.equal(ui.byTest("commit-button").disabled, true); assert.equal(ui.byTest("editor-tag-add").disabled, true);
  // Also dispatch handlers directly, as the synthetic DOM doesn't suppress disabled events.
  for (const control of ["editor-title", "editor-date", "editor-time", "editor-location"]) input(ui.byTest(control), "禁止修改");
  ui.byTest("editor-mood").value = "难过"; ui.byTest("editor-mood").fire("change");
  ui.button("editor-tag-add"); ui.button("commit-button"); ui.button("story-undo"); ui.button("draft-preview-open");
  const first = ui.blocks()[1];
  first.querySelector('[data-testid="photo-cover"]')!.fire("click"); first.querySelector('[data-testid="photo-down"]')!.fire("click");
  input(first.querySelector("textarea")!, "禁止修改"); first.querySelector(".photo-remove")!.fire("click");
  assert.equal(ui.id("tag-picker-dialog").open, false); assert.equal(ui.id("confirm-dialog").open, false);
  ui.setHidden(true); ui.setHidden(false); assert.equal(ui.storage.getItem(PREVIEW_STORAGE_KEY), baseline);
  ui.button("enter-story"); assert.equal(ui.byTest("editor-title").value, "内存标题");
  assert.equal(ui.byTest("editor-date").value, formal.eventDate); assert.equal(ui.byTest("editor-mood").value, "");
  assert.equal(ui.byTest("editor-time").value, ""); assert.equal(ui.byTest("editor-location").value, "已存草稿");
  assert.equal(ui.blocks()[1].querySelector("textarea")!.value, "一");
  ui.button("draft-preview-open"); const preview = ui.byTest("draft-preview-content");
  assert.deepEqual(preview.children.map(n => n.tag), ["h1", "p", "figure", "p", "figure", "figure", "blockquote"]);
  assert.deepEqual(preview.querySelectorAll("figure").map(n => n.dataset.photoId), [photos[1], ...photos].map(p => p.photoUseId));
  assert.equal(preview.querySelector("blockquote")!.textContent, "<em>合成引用</em>");
  assert.equal(preview.querySelector("em"), null); ui.button("draft-preview-back");
  ui.button("back-to-drafts"); await until(() => ui.id("view-reading").visible);
  assert.equal(ui.byTest("reading-content").querySelector("blockquote"), null);
  assert.equal(ui.byTest("reading-content").querySelector("h1")!.textContent, formal.title);
  ui.button("reading-edit"); await until(() => ui.id("choose-draft").open); ui.button("choose-cancel");
  assert.equal(ui.id("view-reading").visible, true);
  ui.button("reading-edit"); await until(() => ui.id("choose-draft").open); ui.button("choose-continue"); await until(() => ui.id("view-editor").visible);
  assert.equal(ui.byTest("mode-story").getAttribute("aria-pressed"), "true");
  assert.equal(ui.blocks()[3].querySelector("textarea")!.value, "<em>合成引用</em>");
  ui.blocks()[3].querySelector('[data-testid="story-remove"]')!.fire("click"); ui.button("confirm-cancel"); await Promise.resolve();
  assert.equal(ui.blocks().length, 4); ui.blocks()[3].querySelector('[data-testid="story-remove"]')!.fire("click"); ui.button("confirm-ok");
  await until(() => ui.blocks().length === 3); ui.button("mode-quick");
  assert.equal(ui.id("editor-fields").disabled, false); ui.button("commit-button"); await until(() => ui.id("view-reading").visible);
  const changed = await api.getRecord(id);
  assert.equal(changed.contentRevision, 2); assert.equal(changed.draft, null);
  assert.deepEqual(changed.formal, { ...formal, title: "内存标题", location: "已存草稿" });
});

test("formal Edit offers continue, restart with confirmation, or cancel; untouched restart creates no draft", async t => {
  const ui = setup(t), api = ui.api, id = (await api.createDraft({ eventDate: "2024-11-12", body: "正式" })).row.recordId;
  await api.commitRecord(id, 0); await api.saveDraft({ recordId: id, body: "已有草稿" }); await ui.load(); await ui.editFormal();
  await until(() => ui.id("choose-draft").open); ui.button("choose-restart"); await until(() => ui.id("confirm-dialog").open);
  ui.button("confirm-cancel"); assert.equal((await api.getRecord(id)).draft!.body, "已有草稿");
  ui.button("reading-edit"); await until(() => ui.id("choose-draft").open); ui.button("choose-restart"); await until(() => ui.id("confirm-dialog").open);
  ui.button("confirm-ok"); await until(() => ui.id("view-editor").visible);
  assert.equal(ui.byTest("editor-body").value, "正式"); assert.equal((await api.getRecord(id)).draft, null);
});

test("new interleaved photo stays in the session draft box; simplification binds the actual original without interrupting caption composition", async t => {
  const ui = setup(t), picker = ui.byTest("photo-input");
  const bytes = Uint8Array.of(137, 80, 78, 71, 7), file = new File([bytes], "synthetic.png", { type: "image/png" });
  let opened = false, started = false, release!: () => void;
  Object.assign(picker, { files: [file], click: () => { opened = true; } });
  const ack = new Promise<void>(resolve => { release = resolve; });
  const attach = MemoryAdapter.prototype.attachPhotoBytes;
  t.mock.method(MemoryAdapter.prototype, "attachPhotoBytes", async function(this: MemoryAdapter, request: Parameters<typeof attach>[0]) {
    started = true; await ack; return attach.call(this, request);
  });
  await ui.load(); ui.button("create-tab"); await until(() => ui.id("view-editor").visible);
  ui.button("mode-story"); ui.insert(0, "smallHeading"); input(ui.blocks()[0].querySelector("textarea")!, "合成标题");
  ui.insert(1, "photo"); assert.ok(opened); picker.fire("change"); await until(() => ui.blocks().length === 2);
  input(ui.blocks()[1].querySelector("textarea")!, "旧说明");
  ui.button("draft-preview-open"); assert.equal(ui.byTest("draft-preview-content").querySelector("figcaption")!.textContent, "旧说明");
  ui.button("draft-preview-back"); ui.button("back-to-drafts"); await until(() => ui.id("view-drafts").visible);
  assert.deepEqual(await ui.api.listDrafts(), []); assert.equal(started, false);
  ui.button("session-draft"); await until(() => ui.id("view-editor").visible); assert.equal(ui.blocks().length, 2);
  const type = ui.blocks()[0].querySelector("select")!; type.value = "paragraph"; type.fire("change");
  const caption = ui.blocks()[1].querySelector("textarea")!;
  ui.setHidden(true); ui.setHidden(false); await until(() => started);
  caption.fire("compositionstart"); input(caption, "词语");
  release(); await until(() => ui.byTest("save-status").visibleText().includes("已自动保存"));
  assert.equal(ui.blocks()[1].querySelector("textarea"), caption); assert.equal(caption.value, "词语");
  caption.fire("compositionend"); ui.button("commit-button"); await until(() => ui.id("view-timeline").visible);
  const [row] = await ui.api.listFormalRecords();
  assert.equal(row.formal!.body, "合成标题"); const [photo] = row.formal!.photos;
  assert.equal(photo.caption, "词语"); assert.match(photo.photoUseId, /^pu-/); assert.equal(photo.bytes, bytes.length);
  assert.equal(row.formal!.coverPhotoUseId, photo.photoUseId);
  const serialized = ui.storage.getItem(PREVIEW_STORAGE_KEY)!;
  assert.doesNotMatch(serialized, /"blocks"|"mode"|"undoSession"|pending-/);
  assert.equal(JSON.parse(serialized).version, 1); assert.equal(JSON.parse(serialized).schemaVersion, 5);
});
