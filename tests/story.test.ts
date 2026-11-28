import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { Snapshot } from "../src/domain/types.ts";
import { decodeStory, fromLegacy, hasContent, isSimple, plain, plainText, storyPhotos, toLegacy, type StoryBlock } from "../src/domain/story.ts";
import { displayText, replaceText, toggleMark } from "../src/domain/story-text.ts";

const cases = JSON.parse(readFileSync(new URL("../core/tests/fixtures/story-parity.json", import.meta.url), "utf8"));
const source = cases.legacy as Snapshot;
test("shared Rust v5 fixture preserves exact bytes, occurrence order, captions, integrity and non-first cover", () => {
  const before = JSON.stringify(source), story = fromLegacy(source);
  assert.deepEqual(story.blocks.map(b => b.kind), ["paragraph", "photo", "photo"]);
  assert.deepEqual(story.blocks[0], { kind: "paragraph", runs: [plain(source.body)] });
  assert.equal(story.coverPhotoUseId, source.photos[1].photoUseId);
  assert.equal(JSON.stringify({ ...source, ...toLegacy(story) }), before);
  const rebuilt = toLegacy(story); rebuilt.photos[0].caption = "changed";
  assert.equal(storyPhotos(story)[0].caption, source.photos[0].caption);
  assert.equal(JSON.stringify(source), before);
});
test("shared Rust empty/whitespace/CRLF and photo-only boundaries", () => {
  for (const body of cases.legacyBodies as string[]) {
    const story = fromLegacy({ body, photos: [], coverPhotoUseId: null });
    assert.equal(story.blocks.length, body.length ? 1 : 0);
    assert.equal(isSimple(story), true); assert.equal(hasContent(story), !!body.trim());
    assert.equal(toLegacy(story).body, body);
  }
  const only = fromLegacy({ ...source, body: "" });
  assert.equal(isSimple(only), true); assert.equal(hasContent(only), true);
  assert.deepEqual(only.blocks.map(b => b.kind), ["photo", "photo"]);
});
test("shared Rust interleaved marked story projects literal text and independent captions in occurrence order", () => {
  const story = decodeStory(cases.mixed);
  assert.deepEqual(story, cases.mixed); assert.equal(plainText(story), cases.mixedText);
  assert.deepEqual(storyPhotos(story).map(p => p.caption), cases.mixedCaptions);
  assert.equal(isSimple(story), false);
  assert.throws(() => toLegacy(story), { code: "STORY_COMPLEX" });
});
test("R02 depends on current order and both marks even when text projections match", () => {
  const p: StoryBlock = { kind: "paragraph", runs: [plain("one"), plain("\ntwo")] };
  const photo: StoryBlock = { kind: "photo", photoUse: source.photos[0] };
  const cases: [StoryBlock[], boolean][] = [
    [[], true], [[p], true], [[photo], true], [[p, photo], true],
    [[photo, { kind: "paragraph", runs: [] }], false], [[p, photo, p], false],
    [[p, p], false], [[{ kind: "smallHeading", runs: [] }], false], [[{ kind: "quote", runs: [] }], false], [[{ kind: "divider" }], false],
  ];
  for (const [bold, italic] of [[true, false], [false, true], [true, true]])
    cases.push([[{ kind: "paragraph", runs: [plain("a"), { text: "b", bold, italic }] }], false]);
  for (const [blocks, simple] of cases) {
    const story = decodeStory({ blocks, coverPhotoUseId: blocks.includes(photo) ? photo.photoUse.photoUseId : null });
    assert.equal(isSimple(story), simple);
  }
  assert.equal(plainText({ blocks: [p], coverPhotoUseId: null }), plainText({
    blocks: ["one", "two"].map(text => ({ kind: "paragraph", runs: [plain(text)] })), coverPhotoUseId: null,
  }));
});
test("empty textual blocks still separate lines and dividers alone do not meet the content minimum", () => {
  const empty = decodeStory({ coverPhotoUseId: null, blocks: [
    { kind: "paragraph", runs: [] }, { kind: "divider" }, { kind: "smallHeading", runs: [plain(" \t")] }, { kind: "quote", runs: [] },
  ] });
  assert.equal(plainText(empty), "\n \t\n"); assert.equal(hasContent(empty), false);
  for (const kind of ["smallHeading", "quote"])
    assert.equal(hasContent(decodeStory({ blocks: [{ kind, runs: [plain("题")] }], coverPhotoUseId: null })), true);
});
test("Rust malformed block, run, occurrence, cover and metadata cases are rejected", () => {
  const raw = (blocks: unknown[], coverPhotoUseId: unknown = null) => ({ blocks, coverPhotoUseId });
  for (const value of [null, {}, { kind: "video" }, { kind: "caption", text: "alone" }, { kind: "photo", photoUse: { caption: "" } },
    { kind: "divider", runs: [] }, { kind: "smallHeading", runs: "literal" }, { kind: "quote", runs: [null] },
    ...[{ text: 1, bold: true, italic: false }, { text: "x", italic: false }, { ...plain("x"), bold: "false" },
      { ...plain("x"), underline: true }].map(run => ({ kind: "paragraph", runs: [run] }))]) {
    assert.throws(() => decodeStory(raw([value])));
  }
  for (const value of [{ blocks: [] }, { blocks: {}, coverPhotoUseId: null }, raw([], 1), { ...raw([]), mode: "simple" }])
    assert.throws(() => decodeStory(value));
  const a = source.photos[0];
  for (const [photos, cover] of [
    [[], a.photoUseId], [[a], null], [[a], a.assetId], [[a, a], a.photoUseId],
    [[a, { ...source.photos[1], photoUseId: a.photoUseId }], a.photoUseId],
    ...[{ photoUseId: " " }, { assetId: "" }, { sha256: "bad" }, { bytes: -1 }, { caption: true }, { unknown: null }]
      .map(patch => [[{ ...a, ...patch }], a.photoUseId] as const),
  ] as const) {
    assert.throws(() => decodeStory(raw(photos.map(photoUse => ({ kind: "photo", photoUse })), cover)));
    assert.throws(() => fromLegacy({ body: "", photos: photos as unknown as Snapshot["photos"], coverPhotoUseId: cover }));
  }
});
test("separate stories can describe independent snapshots of the same occurrence", () => {
  const formal = fromLegacy(source), draft = fromLegacy({ ...source, photos: source.photos.map(p => ({ ...p, assetId: "different" })) });
  assert.equal(formal.coverPhotoUseId, draft.coverPhotoUseId); assert.notDeepEqual(storyPhotos(formal), storyPhotos(draft));
});
test("textarea and UTF-16 selection edits keep untouched CRLF, combining text and independent emphasis", () => {
  const raw = "前\r\n🌱e\u0301\r后";
  const bold = toggleMark([plain(raw)], 2, 6, "bold"), both = toggleMark(bold, 4, 6, "italic");
  assert.deepEqual(both.map(r => [r.text, r.bold, r.italic]), [
    ["前\r\n", false, false], ["🌱", true, false], ["e\u0301", true, true], ["\r后", false, false],
  ]);
  assert.deepEqual(replaceText(both, displayText(raw) + "。"), [...both.slice(0, -1), plain("\r后。")]);
  assert.deepEqual(toggleMark(toggleMark(both, 4, 6, "italic"), 2, 6, "bold"), [plain(raw)]);
});
