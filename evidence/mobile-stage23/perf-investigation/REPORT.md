# PR12 museum performance investigation

**Verdict — INCONCLUSIVE. The plain npm gate remains BLOCKED.** All ten scheduled diagnostic processes exited 0. All 180 original museum timings completed below 150 ms. The largest reunion adapter observation was 35.188 ms. The last independent, uninstrumented default npm run at this head still stands at 284 passed, one failed, with a 172.558 ms reunion adapter call. The 606.556 ms in that log measures the entire case. [Launch registry](scratch/registry.json) · [Plain npm failure](historical/blocked-npm.log#L304)

Four of five pairs had a positive P−I difference. The median paired difference was **7.648 ms**, below the required **12.599 ms** within-arm range. Neither arm reproduced the target breach. Under the frozen decision rule, the evidence warrants neither a separate profile nor a change to scheduling or query code. [Preregistered criteria](PREREGISTERED_PLAN.md) · [Prelaunch milestone](HYPOTHESIS_MILESTONE.md)

## Five paired observations

The ten launches ran on 2026-11-25 from 23:13:18 to 23:17:58 Asia/Shanghai under `feat/mobile-stage23@21691ea`. P used Node's default file concurrency across all 28 test files. I used the same process isolation with the entire museum file. Both kept the 18 preceding museum cases and original query order in place. Each launch started a fresh Node process with ordinary affinity and natural GC. The strict per-query budget includes the adapter’s fresh JSON reread. The table gives elapsed milliseconds for the reunion adapter call. Differences use unrounded measurements. [Query contract](../../unit-0.11/SPEC.md#L125)

| Pair | Launch order | P wall | I wall | P−I wall | P−I main CPU | P−I runnable wait |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | P → I | 35.188 | 22.812 | +12.375 | +2.288 | +10.181 |
| 2 | I → P | 25.518 | 20.160 | +5.358 | +2.116 | +3.815 |
| 3 | P → I | 33.560 | 24.763 | +8.797 | +5.668 | +3.363 |
| 4 | I → P | 29.374 | 32.759 | −3.384 | −11.706 | +8.546 |
| 5 | P → I | 29.199 | 21.551 | +7.648 | +3.674 | +4.110 |

| Arm | n | Median (ms) | Minimum (ms) | Maximum (ms) | Range width (ms) |
| --- | --- | --- | --- | --- | --- |
| P | 5 | 29.374 | 25.518 | 35.188 | 9.669 |
| I | 5 | 22.812 | 20.160 | 32.759 | 12.599 |

The museum main thread accumulated 3.363–10.181 ms of runnable wait in P and 0 ms in I. Six peer workers registered in-window main-thread CPU increments in each P run. Pair 4 recorded 8.546 ms of additional wait in P, yet its P wall time was 3.384 ms shorter because its main-thread CPU time was lower. These counters locate runnable wait in the observed calls. The historical failure has no corresponding trace, so its scheduling, parse, validation, projection and GC contributions remain unknown. [Counter reconciliation](scratch/reconcile/audit.py) · [Pair 4 P counters](scratch/run-08-P/reconciled.json)

## Launches and target counters

Each row links the museum worker's full-precision data, the unedited Node console, and the reconciled worker counters. CPU, wait and counter-envelope slack are in milliseconds. Process CPU includes all threads. The main-thread CPU API and Linux scheduler execution counter are shown separately. Peer counts give confirmed live, possibly live, and observed accumulating CPU, excluding the museum worker and supervisor. The runnable column gives aggregate runnable/total tasks at the target boundaries. [Commands, launch times, versions of the harness and raw-sample hashes](scratch/registry.json)

| Launch | Exit | Files passed | CPU process / main / sched | Runnable wait | Sched slices | Peers live / possible / CPU | Counter slack | Host tasks | Raw |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01-P | 0 | 28 | 39.004 / 25.091 / 25.091 | 10.181 | 14 | 6 / 6 / 6 | 0.437 | 20/1660 → 9/1660 | [worker](scratch/run-01-P/museum.json) · [console](scratch/run-01-P/console.txt) · [peers](scratch/run-01-P/reconciled.json) |
| 02-I | 0 | 1 | 34.551 / 22.803 / 22.803 | 0.000 | 3 | 0 / 0 / 0 | 0.360 | 3/1611 → 1/1611 | [worker](scratch/run-02-I/museum.json) · [console](scratch/run-02-I/console.txt) · [peers](scratch/run-02-I/reconciled.json) |
| 03-I | 0 | 1 | 29.277 / 19.623 / 19.623 | 0.000 | 4 | 0 / 0 / 0 | 0.311 | 2/1610 → 2/1610 | [worker](scratch/run-03-I/museum.json) · [console](scratch/run-03-I/console.txt) · [peers](scratch/run-03-I/reconciled.json) |
| 04-P | 0 | 28 | 31.920 / 21.739 / 21.702 | 3.815 | 9 | 6 / 7 / 6 | 0.439 | 18/1655 → 7/1660 | [worker](scratch/run-04-P/museum.json) · [console](scratch/run-04-P/console.txt) · [peers](scratch/run-04-P/reconciled.json) |
| 05-P | 0 | 28 | 38.126 / 30.119 / 30.118 | 3.363 | 11 | 6 / 6 / 6 | 0.278 | 14/1660 → 13/1660 | [worker](scratch/run-05-P/museum.json) · [console](scratch/run-05-P/console.txt) · [peers](scratch/run-05-P/reconciled.json) |
| 06-I | 0 | 1 | 38.247 / 24.451 / 24.451 | 0.000 | 6 | 0 / 0 / 0 | 0.333 | 2/1610 → 2/1610 | [worker](scratch/run-06-I/museum.json) · [console](scratch/run-06-I/console.txt) · [peers](scratch/run-06-I/reconciled.json) |
| 07-I | 0 | 1 | 50.556 / 32.719 / 32.720 | 0.000 | 4 | 0 / 0 / 0 | 0.376 | 2/1610 → 1/1610 | [worker](scratch/run-07-I/museum.json) · [console](scratch/run-07-I/console.txt) · [peers](scratch/run-07-I/reconciled.json) |
| 08-P | 0 | 28 | 30.773 / 21.013 / 21.013 | 8.546 | 10 | 6 / 6 / 6 | 0.272 | 7/1660 → 13/1660 | [worker](scratch/run-08-P/museum.json) · [console](scratch/run-08-P/console.txt) · [peers](scratch/run-08-P/reconciled.json) |
| 09-P | 0 | 28 | 34.001 / 25.377 / 25.376 | 4.110 | 5 | 6 / 6 / 6 | 1.020 | 28/1660 → 12/1660 | [worker](scratch/run-09-P/museum.json) · [console](scratch/run-09-P/console.txt) · [peers](scratch/run-09-P/reconciled.json) |
| 10-I | 0 | 1 | 28.949 / 21.703 / 21.703 | 0.000 | 4 | 0 / 0 / 0 | 0.316 | 6/1610 → 5/1610 | [worker](scratch/run-10-I/museum.json) · [console](scratch/run-10-I/console.txt) · [peers](scratch/run-10-I/reconciled.json) |

All five P runs reported 28 passing files each. All five I runs reported one passing file each. All 145 file-worker exits were 0. Every console reported zero failures, skips, cancellations and TODOs at file level. This runner exposed file-level summaries. Static analysis counted 285 cases across the full corpus, including one file of top-level assertions. The museum file accounts for 19 cases. The earlier independent plain run has a case-by-case transcript. Individual diagnostic case events are unavailable. [Static case census](scratch/reconcile/cases.json) · [Historical case-level transcript](historical/core-types-npm.log#L292)

The sampler read only the benchmark coordinator's direct children. Every sampled PID matched a file worker's PID, parent, filename and exit record. Independent reads wholly within the clock interval confirmed peer CPU activity. On launch 04, six peers were confirmed live and CPU-active. One further worker could have been tearing down between polls. The uncertainty affects the upper lifetime count. CPU increments over the sampled portion of a call leave activity between polls unobserved. [Launch 04 reconciliation](scratch/run-04-P/reconciled.json) · [Raw kernel samples](scratch/run-04-P/worker-samples.json.gz)

## Work performed and output

Each run used **6,847,994 UTF-8 bytes**, SHA-256 `4414a194cd52718f3412ebfbffe97bcec5ae29ea905a8a8b66ed9148e37494e9`. The synthetic v5 state held 5,000 active formal records, 5,000 photo uses referencing one asset ID, an empty asset map, zero drafts, 1,000 favorites and 136 hidden records. Of 50 records dated 2024-11-12, two were hidden. All ten calls for 2026-11-12 returned exactly the 48 eligible IDs, one 2024 group and a null cursor. The complete page digest was `58d72befe592209c4ff5bae3a4e1c1753c24281f73391a1ef01487216845f335` in every run. The before and after storage bytes and digests matched. The write counter stayed at one initial seed write. [Input and eligible-ID fingerprints](scratch/input.json) · [Observed input, page and storage](scratch/run-01-P/museum.json)

Across the ten launches, all 80 original domain/adapter deep-equality checks and all 20 photo-continuation checks completed. Each continuation checked a 5,000-use total, 50 items on the next page and 100 distinct use IDs across the two pages. The final home summaries and storage assertions completed ten times. No measured operation returned an early error. [Original assertions](../../../tests/unit011-museum.test.ts#L445) · [Worker observations](scratch/run-10-I/museum.json)

Helper work counts come from the verified input, successful output and original control flow. The diagnostic placed no per-row probes in the timed path. Each stress case issued 8 timed adapter calls in the main loop, 2 timed photo continuations, 2 untimed first photo pages and 1 untimed final summary. Together with the constructor's first reload, that gives 14 populated-storage rereads and JSON parses per complete case. For the target alone, one storage read and one parse preceded structural validation of 5,000 rows. The validation loops traversed 10,000 draft/formal slots, 5,000 non-null snapshots, 5,000 photo uses and 5,000 tag-metadata rows. The reunion eligibility predicate received 5,000 active formal rows and the page projected 48 items. Direct per-helper visit counters and GC events were reserved for the conditional profile. [Test workload](../../../tests/unit011-museum.test.ts#L422) · [Reload](../../../src/platform/memory-adapter.ts#L129) · [Tag validation](../../../src/domain/tags.ts#L124) · [Eligibility](../../../src/domain/timeline.ts#L161) · [Projection](../../../src/domain/museum.ts#L19)

## All original stopwatch readings

Each pair cell shows **P / I** in milliseconds, regardless of launch order. The last two columns give the median and [minimum, maximum] of each arm. All 18 timings were reached in every launch. The largest value anywhere in this table was 49.802 ms for adapter home summary in launch 04. The worker files retain the unrounded readings used for all comparisons.

| Stopwatch | Pair 1 P / I | Pair 2 P / I | Pair 3 P / I | Pair 4 P / I | Pair 5 P / I | P median [min, max] | I median [min, max] |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `domain.homeSummary` | 2.880 / 2.593 | 2.724 / 2.574 | 3.869 / 2.697 | 2.097 / 2.604 | 2.597 / 2.089 | 2.724 [2.097, 3.869] | 2.593 [2.089, 2.697] |
| `adapter.homeSummary` | 39.473 / 29.521 | 49.802 / 34.489 | 36.214 / 27.782 | 30.505 / 32.713 | 33.801 / 27.521 | 36.214 [30.505, 49.802] | 29.521 [27.521, 34.489] |
| `domain.reunionPreview` | 1.174 / 0.974 | 1.284 / 1.532 | 6.852 / 1.230 | 0.953 / 4.191 | 9.611 / 1.096 | 1.284 [0.953, 9.611] | 1.230 [0.974, 4.191] |
| `adapter.reunionPreview` | 32.151 / 22.658 | 27.041 / 23.367 | 19.300 / 24.579 | 23.395 / 25.344 | 17.761 / 22.118 | 23.395 [17.761, 32.151] | 23.367 [22.118, 25.344] |
| `domain.reunionPage` | 1.514 / 1.539 | 2.728 / 1.809 | 5.469 / 1.484 | 2.965 / 1.749 | 1.444 / 1.704 | 2.728 [1.444, 5.469] | 1.704 [1.484, 1.809] |
| `adapter.reunionPage` | 35.188 / 22.812 | 25.518 / 20.160 | 33.560 / 24.763 | 29.374 / 32.759 | 29.199 / 21.551 | 29.374 [25.518, 35.188] | 22.812 [20.160, 32.759] |
| `domain.favoritesFirst` | 3.432 / 1.755 | 2.750 / 1.844 | 3.569 / 3.242 | 2.322 / 1.876 | 3.260 / 1.856 | 3.260 [2.322, 3.569] | 1.856 [1.755, 3.242] |
| `adapter.favoritesFirst` | 30.758 / 26.723 | 43.213 / 26.145 | 23.544 / 23.700 | 28.288 / 19.029 | 20.506 / 22.527 | 28.288 [20.506, 43.213] | 23.700 [19.029, 26.723] |
| `domain.photosFirst` | 5.830 / 4.038 | 7.958 / 4.205 | 5.390 / 4.769 | 7.587 / 4.066 | 4.277 / 4.256 | 5.830 [4.277, 7.958] | 4.205 [4.038, 4.769] |
| `adapter.photosFirst` | 33.400 / 19.086 | 34.379 / 19.624 | 24.706 / 22.674 | 30.169 / 21.545 | 25.439 / 21.424 | 30.169 [24.706, 34.379] | 21.424 [19.086, 22.674] |
| `domain.years` | 2.860 / 1.200 | 6.556 / 1.143 | 4.614 / 1.231 | 1.510 / 1.265 | 3.526 / 1.300 | 3.526 [1.510, 6.556] | 1.231 [1.143, 1.300] |
| `adapter.years` | 29.431 / 29.075 | 36.224 / 20.251 | 29.582 / 21.114 | 23.275 / 17.285 | 20.048 / 20.836 | 29.431 [20.048, 36.224] | 20.836 [17.285, 29.075] |
| `domain.yearRoomFirst` | 1.651 / 1.924 | 12.863 / 1.551 | 1.232 / 1.652 | 2.014 / 1.211 | 1.133 / 1.495 | 1.651 [1.133, 12.863] | 1.551 [1.211, 1.924] |
| `adapter.yearRoomFirst` | 27.001 / 26.672 | 37.153 / 23.179 | 22.578 / 23.150 | 24.851 / 18.634 | 19.056 / 23.720 | 24.851 [19.056, 37.153] | 23.179 [18.634, 26.672] |
| `domain.reshuffle` | 7.808 / 3.324 | 4.783 / 2.952 | 4.483 / 2.834 | 11.423 / 1.960 | 2.459 / 2.433 | 4.783 [2.459, 11.423] | 2.834 [1.960, 3.324] |
| `adapter.reshuffle` | 25.806 / 19.943 | 39.494 / 19.690 | 18.278 / 20.221 | 27.635 / 17.720 | 19.239 / 20.532 | 25.806 [18.278, 39.494] | 19.943 [17.720, 20.532] |
| `adapter.photosNext.asc` | 28.168 / 33.542 | 23.356 / 23.226 | 19.748 / 24.269 | 24.408 / 19.497 | 19.505 / 25.757 | 23.356 [19.505, 28.168] | 24.269 [19.497, 33.542] |
| `adapter.photosNext.desc` | 27.243 / 31.190 | 29.685 / 28.970 | 22.057 / 22.758 | 28.932 / 19.628 | 34.888 / 28.347 | 28.932 [22.057, 34.888] | 28.347 [19.628, 31.190] |

## Observer, environment and bounds

The diagnostic inserted standalone statements around the original test lines in the museum worker's in-memory module. Removing those statements recovered the complete original source byte-for-byte. The original clock expressions, query, await, deep equality and fail-fast threshold checks executed in place. Only the target's surrounding statements took process CPU, main-thread CPU and `/proc/thread-self/schedstat` readings. Fixture hashing and page verification ran after the test timers. The 256 empty-pair calibration executed no museum queries. [Source anchors](scratch/hooks.mjs) · [Worker probes](scratch/probes.mjs) · [Calibration](scratch/preflight.json)

Median calibrated external setup/teardown was 43.183/43.722 µs. Median near-clock slack was 0.266 µs and full counter-envelope slack 10.970 µs. In the workloads, setup took 0.598–1.333 ms and teardown 0.273–0.364 ms, outside the stopwatch. Near-clock slack was 0.073–0.130 ms and the full counter envelope exceeded the original interval by 0.272–1.020 ms. The supervisor used 390.001 ms of its own thread CPU for 1,927 polls across the ten launches. These are measured observer costs. The preload, extra live references, counter-read allocations and sampler can change JIT behavior, scheduling and the timing of natural GC. Their effect on individual latencies remains unquantified. [Calibration ranges](scratch/preflight.json) · [Per-launch sampler CPU](scratch/registry.json)

Node v24.22.1, V8 13.6.233.17-node.58 and npm 11.21.1 ran on Linux 6.12.113+ x64, Intel Xeon. Available parallelism was 8, with affinity and effective cpuset 0–7. Cgroup v2 `/agent` reported `cpu.max = max 100000`. Period, throttled-period and throttled-time deltas were zero for every launch and target. Target 1/5/15-minute load ranged from 0.23/0.45/0.66 to 2.30/0.92/0.81. Host task counts include other work only in aggregate. The installed system Rust/Cargo is 1.85.1 and the pinned Rust/Cargo toolchain is 1.90.0. [Environment and calibration](scratch/preflight.json) · [Installed versions](scratch/tool-versions.txt) · [Per-launch load and cgroup readings](scratch/registry.json)

The first static observer check exited 1 on an ambiguous source anchor. A stress-specific two-line anchor passed the second static check before any benchmark. After launch 01, my first analysis check expected individual case names and a parent-side preload file. Node produced file results and worker-side records. I paused for 264.534 seconds between launches 01 and 02, kept the original assessment and reconciled the existing data. The file census, sampled direct-child PIDs, worker self-reports, timing brackets, fixture and output all matched. The nine remaining slots used the same hashed Node collector and polling function. The first observation and the original deadline stayed in the series. [Static check error](scratch/preflight.stderr) · [Original assessment](scratch/run-01-P/assessment.json) · [Initial registry](scratch/reconcile/initial-registry.json) · [Reconciled first observation](scratch/run-01-P/reconciled.json)

| Limit or gate | Actual outcome |
| --- | --- |
| Diagnostic limit, 10 launches | 10 used, all five pairs complete, 0 replacements, 0 timeouts |
| Diagnostic sample breaches | 0 of 180. All ten targets completed. Unreached timings 0 |
| Three-new-failed-attempt stop | 0 of 3. Diagnostic nonzero exits 0, profile nonzero exits 0, new failed plain validations 0 |
| Instrumentation and analysis issues | One static anchor rejection and one reporting-format check paused work. Both raw records are retained. Product correctness mismatches and integrity mismatches were 0 |
| Time limits | 90 seconds per launch, longest 2.237 seconds. The series finished 279.649 seconds after the first launch, including the pause. Total allowance 2,700 seconds |
| Separate attribution run | **NOT_RUN**, 0 of 1. No default-concurrency target breach |
| Candidate and plain npm acceptance | No candidate. **NOT_RUN**, 0 Codex acceptance launches. Independent orchestrator acceptance also unused |
| Candidate Rust workspace, fault-injection, typecheck, web build and diff check | **NOT_RUN** in this investigation |

## Prior gate and preserved native evidence

At `8f86b47` the independent default suite reported 285/285 and a 23.677 ms reunion adapter call. T4.1 recorded two file failures during concurrent Rust/TS work and a later independent plain pass of 285/285 with 24.777 ms for the adapter. T4.2a included a failing file-level run and passing isolated, pinned and file-serialized controls. The most recent independent **plain** npm run then exited 1 with the 172.558 ms assertion. Its 284/1 case totals and zero skips or cancellations remain the gate of record. These earlier observations are outside the new failure budget. [Baseline log](historical/baseline-npm.log#L177) · [T4.1 log](historical/core-types-npm.log#L177) · Prior controls (`evidence/mobile-stage23/V5_ORACLE.md`, preserved and uncommitted) · [Blocked gate](../BLOCKED_TEST_GATE.md)

The existing native v3/v5 oracle recorded 4 passing tests covering archived envelopes, populated restore, reopen, repeated merge, re-export and destination preservation on invalid input. The prior workspace run recorded 254 passed, 0 failed, 1 ignored. Fault-injection recorded 304 passed, 0 failed, 1 ignored. The prior typecheck, web build and diff check exited 0. These results belong to the existing oracle work. Candidate v6 migration, native-device and private-upgrade validation remain **NOT_RUN**. The production writer emits outer 1/schema 5. [Historical oracle tests](historical/oracle-cargo.log#L505) · [Fault run](historical/oracle-fault.log#L528) · [Historical exits](historical/oracle-results.json)

All measured source bytes matched both `8f86b47` and `21691ea`. Their Git objects for `src`, `tests`, `package.json` and the lockfile were identical. The experiment compared scheduling conditions on that single implementation. All 10 oracle manifest entries matched the worktree and protected copies, and all 11 frozen v3 files matched the baseline. The pre- and post-investigation integrity records are byte-identical, including the frozen plan and fingerprint hashes. All new work is investigation evidence. [Source fingerprints](SOURCE_FINGERPRINTS.json) · [Before](scratch/integrity-before.json) · [After](scratch/integrity-after.json) · [Oracle preimage](/workspace/sg-stage23/investigation/ORACLE_PREIMAGE.json)

## Independent archival audit

The orchestrator independently checked the frozen plan/source fingerprints, all10 protected oracle/provenance files and their preserved copies, all11 tracked frozen-v3 files, all10run timing maps and paired medians/ranges, registry/harness/analysis hashes, original console/kernel-sample hashes, and unchanged production source/default npm command. Historical logs above are byte-for-byte copies for a self-contained archive. No diagnostic, profile, acceptance or product test was rerun for this audit. Only this investigation evidence/report is being committed; the native-v5 fixture/tests/generator block remains uncommitted and unaltered. Code head21691ea lastCI45627710844 was7/7, but that does not supersede the recorded plain npm failure or validate the uncommitted oracle block. No root fix is claimed.
