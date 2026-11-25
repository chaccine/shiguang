# Unit-0.12 M05 SEARCH UI — implementation handoff

Date: 2026-11-25. Branch: `unit-0.12`. Core commits `58900a1` / `b787160` were treated as the
existing implementation; no core/adapter/Rust/schema changes were made. Authority read:
`/workspace/u12/m05.md`, `m05-audit.md`, `contract.md`, repository `unit-0.12/SPEC.md` and
`ORCHESTRATOR_VERIFICATION.md`, plus existing navigation/reading/museum/favorite/tag controls.

**Ready for parent computerUse browser checks. This is not final product/device acceptance.**

## PASS — implementation and shared correctness

- Independent 查找时光 route with timeline, museum and desktop entries; mobile navigation remains
  时光轴 / 日历 / ＋记录 / 博物馆 / 我的. Existing collect/favorites/tag routes are preserved.
- Literal keyword, 450 ms IME-safe debounce, explicit submit, tag multi-select OR, inclusive event-date
  bounds, favorite-only, all/with/without photos, cross-dimension AND, existing M02 ascending/descending
  order; Chinese explanation, removable condition chips, clear-all, neutral empty/no-match state.
- Immediate input-generation invalidation; stale page/error/hydration responses cannot overwrite the
  current query. Cursor source/query/format failures discard old pages and restart once with null cursor.
  Loading/error/status/validation feedback is accessible and actionable.
- M02 formal-card projection/styles and lazy cover loader; text-node/mark-only highlights and real
  deep-body, non-cover caption, location and tag excerpts. Draft-only and trashed content stays excluded;
  museum-hidden formal content remains searchable. No title or image-content inference is invented.
- Existing complete reader and edit flow; return restores query/filter/sort/loaded result depth/scroll/focus
  and checks current source identity. Editing and explicitly committing from the search reader returns
  through that reader. Interrupted pending snippet hydration restarts after reading/back.
- Favorites use existing durable `setFavorite` with metadata revision checks and returned durability copy.
  No implicit draft commit. Successful authority mutations invalidate search; failed mutations and draft
  autosaves do not. Tag refresh uses the existing dictionary/manager. Removed selected tags retain a
  removable “已移除的标签” chip rather than silently widening the search.
- Explicit Load more requests 24 items at a time. Both themes reuse existing semantic tokens, rem sizing,
  focus treatment, 44 px action/label targets and reduced motion. Actual layout/AT remains pending.
- Browser-only explicit `searchDemo=mixed|empty`, a separate synthetic storage key and deterministic clock;
  32 formal records / two drafts / one trash entry. No ordinary-preview or native auto-seeding.

Owner scope update: **Android phone first**; macOS/Windows-specific UI adaptation/build acceptance and desktop screenshots are deferred. Existing desktop code is preserved; generic CI jobs do not imply desktop/device acceptance.

## Verification

All Rust commands used `export PATH=$HOME/.cargo/bin:$PATH` and `CARGO_NET_OFFLINE=true`.
Node v24.22.1; npm 11.21.1; installed cargo 1.90.0 (840b83a10 2025-07-30).

