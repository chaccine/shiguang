# T-4 Stage 2 mixed story editor

Implemented on `feat/mobile-stage23` at base `c19e55590312fbaa98358b2b82607cb96d756faa` for PR12. Changes are in the worktree for the orchestrator. The requested automated suites passed. The position model is **not ready for T-5**. Complex block positions and marks still need an approved schema 6 writer and durable editor, backup, restore and merge round trips. **T-5 has not started.**

## Editor behavior

New entries open in 速记 with a prefilled local date. Calendar entry uses the selected day. Opening a formal record for editing, accepting that date, switching modes, opening the tag picker and opening preview can all be done before a draft exists. When formal Edit finds a draft, the user can continue it, cancel, or confirm restarting from the formal version. Publication uses the base revision observed on entry and the existing original-media checks.

Story editing offers insertion at every block boundary, a text-type selector, independent bold and italic on a selection, up/down movement and confirmed removal. Photos use the existing caption, cover and movement controls. Undo and redo cover text, metadata fields and the story sequence, including photos. Each completed composition contributes one text edit. Autosave acknowledgements preserve history. A new photo keeps the same editing control when the store assigns its occurrence ID.

Preview renders the working document using the formal reader's typography and traversal. It exposes a return control and restores the editor's focus, text selection and scroll where the original control is available. Formal reading always starts from the formal snapshot. The cover header is drawn separately, then each block is drawn once at its story position. Text and captions are literal text. Headings, quotes, rules and emphasis use semantic elements.

## Persistence boundary

| Content or action | Behavior on outer 1 / schema 5 |
| --- | --- |
| Legacy input | An empty body contributes zero paragraphs. Every other body becomes one unmarked paragraph containing the entire string. Photo occurrences follow in source order, with the explicit cover, captions, asset IDs, digests, byte lengths and media types. |
| Simple story | Zero or one leading unmarked paragraph followed only by photos can autosave and publish. A text area's normalized display offsets map back to original text, preserving untouched CR and CRLF. Schema 5 can represent the resulting literal body, photo array and cover. Adjacent unmarked run boundaries and a lone empty paragraph canonicalize on reopen. |
| Complex story | A second paragraph, text after a photo, a heading, a quote, a divider, or either emphasis mark suspends durable writes. The warning explains how to simplify. Publish stays disabled. The session retains the complete working sequence, metadata edits, captions, cover and pending photo bytes. A simple write already dispatched can finish with its original input. |
| Leaving and returning | A complex session appears in the draft box as 仅本次会话, even for a new entry without a record ID. Returning opens story mode. Manual 速记 protects all edit controls, including independent tags, photos, date and publication. 进入故事编辑 returns to the working sequence. |
| Reload or process exit | Complex overlays, pending files, undo/redo and the simple draft's last-mode preference live in RAM. Reloading or terminating the app drops these. The latest durable simple draft and formal snapshot remain available. The mode preference survives navigation within the same app instance. |
| Simplification | The first representable edit resumes the serialized draft operations. Each successful API write is a valid schema 5 snapshot. Publication waits for the queue. The editor checks for intervening changes to a saved draft's photos before reconciling them. An observed mismatch offers reopening the latest draft. |
| Tags | Tags keep their existing independent metadata revision. An existing record can receive an explicit tag update in story mode. A new session-only complex story needs a durable record ID before tag association. Opening the picker alone creates no record. |
| Undo after a saved photo unlink | The existing unlink command accepts an editing-session token and an inverse operation. The store keeps the removed PhotoUse in memory, bound to the record origin, revision and session. Undo recovers that exact use. Existing caption, cover and reorder operations restore its presentation. New attachments still receive store-allocated IDs. |

No story payload, mode flag, markup encoding or temporary photo ID enters the snapshot. The schema, serializers, migration activation, storage cleanup, backup formats and museum timing limits retain their baseline definitions. The controls use the existing light paper and lamplit theme tokens. Normal startup adds no fixture records.

## Verification

Rust used `PATH=/home/box/.cargo/bin:$PATH`, `CARGO_NET_OFFLINE=true` and toolchain 1.90.0. Node was 24.22.1 and npm 11.21.1. Tests used synthetic fixtures. The supplied account and runtime configuration were left as provided.

