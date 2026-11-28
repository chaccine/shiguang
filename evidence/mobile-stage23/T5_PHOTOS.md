# T-5 photo ordering and same-use replacement

Implemented on `feat/mobile-stage23` for PR 12, based on `0338ae98d20a4cd19a2bf68e20e3a6e4234cf753`. Verification ran on Linux on 2026-11-27 Asia/Shanghai with Rust 1.90.0 and offline Cargo. All five requested gates passed on their single runs. The changes are in the working tree for the orchestrator to commit. [Command timestamps and exit status](t5-photos/verification.txt)

## T-5.1 — replacement

- The Rust store and MemoryAdapter verify the original's byte length and full SHA-256 before saving the draft reference. Rust reads back newly installed bytes and checks existing files under the asset ID, including older filename extensions. An uncertain original-directory sync stops the replacement. For a reported pre-switch failure, the store removes a file newly created by that attempt. After an actual process interruption, the previous durable story remains authoritative and existing reconciliation can quarantine an unreferenced file. A state-file sync warning after its atomic replacement continues to use the existing durability result. [Store](../../core/src/store.rs) · [Fault and reopen tests](../../core/tests/t5_photos.rs)
- Replacement changes the asset fields on the existing photo block. Position, occurrence ID, caption and cover survive. The formal record stays readable with its old original until publication. Both editor layouts key thumbnails by occurrence and asset identity. On success the editor prompts caption review and focuses the caption. The failure dialog supports an explicit retry of the selected file or cancellation. A stale story comparison uses the existing reload path. [Editor](../../src/domain/story-editor.ts) · [Photo controls](../../src/ui/main.ts) · [Synthetic control tests](../../tests/t5-photo-controls.test.ts)
- Undo and redo are session-local. Store receipts identify originals previously used by that occurrence in the editor session. History restoration verifies the retained bytes. Reconciliation and purge count live history and shared references when determining which originals can be quarantined. Publication, discard, library replacement and session release retire receipts. A fresh editor can reopen the saved order and replacement. [Native history and shared-original tests](../../core/tests/t5_photos.rs) · [Adapter and editor tests](../../tests/t5-photos.test.ts)
- The writer still emits outer **2**, schema **6**, and typed story blocks. The v6 validator accepts a stable use ID pointing to different originals in snapshots of its owning record. It still rejects cross-record ownership, duplicate IDs within a snapshot and contradictory digests for one use and asset. The legacy converter retains its previous refusal of a legacy use pointing to different originals. Merge carries an incoming row’s existing ID mapping from formal to draft and uses the existing collision and conflict-copy policy for forked histories. No persisted identity field or new migration step was added. [Validator and merge](../../core/src/merge.rs) · [Legacy input guard](../../core/src/schema.rs) · [Fixture integrity](t5-photos/integrity.txt)

## T-5.2 — order

- 上移, 下移 and the dedicated 拖动排序 handle save through the same editor move. A move can cross text in story mode. Quick mode moves photos within the album. The editor adds one history step after the checked save succeeds. The native CLI also exposes `reorder-photos ID [PHOTO_USE_ID ...]` to reorder photos within their existing photo slots, and `replace-photo ID --use PHOTO_USE_ID --asset FILE`. Independent CLI processes verified published order, cover and both original hashes. [Editor move](../../src/domain/story-editor.ts) · [CLI smoke](t5-photos/cli.txt)
- Touch activation uses a 350 ms hold on the handle. Pointer release on a target commits the move. Early lift, pointer cancellation, Escape, loss of pointer capture and dropping outside a target can end the gesture without saving a move. The controls restore focus and scroll. Removal announces the first remaining photo as cover, or clears the cover when the last use is removed. [Pointer handling](../../src/ui/photo-drag.ts) · [Synthetic control results](t5-photos/focused-ts.txt)
- Native and adapter tests exercise interleaved text and photos, reopen, publication, plain backup restoration, merge into an empty library and repeated merge. They check full stories, independent captions and original bytes. The native tests also compare exact state and media before and after injected errors. [Rust tests](../../core/tests/t5_photos.rs) · [TypeScript tests](../../tests/t5-photos.test.ts)

## Verification

| Command | Result |
| --- | --- |
| `cargo +1.90.0 test --locked --workspace` | 270 passed, 0 failed, 1 ignored. [Workspace log](t5-photos/workspace.txt) |
| `cargo +1.90.0 test --locked -p shiguang_core --features fault-injection` | 335 passed, 0 failed, 1 ignored. [Fault log](t5-photos/fault.txt) |
| `npm test` | 330 passed, 0 failed, 0 skipped. [Default npm log](t5-photos/npm-test.txt) |
| `npm run typecheck` | Exit 0. [Typecheck log](t5-photos/typecheck.txt) |
| `npm run build` | Exit 0. [Build log](t5-photos/build.txt) |
| `git diff --check` | Exit 0. [File and whitespace checks](t5-photos/files.txt) |
| Separate desktop Tauri check, offline | BLOCKED before compilation. The local crates.io cache could not resolve `serde_json` for the excluded shell workspace. The TS adapter command tests passed. [Tauri diagnostic](t5-photos/tauri-check.txt) |

Both Cargo counts include the existing ignored v3 fixture generator. The 5,000-record npm run measured **adapter.homeSummary 1.013 ms** against **<150 ms** and **adapter.reunionPage 111.039 ms** against its existing **<200 ms** exception. Historical **313.050 ms remains INCONCLUSIVE**. The default npm test script and its scheduling were used once with the archived Node worker-output preload for diagnostics. The archived v3/v5 fixture bytes, performance test and npm scripts match the base commit. [Timing diagnostic](t5-photos/npm-test.txt) · [Integrity and toolchain](t5-photos/integrity.txt)

## BROWSER_CHECKLIST

The parent walkthrough is **NOT_RUN**. From `/workspace/shiguang-app`, run `npm run preview` and open the opt-in RAM URLs in the checklist. It covers the existing empty and timeline fixtures and the new legacy-simple, interleaved-draft and shared-original fixtures at 360 × 800 and 390 × 844 in both themes. The Node control tests use a synthetic event DOM. Actual layout, hit testing, scrolling and image decoding await the walkthrough. [Parent BROWSER_CHECKLIST and all preview URLs](t5-photos/BROWSER_CHECKLIST.md)

Android-native, real IME, TalkBack, native picker and Back, real-device restart and upgrade retention are **NOT_RUN**. The prior Windows CI “Access is denied” remains **UNVERIFIED** here. No browser, installer, APK, deployment, commit or push was run. [Changed-file inventory](t5-photos/files.txt)

## Independent orchestrator verification

Re-ran the default suites once after Codex finished, on 2026-11-27 05:41 Asia/Shanghai, without changing clocks, limits, scheduling or retrying. Results: cargo workspace 270 passed, 0 failed, 1 ignored; fault injection 335 passed, 0 failed, 1 ignored; `npm test` 330 passed, 0 failed; typecheck and build exit 0. `adapter.homeSummary` measured **4.332 ms** against the unchanged 150 ms gate (**PASS**). `adapter.reunionPage` measured **39.808 ms** against its specific authorized 200 ms gate. The historical **313.050 ms** result remains **INCONCLUSIVE**. Production writer remains outer 2 / schema 6. [Independent log](t5-photos/independent-full.txt)

Browser walkthrough, Android-native, IME, TalkBack, native picker/Back, real-device upgrade, and Windows directory sync remain **NOT_RUN** / unverified. No installer was built. No merge.
