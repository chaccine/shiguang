# Unit-0.12 core verification · 2026-11-25

Implemented core/data/adapters/tests on `unit-0.12` from `f8df685`; **UI not implemented**.
Overall native/build verification is **BLOCKED**, not a complete M05 release PASS.
Only synthetic local fixtures were used. No network fetch/install, browser launch, Playwright/CDP,
screenshot, deployment, package/bundle, account change or git write was performed.

## Actual commands and outcomes

| Command | Outcome | Evidence |
| --- | --- | --- |
| `npm test` | **PASS: 24 files, 0 failures** on final source | `npm-test.txt` |
| `node --test --test-isolation=none tests/*.test.ts` | **PASS: 219 cases, 0 failed/cancelled/skipped** | `npm-cases.txt` |
| `node --test --test-isolation=none tests/unit012-search.test.ts` | **PASS: 15 cases, 0 failures** | `search-tests.txt` |
| `SHIGUANG_SEARCH_STRESS_OUT=/tmp/unit012-search-ts-benchmark.json node scripts/benchmark-u12.mjs` | **PASS: asserted counts, four-page uniqueness, no storage writes, per-call budget** | `search-benchmark-node.json` |
| `npm run typecheck` | **BLOCKED: exit 127, `sh: 1: tsc: not found`** | Observed tool output; dependencies absent |
| `npm run build` | **BLOCKED: exit 127, `sh: 1: tsc: not found`** | `build-blocker.txt` |
| `export PATH=$HOME/.cargo/bin:$PATH; rustc --version` | **BLOCKED:** rustup could not create `/home/box/.rustup` on read-only filesystem | Observed tool output |
| `export PATH=$HOME/.cargo/bin:$PATH; export CARGO_NET_OFFLINE=true; cargo check --locked -p shiguang_core` | **BLOCKED:** same rustup/toolchain bootstrap error; compilation did not start | Observed tool output |
| `cargo test --locked --workspace` | **BLOCKED / NOT RUN:** requested Rust 1.90 unavailable; no additional failed bootstrap retries | No Rust test result/count claimed |
| `cargo test --locked -p shiguang_core --features fault-injection` | **BLOCKED / NOT RUN:** same missing Rust 1.90 prerequisite | No fault-suite result/count claimed |
| `git diff --check` | **PASS** | Final local check |

The two Node totals describe the same suite, not additive results. The benchmark is separate from the
219 cases. The prior baseline had 204 cases; 15 new search cases bring this to 219. Existing test assertions
and regression budgets were not weakened. Final command logs are copied as text under this directory.

Environment inspection: Node **v24.22.1**, npm **11.21.1**. Repository `node_modules` is absent; no `tsc`
was found in the existing global Node module tree. `/home/box/.cargo/bin/{cargo,rustc}` are rustup shims,
`/home/box/.rustup` is absent, and the only directly observed system compiler is `/usr/bin/rustc` **1.85.1**.
It was queried for its version only, not substituted for the requested 1.90 toolchain. No dependencies or
compiler were installed, no account/auth/quota settings changed, no fallback Codex run was launched.
Missing Rust/toolchain and missing tsc each failed twice; no third retry was made.

## What changed and coverage

- `core/src/search.rs`: SearchFilter/SearchPage, active FORMAL literal matching, reusable M02 filter/order/card
  projection, query/source fingerprints, bounded cursor wrapping, and Store API. `query.rs` exposes the existing
  filter validator within the crate. `lib.rs` exports the new API; error-code constants are added.
- `src-tauri/src/u012_cmd.rs`: one locked read command with typed filter, reused M02 filter input, native errors
  and unchanged `TimelineItem` payload. Registered in `lib.rs`; `u07_cmd.rs` exposes its conversion internally.
- `src/domain/search.ts`, `types.ts`, `errors.ts`, `src/platform/{api,memory-adapter,tauri-adapter}.ts`:
  corresponding query contract, current storage reload, defaults/arguments/error propagation, refresh errors.
- `core/tests/unit012_search.rs`: **9 normal behavior tests plus 1 feature-gated fault test authored, NOT RUN**.
  `core/tests/unit012_stress.rs`: **1 benchmark test authored, NOT RUN**. No native PASS is inferred from TS.
- `tests/unit012-search.test.ts`: **15 executed tests**. `scripts/benchmark-u12.mjs`: executed synthetic benchmark.
- Package/Cargo/Tauri/thumbnail version manifests and all local-package lockfile entries set to 0.1.12;
  README adds current chunk/status links. Unrelated dependency versions remain unchanged. Schema v5 stays intact.

