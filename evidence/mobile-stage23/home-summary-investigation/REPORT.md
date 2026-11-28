# Home summary regression blocker

**INCONCLUSIVE for the original 313.050 ms failure. The default npm gate remains BLOCKED.** On 2026-11-26 in Asia/Shanghai, the one instrumented observation measured 132.048 ms against the 150 ms home adapter limit. Its main thread spent 123.539 ms on CPU and 4.390 ms runnable but waiting. The largest measured cost was the fresh JSON parse. The breach did not recur, and the observation provides no evidence of removable work sufficient to explain the original failure. [Original npm console](../migration-safety-independent/npm.log.gz) · [Phase measurements](measurements.json)

| Decision or run | Result |
| --- | --- |
| Original uninstrumented `npm test` | Exit 1, 284 cases passed, one failed. Home adapter 313.050 ms. Whole U011 case 786.313605 ms. |
| One full-file-set observation | Exit 0, 28 files passed. All 18 original U011 timings and the final correctness assertions completed. Home adapter 132.048 ms. |
| TypeScript fix | None. The measured parse reads the authoritative synthetic storage required by this path. |
| New uninstrumented default acceptance | **NOT_RUN**. The reserved second slot closed unused. |

## Evidence from the original launch

The independent runner recorded the following commands on November 26. End times are derived from starts plus durations rounded to milliseconds. The six uncompressed originals matched the archived gzip payloads and recorded SHA-256 values. Log creation and last-write timestamps, including those for `results.json`, are preserved separately from command times. [Original times, file timestamps and hashes](original-evidence.json) · [Independent manifest](../migration-safety-independent/manifest.json)

| Own workload | Local start–end | Recorded result |
| --- | --- | --- |
| Cargo workspace | 00:34:29.509–00:35:09.630 | 260 passed, 1 ignored |
| Cargo fault injection | 00:35:09.631–00:35:55.080 | 318 passed, 1 ignored |
| Default npm | 00:35:55.080–00:35:58.317 | 284 passed, 1 failed |
| Typecheck | 00:36:51.955–00:36:54.202 | Exit 0 |
| Build | 00:36:54.203–00:36:55.811 | Exit 0 |

The command records show a sequential handoff from fault injection to npm. The last of eight earlier candidate commands ended at 00:29:41.211. The npm console also records a separate 5,000-row UI home render of 758.0 ms. Its worker PID and interval relative to the failed call are unknown. File order in the console gives no cross-worker timeline. [Candidate command log](candidate-commands.jsonl) · [Original npm console](../migration-safety-independent/npm.log.gz)

