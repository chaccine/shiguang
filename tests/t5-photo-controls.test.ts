import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bootDom, until } from "./support/boot-dom.ts";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { PREVIEW_STORAGE_KEY } from "../src/ui/demo.ts";
import { mobilePreview } from "../src/ui/mobile-preview.ts";
import { isSimple, storyOf } from "../src/domain/story.ts";

const image = new Uint8Array(readFileSync(new URL("../core/tests/fixtures/v5/media/ast-336cf1dd4efe5ef1.png", import.meta.url)));
const other = new Uint8Array(readFileSync(new URL("../core/tests/fixtures/v5/media/ast-5be0e93dd09a92cb.png", import.meta.url)));

async function setup(t: TestContext) {
  const dom = bootDom(); t.after(dom.restore);
  const api = new MemoryAdapter({ storage: dom.storage, storageKey: PREVIEW_STORAGE_KEY, search: "" });
  const id = (await api.createDraft({ body: "synthetic album", eventDate: "2026-11-21" })).row.recordId;
  for (const caption of ["one", "two", "three"]) await api.attachPhotoBytes({ recordId: id, fileName: "sample.png", bytes: image, caption });
  const photos = (await api.getRecord(id)).draft!.photos;
  await api.setDraftCover(id, photos[1].photoUseId); await api.commitRecord(id, 0);
  t.mock.method(MemoryAdapter.prototype, "photoThumbUrl", async (assetId: string) => assetId);
  await import(new URL(`../src/ui/main.ts?t5=${encodeURIComponent(t.name)}`, import.meta.url).href);
  await until(() => dom.body.dataset.appReady === "1");
  dom.id("timeline-list").querySelector('[data-testid="edit-button"]')!.fire("click");
  await until(() => dom.id("view-reading").visible); dom.byTest("reading-edit").fire("click");
  await until(() => dom.id("view-editor").visible);
  const area = () => dom.id("story-blocks").hidden ? dom.id("photo-grid") : dom.id("story-blocks");
  const cells = () => area().querySelectorAll(".photo-cell");
  const cell = (index: number, control: string) => cells()[index].querySelector(`[data-testid="${control}"]`)!;
  return { ...dom, recordId: id, api, photos, area, cells, cell };
}
test("labelled movement and touch hold/drop share a persisted move; early lift and pointer cancellation preserve order and scroll", async t => {
  const ui = await setup(t), grid = ui.area();
  const ids = () => ui.cells().map(n => n.dataset.photoId);
  const [a, b, c] = ids();
  ui.id("main-content").scrollTop = 84; window.scrollTo(0, 47);
  assert.equal(ui.cell(0, "photo-up").disabled, true);
  ui.cell(0, "photo-down").fire("click");
  await until(() => ids()[0] === b);
  assert.deepEqual(ids(), [b, a, c]); assert.equal(ui.active(), ui.cell(1, "photo-down"));
  ui.cell(1, "photo-up").fire("click"); await until(() => ids()[0] === a);
  const saved = ui.storage.getItem(PREVIEW_STORAGE_KEY);
  const drag = ui.cell(2, "photo-drag");
  Object.assign(grid, { contains: () => true });
  Object.assign(document, { removeEventListener() {}, elementFromPoint: () => ui.cells()[0] });
  Object.assign(window, { removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  Object.assign(drag, { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} });
  const event = { pointerId: 1, isPrimary: true, button: 0, clientX: 12, clientY: 100, pointerType: "touch" };
  drag.fire("pointerdown", event); drag.fire("pointerup", event);
  assert.equal(ui.storage.getItem(PREVIEW_STORAGE_KEY), saved);
  drag.fire("pointerdown", event); await until(() => drag.classList.contains("dragging"));
  drag.fire("pointermove", { ...event, clientY: 50 }); drag.fire("pointercancel", event);
  assert.equal(ui.storage.getItem(PREVIEW_STORAGE_KEY), saved); assert.deepEqual(ids(), [a, b, c]);
  assert.equal(ui.active(), drag); assert.equal(window.scrollY, 47);
  drag.fire("pointerdown", event); await until(() => drag.classList.contains("dragging"));
  drag.fire("pointermove", { ...event, clientY: 50 }); drag.fire("pointerup", event);
  await until(() => ids()[0] === c);
  assert.deepEqual(ids(), [c, a, b]); assert.equal(ui.active(), ui.cell(0, "photo-drag"));
  assert.equal(ui.id("main-content").scrollTop, 84);
  const persisted = (await ui.api.getRecord(ui.recordId)).draft!;
  assert.deepEqual(persisted.photos.map(p => p.photoUseId), [c, a, b]); assert.equal(persisted.coverPhotoUseId, b);
});

for (const mode of ["quick", "story"]) test(`${mode} replacement picker cancel, retry, caption review, new thumbnail, undo and cover fallback`, async t => {
  const ui = await setup(t);
  if (mode === "story") ui.byTest("mode-story").fire("click");
  const picker = ui.byTest("photo-input");
  const file = new File([other], "replacement.png", { type: "image/png" });
  Object.assign(picker, { click() {}, files: [file] });
  const old = ui.storage.getItem(PREVIEW_STORAGE_KEY);
  const previous = ui.cell(1, "photo-thumb").dataset.assetId;
  ui.cell(1, "photo-replace").fire("click"); picker.fire("cancel");
  assert.equal(ui.storage.getItem(PREVIEW_STORAGE_KEY), old);
  const original = MemoryAdapter.prototype.replaceDraftPhoto;
  let failures = 1;
  t.mock.method(MemoryAdapter.prototype, "replaceDraftPhoto", function(this: MemoryAdapter, input: Parameters<typeof original>[0]) {
    if (failures > 0) { failures--; return Promise.reject({ code: "MEDIA_STATE_WRITE_FAILED" }); }
    return original.call(this, input);
  });
  const attempt = () => { ui.cell(1, "photo-replace").fire("click"); picker.fire("change"); };
  attempt(); await until(() => ui.id("confirm-dialog").open);
  assert.equal(ui.byTest("confirm-ok").textContent, "重试");
  ui.byTest("confirm-cancel").fire("click"); await until(() => ui.active() === ui.cell(1, "photo-replace"));
  assert.equal(ui.cell(1, "photo-thumb").dataset.assetId, previous);
  assert.equal(ui.storage.getItem(PREVIEW_STORAGE_KEY), old);
  failures = 1; attempt(); await until(() => ui.id("confirm-dialog").open); ui.byTest("confirm-ok").fire("click");
  await until(() => ui.id("app-notice").visibleText().includes("核对"));
  assert.notEqual(ui.cell(1, "photo-thumb").dataset.assetId, previous);
  assert.equal(ui.active(), ui.cell(1, "photo-caption")); assert.equal(ui.active()!.value, "two");
  assert.equal(ui.cell(1, "photo-cover").getAttribute("aria-pressed"), "true");
  ui.byTest("story-undo").fire("click"); ui.setHidden(true); ui.setHidden(false);
  await until(() => ui.byTest("save-status").visibleText().includes("已自动保存"));
  assert.equal(ui.cell(1, "photo-thumb").dataset.assetId, previous);
  const row = await ui.api.getRecord(ui.recordId);
  assert.deepEqual(row.draft!.story, row.formal!.story); assert.equal(row.draftMode, mode);
  ui.cells()[1].querySelector(".photo-remove")!.fire("click"); ui.byTest("confirm-ok").fire("click");
  await until(() => ui.cells().length === 2);
  assert.equal(ui.cell(0, "photo-cover").getAttribute("aria-pressed"), "true");
  assert.match(ui.id("app-notice").visibleText(), /第一张剩余照片/);
  ui.setHidden(true); ui.setHidden(false);
  await until(() => ui.byTest("save-status").visibleText().includes("已自动保存"));
});

test("T-5 opt-in fixtures are RAM-only and the shared fault is consumed exactly once", async () => {
  for (const name of ["simple", "interleaved", "shared"]) {
    const params = new URLSearchParams(`stage23=${name}&theme=dark`);
    assert.equal(mobilePreview(params, true), null);
    const fixture = mobilePreview(params, false)!; await fixture.prepare();
    const api = fixture.adapter, [row, otherRow] = await api.listFormalRecords();
    const formal = row.formal!;
    assert.equal(formal.coverPhotoUseId, formal.photos[1].photoUseId);
    if (name === "simple") assert.ok(isSimple(storyOf(formal)));
    if (name === "interleaved") {
      assert.ok(row.draft); assert.notEqual(row.draft.title, formal.title);
      assert.deepEqual(storyOf(formal).blocks.map(b => b.kind), ["smallHeading", "photo", "quote", "photo"]);
    }
    if (name === "shared") {
      const p = formal.photos[0], shared = otherRow.formal!.photos[0];
      assert.equal(p.assetId, shared.assetId); assert.notEqual(p.caption, shared.caption);
      const input = { recordId: row.recordId, photoUseId: p.photoUseId, source: { kind: "file" as const, fileName: "sample.png", bytes: other } };
      await assert.rejects(api.replaceDraftPhoto(input), { code: "MEDIA_STATE_WRITE_FAILED" });
      assert.equal((await api.getRecord(row.recordId)).draft, null);
      assert.equal((await api.replaceDraftPhoto(input)).row.draft!.photos[0].photoUseId, p.photoUseId);
    }
  }
});
