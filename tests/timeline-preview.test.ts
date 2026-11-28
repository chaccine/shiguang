import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const block = (source: string, start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));

test("timeline list covers are shorter than the old 4/3 poster; reading and museum full sizes stay put", () => {
  const css = read("../src/ui/styles.css");
  const cover = block(css, ".entry-read .timeline-cover {", ".entry-read .timeline-cover img");
  assert.match(cover, /width: 100%/);
  assert.match(cover, /aspect-ratio: 2 \/ 1;/);
  assert.match(cover, /max-height: 33dvh;/);
  assert.match(cover, /border-radius: \.7rem;/);
  assert.doesNotMatch(cover, /aspect-ratio: 4 \/ 3;/);
  assert.doesNotMatch(cover, /max-height: 30rem;/);
  assert.match(css, /\.entry-read \.timeline-cover img \{ width: 100%; height: 100%; min-height: 0; max-height: none; object-fit: cover; \}/);
  assert.match(css, /\.reading-photo \{ width:100%; max-height:80vh; object-fit:contain; \}/);

  const museum = read("../src/ui/museum.css");
  assert.match(museum, /\.museum-mat \{[^}]*aspect-ratio: 4 \/ 3;/s);
  assert.match(museum, /\.museum-full-photo img \{ display: block; width: 100%; height: min\(52dvh, 38rem\); object-fit: contain; \}/);
  const editor = css;
  assert.match(editor, /\.photo-cell \.photo-thumb \{ height:180px; \}/);
});

test("timeline covers stay on bounded thumbs; reading uses the original; cache key is v3 at 1080", () => {
  const ui = read("../src/ui/main.ts");
  const coverLoader = block(ui, "async function loadCoverImage", "function timelineCover");
  assert.match(coverLoader, /photoThumbUrl/);
  assert.doesNotMatch(coverLoader, /photoDataUrl/);
  const readingLoader = block(ui, "function loadReadingPhoto", "async function openReading");
  assert.match(readingLoader, /photoDataUrl/);
  assert.doesNotMatch(readingLoader, /photoThumbUrl/);

  const museumUi = read("../src/ui/museum.ts");
  assert.match(museumUi, /thumb \? this\.api\.photoThumbUrl\(assetId\) : this\.api\.photoDataUrl\(assetId\)/);

  const thumbs = read("../thumbnails/src/lib.rs");
  assert.match(thumbs, /pub const MAX_EDGE: u32 = 1080;/);
  assert.match(thumbs, /decoded\.thumbnail\(MAX_EDGE, MAX_EDGE\)/);
  assert.doesNotMatch(thumbs, /decoded\.thumbnail\(320, 320\)/);

  const adapter = read("../src/platform/memory-adapter.ts");
  assert.match(adapter, /1080 \/ Math\.max\(bitmap\.width, bitmap\.height\)/);

  assert.match(read("../core/src/store.rs"), /\{asset_id\}\.thumb-v3\.png/);
  assert.match(read("../core/src/museum.rs"), /thumb-v3\.png/);
  assert.match(read("../src/domain/museum.ts"), /thumb-v3\.png/);
  assert.doesNotMatch(read("../core/src/store.rs"), /thumb-v2/);
  assert.doesNotMatch(read("../src/domain/museum.ts"), /thumb-v2/);
});
