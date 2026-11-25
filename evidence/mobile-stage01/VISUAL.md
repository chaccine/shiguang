# Android-first timeline

Verified on 2026-11-25 in `/workspace/shiguang-app`. The worktree is on `feat/mobile-stage01` at the committed startup fix `0fa4e6a`, stacked on unmerged PR10 / `unit-0.12` at `77a06375825b5e39045e447b0b7e42cc7b0d88bb`. App version 0.1.12. The startup baseline was 268 individual frontend cases. [Baseline](BASELINE.md) · [Startup verification](STARTUP.md)

## Timeline and return behavior

The header has a small serif 拾光, a labeled 查找 entry into M05 and a 筛选 button. Month headings lead into the cover, date and text of each entry. Text-only entries start directly with their date. Real event times, tags and secondary actions follow the same reading order. The light palette uses paper grain and fine matte-gold rules. The dark palette draws a woven surface, overhead light and a warm rim around the cover. Both local 128 × 128 texture tiles together occupy 18,171 bytes. Photo thumbnails follow the existing media path and reading opens the original. The material and illumination are painted behind the entries. [Markup](../../src/ui/index.html) · [Material tokens](../../src/ui/tokens.css) · [Component styles](../../src/ui/styles.css)

The filter sheet contains the existing inclusive month cutoff, return to latest, sort order, favorites, tag selection and tag management. Each active condition has its own removal button. A native dialog handles modal keyboard navigation. The application restores focus on dismissal and tracks Back through nested dialogs, the reader and the editor. Timeline and calendar retain their scroll positions, selected day and return target. The five visible and accessible navigation labels are **时光轴 / 日历 / ＋记录 / 博物馆 / 我的**. [Timeline and routing](../../src/ui/main.ts) · [Sheet](../../src/ui/timeline-sheet.ts) · [Back handling](../../src/ui/local-back.ts) · [Icons](../../src/ui/icons.ts)

## Synthetic preview

The eight checklist URLs exercise the built app from its root path. An explicit browser-only `stage01` query selects a fresh in-memory device, including its display preferences. The timeline contains five samples across October and November 2026, two original repository color illustrations and three text-only entries. The empty device starts with zero records, photos, drafts and tags. Calendar “today” in these fixtures is 2026-11-25. The protected variants enroll the public synthetic code `0042` through the existing preview verifier. Only the slow fixture holds its first settings reply for 2.4 seconds. [Fixture](../../src/ui/mobile-preview.ts) · [URLs and expected observations](BROWSER_CHECKLIST.md)

## Verification

Rust 1.90.0 ran offline with the locked dependencies. The frontend used Node 24.22.1, npm 11.21.1 and TypeScript 5.9.3.

| Command or check | Observed result | Exit |
|---|---|---:|
| `cargo +1.90.0 test --locked --workspace` | 241 passed, 0 failed, 1 ignored | 0 |
| `cargo +1.90.0 test --locked -p shiguang_core --features fault-injection` | 291 passed, 0 failed, 1 ignored | 0 |
| `npm test` | 285 individual cases passed in the independent orchestrator run | 0 |
| `node --test --test-isolation=none tests/*.test.ts` | 285 individual cases passed, 0 failed, cancelled or skipped | 0 |
| `npm run typecheck` | Strict TypeScript check passed | 0 |
| `npm run build` | Built the app, styles and local texture assets into `dist/` | 0 |
| Local preview HTTP handler and compiled bootstrap | All 8 checklist URLs returned HTTP 200. All 37 referenced local assets matched the built bytes. Each query booted with the expected theme, record count, sheet and admission state in the Node DOM. | 0 |
| `rustfmt +1.90.0 --edition 2021 --check src-tauri/src/android_bars.rs` | Android bridge source formatting passed | 0 |
| `git diff --check` and whitespace check of the new text files | Clean | 0 |

The one ignore in each Rust run is the historical v3 fixture generator. The 17 added frontend cases include 15 application and fixture regressions, a contrast check over the texture pigments and a host theme-event check. The tests exercise individual chip removal, sheet and backdrop dismissal, M05 search, paging past 50 records, read/edit/commit/back, and protected startup with delayed or failed settings. Both themes return the original mint illustration byte-for-byte in reading. The Node DOM exercises the thumbnail fallback because it has no bitmap decoder. Existing regressions caught an M05 commit-return branch change and an unnecessary async step on return to an unchanged list. Both paths were corrected and exercised in the final runs. [Timeline regressions](../../tests/mobile-visual.test.ts) · [Contrast](../../tests/unit010-accessibility.test.ts) · [Host appearance](../../tests/unit010-appearance.test.ts) · [Startup regressions](../../tests/mobile-startup.test.ts)

## Android and acceptance status

Android already applies system-bar, display-cutout and IME insets in its activity. Initial bar styling follows the Android configuration. The existing Tauri event capability and JNI bridge carry the resolved light/dark boolean to AndroidX for subsequent paints. The persisted data and verifier still use schema v5, Argon2id and the existing 4–8 ASCII-digit app-lock contract, including leading zeros. Backup passphrases and G01–G06 keep their existing implementations. [Activity](../../android-overrides/MainActivity.kt) · [Paint event](../../src-tauri/src/android_bars.rs) · [Lock and backup contract](STARTUP.md#compatibility-and-data-invariants)

**NOT_RUN** — parent browser at 360/390 px, real focus traversal and IME, 200% visual reflow, displayed photo colors, startup frames and screenshots. The sandbox denied a loopback listener on `127.0.0.1:1420` with `EPERM`. The HTTP checks above exercised the real preview request handler with in-process streams. **Android native build, hardware status/navigation bars, native Back and historical-data upgrade are NOT_RUN.** Only the Linux Rust target is installed here. The parent checklist records each outstanding observation. [Browser and device checklist](BROWSER_CHECKLIST.md)

## Independent orchestrator follow-up

2026-11-25 21:05 Asia/Shanghai: full workspace241/fault291/npm285/typecheck/build/diff-check all exit0. Raw logs retained in `/workspace/sg-visual-01/visual/`; machine-readable summary in [VISUAL_VERIFICATION.json](VISUAL_VERIFICATION.json). Outside the coding sandbox, the loopback preview now serves all eight listed URLs and texture/bootstrap assets successfully; checks compared HTTP bodies to the built files. This is serving evidence only, not browser rendering or mobile acceptance. No local Android installer was built or delivered. CI startup commit0fa4e6a run45614570495 was7/7; visual-code CI will be recorded separately after push.

## Final CI and bounded browser acceptance

CI45619961661 completedSUCCESS7/7 at exact code8f86b47479e89241efeb4a5b9a27e80cba626759. The existing pipeline includes successful Android compilation/build; this is not a hardware installation or UI pass. Subsequent archive commits are documentation/evidence only.

Parent computerUse completed a boundedPARTIAL pass: [observations](manual/RESULTS.md), seven unchanged [capture artifacts](manual/ARTIFACTS.json). Light/dark first screens and navigation, true empty, sheet open/Done,薄荷1/1 search/read return, slow lock cover, Retry and0042 unlock were observed. Responsive GUI targets390×844 and360×800 had selected matching page readings; one later390×844 GUI versus390×800 page disagreement is retained, DPR unknown.200% is partial navigation wrapping only, not full reflow acceptance. Wrong-code rejection,60-second relock, exhaustive filter/focus/IME/hardware/system-bar and native upgrade remainNOT_RUN. This supersedes earlier blanket browser-pending and native-build-NOT_RUN status, without implying all checklist items passed.
