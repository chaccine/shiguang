# Unit-0.8 / 0.1.9

G01–G06 and M01–M07 remain binding: offline, zero AI, no cloud sync.

Tags belong to RecordRow, never draft snapshots. set_record_tags accepts active draft-only and formal rows with tagRevision CAS; set_favorite still requires formal content. Discarding an unpublished draft deletes its row and links. Commit publishes content only and preserves metadata. Trashed rows reject metadata writes.

List covers use photoThumbUrl, never photoDataUrl. Decoder dependencies belong outside core. Thumbnails are bounded, rebuildable PNGs in previews/, keyed by immutable asset id; original media is read-only. Generation is lazy, never a full rebuild during Store::open. Cache deletion must not touch media. Missing/corrupt sources retain labeled placeholders. HEIC/HEIF ftyp brands determine media type and extension. Native decoders are platform dependent; unsupported decode must return a labeled “无法预览 HEIC 图片” placeholder. Platform/device verification is reported separately from browser simulation.

Write-lock budget increases from Unit-0.4's approximately 3 seconds to 15 seconds, accommodating slow Windows CI processes. Correctness assertions (80 records, unique sequences, strict state parsing, no lost updates) remain unchanged.

Stress data is generated locally and synthetic only. Evidence records dataset size, open, first/later timeline page, backup export and restore timings. Large corpora remain in temporary directories. Browser screenshots are MemoryAdapter evidence, not native/device verification.

## Thumbnail implementation and limits

`thumbnails/` is an independent, excluded workspace, used by the independently built Tauri shell. Its `image` dependency enables JPEG/PNG/GIF/WebP only; **core's production dependency list is unchanged**. Maximum thumbnail dimension is 320px; portable decode limits allocation to 128MiB, dimensions to 32000, source file size to 128MiB. `previews/{assetId}.thumb-v2.png` avoids reusing old stripe caches. Temporary files are siblings of the cache destination. `ensure_previews_with` in core accepts an injected decoder, validates original hashes, and skips existing cache files; core acceptance tests inject a file-copy fixture to verify cache lifecycle, not real decoding. The old `preview_bytes` utility is explicitly synthetic test/CLI input generation only. CLI `ensure-previews` now explicitly returns PREVIEW_UNSUPPORTED until a decoder is integrated; it never produces fake photo previews.

Tauri hashes/decodes in `spawn_blocking`; all list and editor thumbnail cells use `photoThumbUrl`. MemoryAdapter downscales locally with canvas and caches per asset, with an SVG fixture fallback. It never calls `photoDataUrl` for list covers. Missing/corrupt errors keep their labeled placeholders; HEIC_UNSUPPORTED is labeled in Chinese in both editor and list.

Native HEIF attempts: Android JNI invokes a kept MainActivity helper from a JVM-attached worker (ImageDecoder on API 28+, sampled BitmapFactory fallback); macOS invokes system `sips`/ImageIO; Windows invokes local PowerShell WPF/WIC (HEIF extension optional). Desktop native subprocesses and Android bridge wait have 15-second timeouts. Linux has no added HEIF decoder and returns the labeled fallback. Android native decoding cannot be forcibly cancelled after bridge timeout; late cache completion is possible. No original is modified. These platform paths require native build and device verification and are not claimed tested here.

Dependency resolution is blocked in this environment. `src-tauri/Cargo.lock` has the local app/core version bump but still needs regeneration for `shiguang_thumbnails`, `image` and Android's direct JNI dependency when registry access is available. No registry versions or checksums are fabricated.

## Stress and reproduction

Use Rust 1.90 (this box: `PATH=/home/box/.cargo/bin:$PATH`). Default stress size is 200; the recorded evidence run uses:

```sh
SHIGUANG_STRESS_SIZE=5000 SHIGUANG_STRESS_OUT="$PWD/evidence/unit-0.8/stress.json" cargo test --locked -p shiguang_core --test unit08_stress -- --nocapture
```

The generator makes 32 deterministic synthetic PNG originals, then 5000 records / independent photo uses sharing those originals. It checks restored record/photo-use counts. This measures metadata and backup behavior, not thousands of unique large camera originals. Corpora live in temporary directories and successful runs clean them up. Store::open does not generate previews. First page has 50 items; later-page timing is around the tenth page.

The initial large run exposed repeated whole-suffix UTF-8 validation per JSON character (quadratic scanning). Parser now handles ASCII directly and validates only one UTF-8 scalar at a time; strict duplicate-key/control/escape/trailing-content validation remains and a 5000-entry multilingual roundtrip regression covers it.

## Evidence status

The screenshot scripts follow current navigation: wait for appReady, settings → open-trash, explicitly enter drafts/editor as needed. `screenshots-u09.mjs` defines desktop/mobile tag creation, tag chips above the tab bar, 1600×1200 synthetic PNG → <=320px timeline cover, and undecodable HEIC flows. All script executions are recorded; screenshots are BLOCKED by sandbox networking/browser restrictions here, so zero page errors has **not** been verified. Existing screenshots predate these changes.
