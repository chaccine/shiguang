You are doing a bounded code review plus investigation only. Do not implement fixes, do not edit application or test source, do not change thresholds, and do not activate schema 6.

Workspace: read the repo at /workspace/shiguang-app (explicit local exception). Write your report and any new evidence ONLY under /workspace/sg-stage23/ultra-review/ (this is the writable workdir). Do not write into /workspace/shiguang-app at all, including evidence/, core/, src/, tests/. src-tauri/gen remains untracked and must not be touched. Preserve byte-for-byte the 9 uncommitted candidate files in /workspace/sg-stage23/home-summary/CANDIDATE_PREIMAGE.json and the 10 oracle originals in /workspace/shiguang-app/evidence/mobile-stage23/perf-investigation/ORACLE_PREIMAGE.json. Also do not modify /workspace/sg-stage23/migration-safety/preserved-candidate.

Exact runtime already verified: model gpt-6.2-astra, model_reasoning_effort=ultra, service_tier=priority (official Fast). Do not change account, auth, model, effort, or tier. Do not fall back to max. No other Codex/agents, no resume --last, no browser/CDP/Playwright, no packages, commits, push, PR edits, paid/deploy, sudo/global installs, or private user data.

## Context (already measured; do not treat a new green run as solving the original failure)
- Default uninstrumented npm failure (gate of record): homeSummary adapter 313.050 ms > unchanged 150 ms. Whole U011 case 786.313605 ms. 284/1. Log: /workspace/shiguang-app/evidence/mobile-stage23/migration-safety-independent/npm.log.gz and MIGRATION_SAFETY_BLOCKED.md.
- One later instrumented default-concurrency observation: 132.048 ms; main CPU 123.539 ms; runnable wait 4.390 ms; JSON parse 112.267 ms (system CPU 90.454 ms). Did not reproduce the 313 ms breach. Verdict remains INCONCLUSIVE for the historical timeout. Full report: evidence/mobile-stage23/home-summary-investigation/REPORT.md, measurements.json, ledger.json, PLAN.md. PR12 tip a87573d04763f97f575a4fbd060df00696ad351e.
- Only reunionPage adapter has an approved 200 ms exception. Do not propose or apply expanding 200 ms to homeSummary or any other path. Do not change timing definitions, default npm scheduling, or assertions.
- Production writer remains outer 1 / schema 5. Uncommitted T4.2b candidate migration code exists in the worktree (core/src/migration.rs and related store/persist/backup/fault changes) plus evidence/mobile-stage23/MIGRATION_SAFETY.md. Independent default npm after that work is what hit homeSummary 313 ms; JS src/tests/package/lock were identical to c9eff05.

## Review scope (narrow, not a whole-repo audit)
Read and review only:
1) Home/timeline first-screen summary path and MemoryAdapter full-library JSON read, parse, and validation (especially eager constructor reload vs the timed adapter.homeSummary call). Tests: tests/unit011-museum.test.ts timing definition; tests/support/museum.ts; src/platform/memory-adapter.ts; src/domain/museum.ts; related query/timeline UI only as needed to see whether the test times a realistic path.
2) The measurement contract: what is inside vs outside the 150 ms clock (fixture construction, eager open, domain vs adapter, later queries).
3) Correctness and risk of the uncommitted candidate migration transaction (install/recover/pending record, preimage bytes, writer fencing, rollback, lock contract). Look for definite correctness or G01–G06 hazards.

## Required output
Write /workspace/sg-stage23/ultra-review/REVIEW.md in Chinese or bilingual clear technical prose, plus a compact machine-readable /workspace/sg-stage23/ultra-review/FINDINGS.json.

Classify every finding as exactly one of:
- CONFIRMED defect (falsifiable: file/line, expected vs actual, how to test)
- POSSIBLE hotspot or residual risk (what evidence exists, what would confirm/falsify)
- REJECTED or out-of-scope suggestion that would weaken default acceptance (e.g. relaxing 150 ms, changing the clock to exclude parse/validation, serializing the default suite, pinning CPU, retrying until green)

If you can propose a minimal later optimization (for example avoiding a second full-library JSON parse on the first adapter.homeSummary when a fresh validated in-memory snapshot already exists, without weakening fresh-read or validation constraints), describe the scheme, invariants to preserve (fresh authoritative read after writes, no stale counts, error/date behavior, invalidation safety, G01–G06), tests that would be required, and residual risks. Do NOT implement it in this round. Do not introduce a new data format or touch the schema writer.

If you find a clear correctness loss or G01–G06 risk, stop further optional work and report it immediately in the review. Do not silently patch.

Do not run a full default npm/cargo regression to chase green. You may read existing logs, source, and prior traces. A new observational/profile launch is allowed only if a specific review claim cannot be decided from existing evidence; if so, pre-register the single command and hypothesis in /workspace/sg-stage23/ultra-review/OPTIONAL_LAUNCH.md first, keep original assertions and 150 ms, do not isolate/serialize to hide concurrency, and do not treat a sub-150 observation as fixing the 313 ms event. Prefer not launching if existing evidence already locates the parse as the observational hotspot. New same-path failed test launches remain countable; stop at cumulative 3 including the original 313 ms failure (current failed default tests for this path: 1).

End with: (a) whether the original 313.050 ms cause is still INCONCLUSIVE; (b) confirmed vs possible findings; (c) recommended next minimal fix or an optimization that needs Cine confirmation; (d) what remains NOT_RUN. Recheck the candidate and oracle hashes at the end and include the result.