The original log establishes that the domain/adapter equality and domain budget assertions passed before the adapter assertion threw. The remaining queries and the final timing diagnostic were never reached. The exact domain time, original input digest, per-phase times, inner absolute start/end, worker PIDs, thread/process CPU, runnable wait, GC, heap, host load, pressure and cgroup throttling during that call are unavailable. The permitted project records have no matching resource trace. The visible system accounting archives had no historical samples, and the later command-name snapshot contained only processes started after the failure. Other host workload during the call is unknown. [Evidence inventory](original-evidence.json) · [Assertion order](../../../tests/unit011-museum.test.ts#L445)

Earlier independent plain runs reported home adapter times of 25.350, 35.512 and 61.363 ms. All ten home wall times from the earlier scheduling investigation are retained in the inventory. Its detailed resource probes targeted the reunion page in different processes. The current 74 tracked source, test and package files matched the original gate's base. Source identity and earlier timings leave the original cause unresolved. [Earlier investigation](../perf-investigation/REPORT.md) · [Previous default pass](../acceptance-200/npm.log.gz) · [Source verification](integrity.json)

## What the timer covers

The stress case creates 5,000 rows, adds photos and flags, serializes the state to a synthetic Map and constructs the adapter. Its constructor immediately reloads and validates that state. The test then builds the query tables and times the pure domain summary. A fresh `performance.now()` pair surrounds only `await adapter[name]!()`. For home summary it covers the injected date, failure check, Map read, JSON parse, validation, summary calculation and promise resumption. Equality, budgets and the later queries follow that interval. [Stress case](../../../tests/unit011-museum.test.ts#L422) · [Synthetic device](../../../tests/support/museum.ts#L35) · [Eager open and reload](../../../src/platform/memory-adapter.ts#L114) · [Adapter entry](../../../src/platform/memory-adapter.ts#L882)

## Measured work in the observation

The home adapter interval ran from 00:44:10.816 to 00:44:10.948. All values below are milliseconds. Subphase wall times use adjacent probe entries clipped to the original clock. GC overlap is the union of recorded GC entry intervals and may coincide with execution or wait. [All 18 clocks and phase counters](measurements.json) · [Raw worker trace](trace.json.gz)

| Scope | Wall | Main CPU | Runnable wait | GC overlap |
| --- | ---: | ---: | ---: | ---: |
| Fixture setup through device return, outside both query clocks | 306.729 | 266.074 | 33.454 | 23.594 |
| Eager JSON parse within setup | 32.793 | 31.883 | 0.076 | 19.910 |
| Original domain clock | 10.138 | 9.996 | 0.011 | 0.000 |
| **Original adapter clock** | **132.048** | **123.539** | **4.390** | **0.000** |
| Adapter entry, Map read and pre-parse checks | 0.083 | 0.103 | 0.000 | 0.000 |
| JSON parse | 112.267 | 105.282 | 3.107 | 0.000 |
| State, IDs, rows and conflict headers | 10.633 | 9.114 | 1.268 | 0.000 |
| Snapshots, photos and assets | 5.560 | 5.550 | 0.004 | 0.000 |
| Tag and settings validation | 2.195 | 2.181 | 0.011 | 0.000 |
| Reload return through summary entry | 0.048 | 0.044 | 0.000 | 0.000 |
| Summary validation and counting loop | 1.153 | 1.157 | 0.000 | 0.000 |
| Final count assignment, return and await resumption | 0.109 | 0.108 | 0.000 | 0.000 |

Main-thread CPU accounted for 93.6% of the adapter wall interval. The OS charged 22.344 ms to user CPU and 101.195 ms to system CPU. Within the parse it charged 14.828 ms user and 90.454 ms system. Linux schedstat independently recorded 123.539 ms of execution over 36 slices. Total process CPU was 128.421 ms. Wall less execution and runnable wait leaves 4.119 ms unclassified. This measures CPU charged during the parse. The capture has no syscall, fault, allocation, JIT, kernel or hypervisor trace to explain the system time. Of 35 GC entries in the museum worker, none intersected the adapter clock. A 19.461 ms GC entry began 0.511 ms after it. GC entry delivery cannot exclude unreported concurrent work. [Raw counters and GC entries](trace.json.gz)

Row creation, decoration, and serialization/storage took 36.022, 13.353 and 173.353 ms respectively before the constructor read. The two parses operated on the same fixture at different points in the process's lifetime. The input measured 6,847,994 UTF-8 bytes with SHA-256 `4414a194cd52718f3412ebfbffe97bcec5ae29ea905a8a8b66ed9148e37494e9`. It contained 5,000 active formal rows, zero drafts and 5,000 photo uses referencing one asset ID, with zero stored asset entries. Each successful reload on this input entails one parse, 5,000 row checks, 10,000 snapshot slots, 5,000 non-null snapshots/photo checks, and 5,000 tag-row checks. Those visit counts follow from the verified input and loops. The probes ran at phase boundaries. [Fixture fingerprint](../perf-investigation/scratch/input.json) · [Validation loops](../../../src/platform/memory-adapter.ts#L150) · [Tag validation](../../../src/domain/tags.ts#L134)

The adapter and domain both returned 5,000 records, 48 reunions, 1,000 favorites, 5,000 photos, 30 years, 4,380 eligible and 136 hidden. All seven matched the archived result. The final stored bytes matched the initial hash, and the write count was one throughout the read workload. All eight domain/adapter equalities and both continuation checks completed. The observer's console reports file results. The 285-case census comes from the source and the historical default run. [Correctness and raw timings](trace.json.gz) · [Observed console](console.log.gz) · [Source census](../perf-investigation/scratch/reconcile/cases.json)

## Concurrency, overhead and decision limits

The observation used Node v24.22.1, V8 13.6.233.17-node.58 and Linux 6.12.113+ on an x86-64 Intel Xeon. Eight logical CPUs were visible, with affinity and effective cpuset 0–7. The visible cgroup v2 leaf had `cpu.max = max 100000` and zero throttling deltas during both the launch and target. At the target edges, 1/5/15-minute load was 0.28/0.41/0.50 and runnable/total tasks went from 14/1103 to 8/1093. Leaf CPU pressure accumulated 57.391 ms “some” and 1.340 ms “full” across the context reads. Those aggregates include other work. Root and leaf counters, memory and host pressure snapshots are in the ledger. [Launch environment](ledger.json) · [Target context](trace.json.gz)

All 28 worker identities matched the coordinator's directly sampled children. Seven distinct sibling workers accumulated CPU across 17 polls wholly inside the home call, with at most six siblings in a single poll. The 305 polls cost the sampler 75.112 ms of its own CPU over the launch, including 4.493 ms in those 17 polls. Target marker reads occupied 0.324 ms inside the adapter clock. The outer CPU-counter envelope exceeded the native interval by 0.035 ms. Subphase CPU and wall edges are sampled at slightly different instants, which matters for sub-millisecond rows. Preloading, changed JIT/heap state, GC event collection and the sampler's scheduling effects have no paired overhead control. The two pagination continuation clocks include their opening probe. [Worker exits](workers.jsonl.gz) · [Raw schedstat samples](samples.json.gz) · [Collector](observe.mjs) · [One-launch runner](capture.py)

One of two authorized test/diagnostic slots was used. The original run is the sole failed test launch. A postprocessing helper exited 1 on a Python dictionary syntax error. The corrected reader processed the saved bytes and all reconciliation checks passed. For conservative stopping, the ledger charges that exit as well and records **2/3** overall, with one occurrence of the helper problem and zero new nonzero test launches. No further sample or profiler ran. The current size of the required parse establishes neither the original cause nor a speedup. [Frozen decision rule](PLAN.md) · [Launch and failure ledger](ledger.json) · [Offline stderr](offline-helper.stderr.gz) · [Offline reduction](offline-reduce.py.gz)

Before and after the observation, all **9** migration candidate files matched their manifest and preserved copies, all **15** frozen v3/v5 artifacts matched their hashes, and all **10** oracle originals matched their manifest and preserved copies. The production writer still uses outer 1/schema 5. Only investigation evidence was added. [Integrity record](integrity.json) · [Outer version](../../../core/src/store.rs#L22) · [Schema version](../../../core/src/schema.rs#L3)
