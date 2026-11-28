# Timeline list photo preview: shorter box, denser thumbs

Date: 2026-11-28, Asia/Shanghai. Branch `feat/mobile-stage23`, still 0.1.13 / versionCode 1013. No APK, no version bump, no merge. Authorized by Cine t100u / t101u; implemented locally without Codex, Qoder, GLM, or CloudAgent. Synthetic fixtures only.

## Before (measured from CSS, not a new walkthrough)

Timeline journal cards put the cover inside `button.entry-read`, so the winning rule is `.entry-read .timeline-cover`, not the later generic `.timeline-cover { max-height: 240px }`.

Before this change that rule was:

- `aspect-ratio: 4 / 3`
- `max-height: 30rem` (480px at a 16px root)
- width stretches to the list content; `border-radius: .7rem`; `object-fit: cover`
- 1px `var(--photo-frame)` border; `box-sizing: border-box`

Mobile `max-width: 760px` main padding is `clamp(16px, 5.6vw, 28px)` on each side, no safe-area in the browser preview.

| Viewport | Side pad | Cover border-box width | Height (4/3, 30rem not binding) | Share of viewport height |
| --- | --- | --- | --- | --- |
| 360×800 | 20.16px | 319.68px | 239.76px | 30.0% (~1/3) |
| 390×844 | 21.84px | 346.32px | 259.74px | 30.8% (~1/3) |

That is the poster-like block Cine saw on the 0.1.13 device. Multi-photo rows already use this same single cover plus a count, not a stacked grid, so they do not fill a whole screen by themselves.

Cached thumbs were `previews/{assetId}.thumb-v2.png`, long edge 320 (`thumbnails::` portable `thumbnail(320, 320)`, and the preview `MemoryAdapter` used the same cap). Timeline covers load `photoThumbUrl`, never the original. At 3× device pixels a 320px thumb is stretched across ~320–346 CSS pixels, which is why the large 4/3 box made blur obvious. At the earlier browser walkthrough DPR 2, 320px was already close to the CSS width.

## After

`.entry-read .timeline-cover` only:

- `width: 100%` (still nearly full list width)
- `aspect-ratio: 2 / 1` (exactly 2/3 of the old 4/3 height, inside the agreed 60–70%)
- `max-height: 33dvh` (one-third of the layout viewport; does not bind on 360×800 or 390×844, where 2/1 is ~20% of the screen)
- same `border-radius: .7rem` and `object-fit: cover`

| Viewport | Cover width (unchanged) | Height (2/1, 33dvh not binding) | vs previous height | Share of viewport height |
| --- | --- | --- | --- | --- |
| 360×800 | 319.68px | 159.84px | 66.7% | 20.0% |
| 390×844 | 346.32px | 173.16px | 66.7% | 20.5% |

Reading, museum, and editor display sizes were not changed:

- Reading: `.reading-photo { width:100%; max-height:80vh; object-fit:contain; }`, still `photoDataUrl`
- Museum tiles: `.museum-mat` still 4/3; full photo still `height: min(52dvh, 38rem); object-fit: contain;`, still `photoDataUrl` for the large view and `photoThumbUrl` for tiles
- Editor: `.photo-cell .photo-thumb { height:180px; }` unchanged

Thumbnail generation long-edge cap is now 1080 (`thumbnails::MAX_EDGE`, native `sips`/`DecodePixelWidth`, and `MemoryAdapter`). That covers near-full-width phone covers at typical 2–3× DPR (360 CSS × 3 ≈ 960, 390 CSS × 3 ≈ 1038) without making an original-size timeline copy. The cache key moved to `previews/{assetId}.thumb-v3.png` so existing 320px `thumb-v2` files are not reused. Live museum `thumbnailKey` expectations were updated to v3; historical evidence that correctly recorded v2 / 320 was left alone. Frozen v3/v5 fixture bytes were not touched.

Search-result cards still use the generic `.timeline-cover` (`max-height: 240px`) and were not restyled. Calendar day lists and 珍藏 reuse `timelineCard` / `.entry-read`, so they follow the shorter list cover.

## Tests

Pinned in `tests/timeline-preview.test.ts`. Also ran photo / museum / visual / accessibility tests, then the default regression with Rust 1.90.0, `CARGO_NET_OFFLINE=true`, `/home/box/.cargo/bin` first on PATH, Node’s `npm test` / `typecheck` / `build`.

| Command | Result |
| --- | --- |
| `node --test tests/timeline-preview.test.ts` and the photo/museum/visual/a11y set | 70 passed, 0 failed |
| `cargo test --locked --offline --workspace` | 270 passed, 0 failed, 1 ignored (historical v3 generator) |
| `cargo test --locked --offline -p shiguang_core --features fault-injection` | 335 passed, 0 failed, 1 ignored |
| `npm test` | 332 passed, 0 failed (includes the two new pins; was 330 plus those) |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0; dist written 2026-11-28 16:12:35 Asia/Shanghai |

Default-regression timings from `npm test` (`tests/unit011-museum.test.ts`): `adapter.homeSummary` **17.005 ms** vs the unchanged 150 ms gate (PASS). `adapter.reunionPage` **38.711 ms** vs the authorized 200 ms gate for that assertion only (PASS). Domain `homeSummary` 15.165 ms and `reunionPage` 2.372 ms, both under 150 ms.

### Not run / blocked

- `cargo test --locked --manifest-path thumbnails/Cargo.toml`: blocked. The excluded crate’s own `Cargo.lock` is stale relative to current Cargo (`--locked` refuses to proceed). Offline resolution also lacks the `image` crate in this environment. `src-tauri` offline tests remain blocked on missing `serde_json` in that lock’s registry, as before. The new 1080 cap is pinned in source and exercised by the preview `MemoryAdapter` path in npm tests. The lockfiles were not rewritten.
- Browser walkthrough: not run here (no desktop tools). Checklist below is for the parent agent.
- Native device install, IME, TalkBack, upgrade: NOT_RUN. No new APK.

## Preview

`http://127.0.0.1:1420/` only hosts `dist/`. The existing `npm run preview` process (pid 181087) was left running; the server reads `dist` on each request. After the new build, `curl http://127.0.0.1:1420/ui/styles.css` already contains `aspect-ratio: 2 / 1` and `max-height: 33dvh`. No restart required.

## Walkthrough checklist (for the parent; do not treat as done)

Viewports: 360×800 and 390×844. Themes: light paper and lamplit dark. Synthetic fixtures only.

- Timeline: http://127.0.0.1:1420/?stage01=timeline&theme=light (and `theme=dark`)
- Simple / interleaved / shared albums: `?stage23=simple|interleaved|shared&theme=light|dark`

Check:

1. Timeline list covers are clearly shorter than the old 4/3 poster (~160px on 360×800, ~173px on 390×844), still nearly full width, same rounding and cover crop. Expect about two-thirds of the previous height, under one-third of the screen.
2. Preview looks less stretched/blurry than the 0.1.13 device report, especially on a 2–3× display. This preview process uses the in-memory 1080 cap, not a newly installed APK.
3. Open a cover into the reading page: in-story / cover photos stay large (`max-height: 80vh`, contain). They must not follow the shorter list box.
4. Museum home tiles and the large photo viewer stay at their previous sizes.
5. If you open the editor, photo cells stay 180px tall.
6. Multi-photo entries still show one cover plus a count, just shorter; no new grid.

Native touch / IME / TalkBack remain out of scope for this preview pass.
