# H1 · One-shot reuse for the first museum home summary

**PASS.** The single default-concurrency `npm test` run passed 297 tests, including all 12 H1 cases. On the 5,000-record, 5,000-photo-use U011 fixture, the home summary adapter took **1.361 ms** against its strict **<150 ms** gate. The cause of the historical **313.050 ms** event remains **INCONCLUSIVE**. [Run and timings](h1-parse-reuse/npm-test.txt) · [Historical observation](home-summary-investigation/REPORT.md)

PR12 worktree on `feat/mobile-stage23`, based on `1bad41d3f21fc68866d6a0c53f13cb304cf055c7`. Production writes outer 1 / schema 5. The candidate migration and its durable `confirmed=1` commit witness are at the M1 baseline. [Store version](../../core/src/store.rs#L22) · [Schema version](../../core/src/schema.rs#L3) · [M1 evidence](M1_COMMIT_WINDOW.md)

## Reuse and invalidation

- Eager construction and a successful `storeStatus()` both open the store. Each open reads the instance's key and pairs the exact source string with the adapter's private state only after the full parse, migration, and validation succeed. A deferred constructor performs zero reads. Ordinary reloads give callers a freshly parsed state or a deep copy. [Open and reload](../../src/platform/memory-adapter.ts#L136)
- Inside the original adapter clock, the summary resolves the call's date, runs `check()`, then calls `getItem` on the same storage and key. An exact string match allows one read-only pass over the opened state. A different string goes through the full reload on that very read. An absent key or storage uses `copy(this.state)`. A throwing read yields `IO_ERROR`. The summary releases eligibility on every return and throw. [Summary](../../src/platform/memory-adapter.ts#L900)
- The domain function recomputes all seven counts each call. It counts hidden rows before filtering for active formal records. The query leaves the local conflict baseline in place, including when another instance commits new bytes. [Counts](../../src/domain/museum.ts#L97) · [Conflict baseline](../../src/platform/memory-adapter.ts#L558)
- Local write attempts clear eligibility before fault injection or input validation. Persistence also clears it before writing, including conditional media quarantine. Reset, backup selection or unlock, overwrite restore, merge, and replacement of local state clear it. A new open drops the previous eligibility before checking for errors. A subsequent successful open can grant one use again. [Write checks and replacement](../../src/platform/memory-adapter.ts#L117) · [Persistence](../../src/platform/memory-adapter.ts#L214) · [Status](../../src/platform/memory-adapter.ts#L304)

## Focused checks

The H1 tests compare complete seven-field results or exact error codes. For each summary they inspect the storage key and read count, the strings passed to the real JSON parser, every stored string before and after, and the number of write attempts. The observations are local to the focused test file. [Tests and assertions](../../tests/home-summary-reuse.test.ts#L12)

| Cases | What the tests observed |
| --- | --- |
| Eager, deferred, missing-key and memory-only opens | A hit still read the key and performed zero parses. A second call parsed once. Calls before deferred open parsed each time. Missing storage and removed keys cloned local state. |
| External replacement and failed opens | An equal-length date change affected the reunion count. Legacy input migrated in memory. Malformed JSON, a same-length invalid setting and a dangling tag yielded `STATE_CORRUPT`. A newer schema yielded `SCHEMA_TOO_NEW`. Restoring the old bytes after a miss or failed open required a full parse. |
| Dates and error precedence | Leap day and the following local day produced different counts. Tests exercised a throwing date provider, startup error, one-shot `failNext`, throwing `getItem`, and invalid dates on both the hit and full-validation paths. |
| Local state and shared storage | Two instances retained independent eligibility. The reader saw another instance's commit and preserved its original draft on conflict. Failed writes, a failed quarantine, reset, a no-op write and `getRecord` replacement all exercised invalidation. |
| Content and import | Publication, photo and tag changes, hiding, trash, restore, purge, backup selection, failed safety copies, overwrite and merge produced the expected counts and storage writes. |

## Verification

| Command | Result |
| --- | --- |
| `node --test tests/home-summary-reuse.test.ts` | Exit 0. The standalone reporter emitted a file-level pass. All 12 named cases appear in the full run. [Standalone log](h1-parse-reuse/focused.txt) · [Named results](h1-parse-reuse/npm-test.txt) |
| `npm test` | One launch of `node --test tests/*.test.ts` with default file concurrency. 297 passed, 0 failed, 0 skipped. Only the reunion page adapter has the 200 ms exception. [Full log](h1-parse-reuse/npm-test.txt) · [U011 timing definitions](../../tests/unit011-museum.test.ts#L447) |
| `npm run typecheck` | Exit 0. [Typecheck log](h1-parse-reuse/typecheck.txt) |
| `npm run build` | Exit 0. [Build log](h1-parse-reuse/build.txt) |

The sandbox exposed the Node workers' output descriptors as sockets while Node selected a sink that discarded their test names and diagnostics. A temporary `NODE_OPTIONS` preload forwarded worker stdout and stderr to those same descriptors. A named synthetic probe confirmed delivery before the full run. The U011 test file had the same Git blob at HEAD and in the tested worktree. [Output transport and source](h1-parse-reuse/output-transport.txt) · [Probe](h1-parse-reuse/output-probe.txt) · [Command ledger](h1-parse-reuse/ledger.txt) · [Baseline and blobs](h1-parse-reuse/baseline.txt)

Verification used Node 24.22.1, npm 11.21.1, Rust 1.90.0, the requested Cargo PATH prefix and `CARGO_NET_OFFLINE=true`. The requested agent runtime was `gpt-6.2-astra` / `max` / `priority` (Fast). The shell did not independently expose the session's model, effort or tier.

## NOT_RUN

Full Cargo and M1 fault/recovery tests, schema 6 writer activation, browser/CDP/Playwright, native and device checks, deployment, additional performance samples, and profiling of heap retention or real preview hit rates. The H1 worktree is uncommitted for the orchestrator.

## Independent orchestrator verification

2026-11-26 23:55–23:56 Asia/Shanghai. One uninstrumented run of each suite, default scheduling, no `NODE_OPTIONS`, no rerun.

| Command | Observed result | Exit |
| --- | --- | ---: |
| `cargo +1.90.0 test --locked --workspace` | 260 passed, 0 failed, 1 historical generator ignored | 0 |
| `cargo +1.90.0 test --locked -p shiguang_core --features fault-injection` | 324 passed, 0 failed, 1 ignored | 0 |
| `npm test` (`node --test tests/*.test.ts`) | 297 passed, 0 failed; `adapter.homeSummary` **1.908 ms** under the unchanged **<150 ms** gate | 0 |
| `npm run typecheck` | passed | 0 |
| `npm run build` | passed | 0 |

This single passing sample does not attribute or retire the historical 313.050 ms failure, which remains INCONCLUSIVE. Production writer remains outer 1 / schema 5. Raw independent logs are under `/workspace/sg-stage23/m1-h1/independent-h1/`.