| Check | Result | Log |
| --- | --- | --- |
| `cargo +1.90.0 test --locked --workspace` | 262 passed, 0 failed, 1 ignored | [Workspace](t4-editor-ui/cargo-workspace.txt) |
| `cargo +1.90.0 test --locked -p shiguang_core --features fault-injection` | 326 passed, 0 failed, 1 ignored | [Fault injection](t4-editor-ui/cargo-fault.txt) |
| Three focused TS suites | 24 passed, including shared Rust vectors, two-slot isolation, simulated composition-event sequences in the Node harness, protected controls, stale photo checks, in-flight saves, durable unlink undo, and preview/back | [Focused results](t4-editor-ui/all-focused.txt) |
| `npm test` | One launch at default scheduling, 321 passed, 0 failed, 0 skipped | [Full npm output](t4-editor-ui/npm-test.txt) |
| `npm run typecheck` and `npm run build` | Both exit 0 | [Typecheck](t4-editor-ui/typecheck.txt) · [Build](t4-editor-ui/build.txt) |
| Extra desktop Tauri shell check | BLOCKED before compilation. Offline Cargo could not resolve `serde_json` for the separately locked shell workspace. | [Tauri check](t4-editor-ui/tauri-check.txt) |

The ignored Rust test in both suites is the historical v3 fixture generator. The new fixture is read from the same JSON file by Rust and TypeScript. The tests cover repeated originals with different occurrence IDs and captions, non-first covers, whitespace, CRLF, Unicode, all four mark combinations, interleaving and malformed content. [Shared vectors](../../core/tests/fixtures/story-parity.json) · [Rust tests](../../core/tests/story.rs) · [TS parity tests](../../tests/story.test.ts)

The 5,000-record run measured **adapter.homeSummary 2.130 ms** against the unchanged <150 ms gate and **adapter.reunionPage 28.676 ms** against its specific <200 ms gate. The historical **313.050 ms remains INCONCLUSIVE**. The default npm command ran once. A worker-output preload forwarded the sandbox's otherwise suppressed Node diagnostics to the existing stdout/stderr descriptors. It changed no test files, clocks, limits, scheduling options or retry behavior. The U011 test blob matched HEAD. [Timing diagnostic](t4-editor-ui/npm-test.txt) · [Output transport source](t4-editor-ui/worker-output.txt) · [Historical investigation](home-summary-investigation/REPORT.md)

## BROWSER_CHECKLIST

From the repository root, run `npm run preview`. Open the existing opt-in RAM fixtures on port 1420. Use `/?stage01=empty&theme=light` for empty startup and `/?stage01=timeline&theme=dark` for formal reading and editing. Swap light and dark, and walk the flows at **360×800** and **390×844**. Refresh resets these fixture libraries. The checklist gives the synthetic image paths, expected results and return paths. [Parent BROWSER_CHECKLIST](t4-editor-ui/BROWSER_CHECKLIST.txt)

ComputerUse/browser visual verification, Android-native, real Chinese IME, TalkBack, native picker/Back and real-device restart or upgrade retention are **NOT_RUN**. The event-DOM tests exercise handlers and requested focus/scroll values. Layout, keyboard occlusion and assistive-technology announcements require the later passes.

## Changed files

| Area | Files |
| --- | --- |
| Story model, text editing, session | `src/domain/story.ts`, `src/domain/story-text.ts`, `src/domain/story-editor.ts`, `src/domain/draft-session.ts` |
| Editor, reader and themes | `src/ui/index.html`, `src/ui/main.ts`, `src/ui/story-controls.ts`, `src/ui/reading.ts`, `src/ui/styles.css` |
| Photo unlink inverse through the existing snapshot API | `src/platform/api.ts`, `src/platform/memory-adapter.ts`, `src/platform/tauri-adapter.ts`, `src-tauri/src/lib.rs`, `core/src/store.rs` |
| Tests and shared fixture | `core/tests/fixtures/story-parity.json`, `core/tests/story.rs`, `core/tests/unit04_media.rs`, `tests/story.test.ts`, `tests/story-editor.test.ts`, `tests/story-editor-ui.test.ts`, `tests/support/boot-dom.ts` |
| Evidence | `evidence/mobile-stage23/T4_EDITOR_UI.md` and `evidence/mobile-stage23/t4-editor-ui/` |

The pre-existing untracked `evidence/mobile-stage23/migration-safety/` and `src-tauri/gen/` were left in place. Verification produced the normal ignored build output.

## Independent orchestrator verification

Re-ran the default suites once after Codex finished, on 2026-11-27 00:31 Asia/Shanghai, without changing clocks, limits, scheduling or retrying. Results: cargo workspace 262 passed, 0 failed, 1 ignored; fault injection 326 passed, 0 failed, 1 ignored; `npm test` 321 passed, 0 failed; typecheck and build exit 0. `adapter.homeSummary` measured **3.287 ms** against the unchanged 150 ms gate (**PASS**). `adapter.reunionPage` measured **23.411 ms** against its specific authorized 200 ms gate. The historical **313.050 ms** result remains **INCONCLUSIVE**. Production writer remains outer 1 / schema 5. [Independent log](t4-editor-ui/independent-full.txt)