| Status | Command/check | Actual result |
|---|---|---|
| PASS | `cargo test --locked --workspace` | 241 passed, 0 failed, 1 historical v3 fixture generator ignored |
| PASS | `cargo test --locked -p shiguang_core --features fault-injection` | 291 passed, 0 failed, same 1 ignored |
| PASS | `npm test` | 26 file-level suites passed; process-isolated runner reports file totals in this sandbox, 2,004.576391 ms |
| PASS | `node --test --test-isolation=none tests/*.test.ts` | 254 individual tests passed, 0 failed/skipped, 5,195.334186 ms |
| PASS | `npm run typecheck` | Exit 0 |
| PASS | `npm run build` | Exit 0; frontend assets only, includes search CSS/modules |
| PASS | `git diff --check` | No whitespace errors |
| PASS | Explicit installed-toolchain release stress test below | 1 benchmark test passed; no source/media writes and no duplicate page IDs |
| BLOCKED (alias only; fallback completed) | `cargo +1.90 --version` | Alias synchronization attempted a read-only rustup temp path; no toolchain installed/changed. Used existing `+1.90.0` successfully. |
| BLOCKED (sandbox bind) | `node scripts/preview-server.mjs` | `listen EPERM 127.0.0.1:1420`; host parent must start existing static server |
| NOT_RUN | CI, computerUse browser checks, phone light/dark screenshots (desktop deferred) | Reserved for parent/orchestrator; no screenshots or browser PASS invented |
| NOT_RUN | Native IPC/device, browser IME/AT/layout, real-phone latency | Harness/source checks are not substitute acceptance |
| DEFERRED | Story blocks, M01 editor work, M04 extras, OCR/AI, cloud/network search, persistent indexing | Outside this chunk |

Individual frontend total: **219 existing + 28 search UI + 7 fixture tests = 254**.
All existing test files/assertions are unchanged. New tests use real domain/MemoryAdapter and the
existing style of lightweight event/DOM harness; they do not invoke a browser.

UI coverage includes entry wiring and unchanged tabs/routes; empty/mixed content; OR/AND and dates;
IME and exact debounce; stale success/error races before the next dispatch; cursor recovery and retry
limit; bounded paging; literal XSS/regex-looking/long strings and normalized-excerpt false positives;
body/caption hydration races; reading/back with edits and interrupted hydration; successful-only source
mutation notifications; favorite CAS/failure/durability/draft isolation and museum authority; tag rename,
merge/delete/re-entry; trash/restore/import/merge; focus restoration in the harness.

During development, an initial typecheck ran before the search View addition and reported that pending
route type; later full typechecks passed. Two test-fixture issues (missing DOM `replaceWith` and an invalid
synthetic tag reference) were corrected without weakening product assertions. An early isolated targeted
test had no worker diagnostics; explicit individual execution and the final normal npm run both passed.
Review found and fixed interrupted cached hydration, interrupted staged rendering, focus loss and unsafe
highlight interpretation of a normalized excerpt; regression tests now cover those findings.

## Performance — measured scope only

Command (no downloads/install):

```sh
export PATH=$HOME/.cargo/bin:$PATH
export CARGO_NET_OFFLINE=true
SHIGUANG_SEARCH_STRESS_OUT=/tmp/u12-ui-search-release.json cargo +1.90.0 test --release --locked -p shiguang_core --test unit012_stress -- --nocapture
```

| Release sample | Milliseconds |
|---|---:|
| Cold Store open + first query | 266.930 |
| Warm first 1 / 2 / 3 | 77.560 / 77.383 / 76.827 |
| Page 2 / 3 / 4 | 76.697 / 78.071 / 78.211 |
| Combined first | 75.178 |

[Raw release JSON](unit-0.12/search-benchmark-rust-release.json): 5,000 records, 6,250 PhotoUses,
16,632,810 state bytes, 2,440–2,459 UTF-8 body bytes; 1,000 keyword and 250 combined matches;
50 items per benchmark page, four pages produce 200 unique IDs. Cold means a new Store plus query,
not flushed OS caches. These results include neither native IPC nor UI frames/photo decoding.

The 10,000 ms regression guard is **not a UX target**. Prior orchestrator debug/TS measurements remain
in [ORCHESTRATOR_VERIFICATION.md](unit-0.12/ORCHESTRATOR_VERIFICATION.md); the ~350 ms synchronous
TS preview scan is still material. No core optimization, fingerprint weakening or backend cache was made.
The UI waits 450 ms after composition/input settles, provides explicit submit, and requests 24 cards.
Extra full-record reads are only for hits the projection cannot explain, sequentially yielded and request-
generation guarded. This avoids an unconditional 24-read burst but does not prove browser responsiveness.