| Behavior | Executed TS evidence | Authored native evidence (not executed) |
| --- | --- | --- |
| Each title/body/PhotoUse caption/location/current tag field; multiple hits deduped; no cross-field/OCR match | Field test, 8 records, individual expected IDs | `each_field_literal_unicode_and_unique_record_matching` |
| Chinese/English substring, trim/BOM, emoji/combining Unicode, regex/script-looking literal input | Literal/Unicode tests | Field/Unicode test |
| Keyword × 4 tag selections × date range × favorite × 3 photo states × 2 orders | 192 combinations with independent expected membership; clear-all/reset | `all_192_filter_combinations_and_reset` |
| Leap years/centuries, inclusive/open ranges, malformed/reversed dates and invalid limits | Date/limit test | `inclusive_leap_ranges_validation_and_limits` |
| Active formal only, hidden included, no-title/no-photo, photo-only, draft-only/trash excluded | Formal-only test and mutation tests | Field, formal-only and caption tests |
| Same-day time/createdAt/ID ties, both orders, 103 rows in pages of 7 | Full M02 order comparison, unique exact sequence | `same_day_full_m02_ties_both_directions_and_cursor_mismatch` |
| Every query dimension/direction/day mismatch, malformed/oversized cursor, normalized equivalent filters | Cursor and equivalent-tag-set tests, nested malformed inputs | Cursor test including nested parser guards, fingerprint golden |
| Equal-revision changed content/source, nonmatching source change, metadata, draft-only non-invalidation | Source-generation test plus public adapter operations | Source-generation and mutation tests |
| G01 independent favorites/tags while editing, caption uses sharing same asset, explicit commit | Real MemoryAdapter mutations; current favorite retained | Formal/metadata and shared-caption tests |
| Rename/merge/delete; failed writes retain current results | Mutation and failure tests; existing full G01–G06 suite | Native transaction/fault tests |
| Backup overwrite, imported tags/links, repeated merge, trash/purge anti-resurrection, reopen | Backup test and metadata test | Backup/merge/deletion test |
| Domain/adapter command consistency | Tauri wire/default/error tests; command registration source assertion | Native command source added; compilation/IPC NOT RUN |
| Query/source SHA-256 tuple contract | Independent explicit UTF-8 JSON golden hashes match TS | Same golden assertions authored in Rust |

The initial TS run had two test-authoring failures: a loop count counted 96 filter combinations before
including two orders, and a backup assertion assumed remote rename overwrote a local live tag. The tests
were corrected to count 192 order-inclusive cases and follow the existing merge authority, with added
coverage for incoming tags/links and retained local names. Search/product behavior was not loosened to
make those assertions pass. Both corrected tests and all final suites passed.

## Measured performance

Node/Linux x64, Intel Xeon, 8 logical CPUs, 16,779,689,984 reported RAM bytes; synthetic state **16,795,302 bytes**.
5,000 records / 6,250 PhotoUses / two tags. UTF-8 field bytes: title 31–34, body 2,440–2,459, location 30,
caption 132 per use, tag name 12–19. Raw machine data/counts/timings: `search-benchmark-node.json`.

| Sample | Measured ms | Returned / total |
| --- | ---: | ---: |
| Pure domain first call | 453.603 | 50 / 1,000 |
| Pure domain warm first, 3 samples | 347.041 / 337.662 / 350.346 | 50 / 1,000 each |
| MemoryAdapter cold construction + first query | 375.178 | 50 / 1,000 |
| MemoryAdapter warm first, 3 samples | 354.669 / 366.200 / 344.853 | 50 / 1,000 each |
| Subsequent pages 2 / 3 / 4 | 344.263 / 350.507 / 345.775 | 50 / 1,000 each |
| All dimensions combined | 331.823 | 50 / 250 |

Four pages: 200 distinct IDs, no duplicates. Storage bytes unchanged. Each timed call includes on-demand
formal source hashing; adapter calls also include JSON reload/validation. The generous **10,000 ms per-call**
regression guard passed on this machine. It is not an interaction-latency target or a device performance
claim. Cold is a new adapter/store, not dropped OS caches; native cold/open and subsequent-page timings
remain **BLOCKED / NOT RUN**. Rust's authored 10,000 ms debug guard is provisional until measured.

## Remaining work / blockers

1. Supply the already approved local Rust 1.90 toolchain/cache and project npm dependencies, then run the two
   required cargo suites, native benchmark, `npm run typecheck`, and `npm run build`. Resolve any compile/test
   findings before treating the core chunk as release-verified. Native Tauri compilation/IPC is also unverified.
2. Implement the next UI chunk described in SPEC: routes/entries, filters/IME/debounce, states/chips/reset,
   safe highlighting, existing cards/reading/favorite/tag mutations, stale-response rejection and return context.
3. Parent performs permitted computerUse browser checks and later native/device verification. This run made
   no browser/UI/device/installer claims. Story blocks/editor, OCR/AI/cloud and schema expansion remain deferred.

No commits/staging/merges/pushes were made. Existing untracked `src-tauri/gen/` remains untouched and outside
this change set. All requested work here is confined to the core chunk; UI stops at the documented handoff.