## Exact changed files

| Files | Purpose |
|---|---|
| `src/domain/navigation.ts` | Added secondary search View/preview route; existing five tabs preserved |
| `src/ui/index.html`, `src/ui/main.ts` | Entry/route/reader integration, mutation invalidation, explicit demo startup, lazy thumbnail attributes |
| `src/ui/search.ts` | Search controls, paging/session/race handling, formal snippet hydration, favorites |
| `src/ui/search-card.ts`, `src/ui/search.css` | Safe formal excerpts/highlighting and token-based responsive UI |
| `src/ui/search-source.ts` | Successful formal-authority mutation notifications |
| `src/ui/search-demo.ts` | Isolated deterministic synthetic fixture through existing APIs |
| `scripts/copy-ui.mjs` | Include search CSS in existing frontend build |
| `tests/support/search-dom.ts` | Event/text-node harness following museum harness conventions |
| `tests/unit012-search-ui.test.ts` | 28 UI/behavior regressions |
| `tests/unit012-search-demo.test.ts` | 7 fixture/gating/isolation regressions |
| `evidence/unit-0.12/SPEC.md` | UI contract and current verification supplement |
| `evidence/unit-0.12/BROWSER_CHECKLIST.md` | Parent URLs/setup/actions/testIDs and pending screenshot matrix |
| `evidence/unit-0.12/search-benchmark-rust-release.json` | Exact release benchmark output |
| `evidence/UNIT0.12_REPORT.md` | This handoff/status report |

Existing untracked `src-tauri/gen/` was left untouched. No installer/APK/Tauri bundle, deploy, global
install, private-data access, network feature, auth/account/config/signing/workflow changes, git staging,
commit/push/merge/history changes, browser launch, Playwright/CDP, screenshots or repository patch dumps.

## Parent handoff

Built assets are in `dist/`. On the host, start the existing `node scripts/preview-server.mjs` if needed,
then use computerUse with:

- Mixed: `http://127.0.0.1:1420/?searchDemo=mixed&view=search`
- Empty: `http://127.0.0.1:1420/?searchDemo=empty&view=search`

These URLs explicitly reset only the dedicated synthetic fixture. Do not reload during mutation or
reading/back checks. Theme changes use the existing 我的 → 主题与外观 controls.
Exact setup, expected record IDs/counts, keyboard/IME actions, safe literal checks and the pending
phone/theme screenshots (desktop matrix deferred) are in [BROWSER_CHECKLIST.md](unit-0.12/BROWSER_CHECKLIST.md).
The preview bind restriction is an environment blocker, not a claim that any browser check passed.

## NOT_RUN

- Parent computerUse phone browser interactions/screenshots, real Android native install/upgrade/IPC, actual Chinese IME, screen reader and font scaling; no browser/device PASS claimed.
- CI pending current pushed UI tip; actual status will be recorded separately.

## BLOCKED

- No shared-suite blocker on the box: orchestrator reran cargo 241, fault 291, npm 254, typecheck/build all PASS after UI finished. The historical Codex sandbox port bind restriction does not prevent the host preview server.
- Need parent computerUse for permitted browser verification (executor does not drive browser from Shell).

## DEFERRED

- macOS/Windows specialized UI/build acceptance and desktop screenshots per newest owner scope. Existing code preserved.
- Existing story-block editor, OCR/AI/cloud search, deployment, installers outside current authorization.

## Orchestrator verification supplement

2026-11-25 UTC+8: full shared test suites rerun on box after UI completion: cargo 241, fault-injection 291, npm 254; typecheck and frontend build exit 0. Release benchmark rerun and raw JSON refreshed: cold open+first 266.930 ms, warm first 76.827–77.560 ms, later pages 76.697–78.211 ms. Synthetic Linux only; phone performance remains NOT_RUN.
