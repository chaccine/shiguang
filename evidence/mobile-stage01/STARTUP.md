# Android startup and app lock

Worktree verification on 2026-11-25, Asia/Shanghai. Branch `feat/mobile-stage01` is stacked on unmerged PR10, `unit-0.12` at `77a06375825b5e39045e447b0b7e42cc7b0d88bb`. The 20:11 baseline recorded 241 Rust workspace tests, 291 fault-injection tests and 254 frontend cases passing. Typecheck and build also exited 0. This checkout contains no `AGENTS.md`. [Baseline](BASELINE.md) · [Unit-0.12 report](../UNIT0.12_REPORT.md)

## Cause

At the base tip, `src/ui/index.html` lines 410–413 shipped the lock heading, “正在检查应用锁…”, the password input and the unlock button in **one visible form**. The shell was inert, but the form was outside it. Reading the initial HTML with ancestor visibility taken into account reproduced the simultaneous message and controls before JavaScript ran.

In the base `src/ui/main.ts` lines 2603–2616, boot awaited store readiness. Then `PersonalUi.start()` in the base `src/ui/personal.ts` lines 52–69 awaited settings before hiding the overlay or presenting the prompt. Either IPC could prolong the overlap. After admission, media, draft and timeline reads also preceded the first route selection. These code paths explain the observation without making a device latency claim.

## Startup behavior

| Condition | What the user sees |
|---|---|
| Before JavaScript, opening the store or waiting for lock status | An opaque themed cover showing only 拾光. The entire shell and unlock form are hidden. The shell is also inert. |
| Current status explicitly says disabled | The cover closes and the initial route appears immediately. Content loads afterward. A late load preserves a navigation choice made in the meantime. |
| Current status says enabled | A focused password prompt. Submitting clears the credential field, disables duplicate submissions and presents verification progress and 取消验证. |
| Wrong credential or verification I/O error | The shell stays covered. The prompt shows a safe error, with the persisted retry delay when applicable. An unreadable lock status has a separate error and Retry action. |
| Cancel or leave during verification | The attempt loses permission to open the UI. A native request already dispatched may still finish and update its own failure counter. |
| Background with an enabled lock | The shell is hidden and inert immediately. Repeated background events retain the first departure time. An admitted session resumes at 59,999 ms and requires a credential at 60,000 ms. |

Native `store_status` and `get_settings` are asynchronous. The first paint uses the existing theme cache and system preference. Admission waits for the current response, with no cached lock flag or minimum splash duration. Cancel and background changes invalidate the pending UI operation before a late reply can change visibility, feedback or a newer input. [Initial document](../../src/ui/index.html#L29) · [Startup controller](../../src/ui/personal.ts#L80) · [Boot order](../../src/ui/main.ts#L2586) · [Native store check](../../src-tauri/src/lib.rs#L253) · [Native settings check](../../src-tauri/src/u010_cmd.rs#L20)

The old explicit demo startup also deleted its preview storage key before checking settings. Both fixture modes now reset only an explicitly requested, unlocked synthetic store. A saved lock protects the existing records and failure count on reload. A corrupt preview store reaches the same retry cover, with its bytes intact. [Preview adapter](../../src/platform/memory-adapter.ts#L117)

## Compatibility and data invariants

- The base native and preview implementations both accept **4–8 ASCII digits** for app-lock credentials. All values in that range retain their exact spelling, including leading zeros. There is no conversion to a fixed six-digit PIN, automatic lock change or migration. Free-form text was outside this tip’s verifier contract. Native verification retains Argon2id v19 with the stored parameters and constant-time hash comparison. Preview tests use the existing synthetic PBKDF2 adapter. [Native verifier](../../core/src/app_lock.rs#L71) · [Preview verifier](../../src/platform/preview-lock.ts#L23)
- The native verifier owns failure counts and backoff. Portable plain and encrypted backups omit credentials. Overwrite preserves the target lock and counters, and merge ignores incoming lock settings. The backup encryption passphrase remains independent. [Lock and backup regressions](../../core/tests/unit010_lock.rs) · [Unit-0.10 contract](../unit-0.10/SPEC.md)
- G01–G06 and the persisted schema retain their existing contracts. The shared suites exercised draft/formal separation, revision handling, deletion markers, backup and fault recovery, photo integrity and tag transactions. The stage changes startup presentation, admission and explicit preview setup. [Prior contract verification](../unit-0.12/CORE_VERIFICATION.md)

## Verification

All inputs were synthetic. The 14 added cases exercise the shipped markup and real application bootstrap in the repository’s event-DOM harness. They hold store, settings, verification, backoff and media replies open independently. They cover lock-off entry, enabled restart, malformed replies, store failure and retry, duplicate actions, cancellation, late successes and errors, background and resume, the 60-second boundary, and locked preview fixtures. A synthetic IPC stub checks the command sequence while access is blocked. [Startup regressions](../../tests/mobile-startup.test.ts) · [Boot harness](../../tests/support/boot-dom.ts)

| Command | Result | Exit |
|---|---|---:|
| `npm test` | 268 individual cases passed independently by orchestrator | 0 |
| `node --test --test-isolation=none tests/*.test.ts` | 268 individual cases passed, 0 failed or skipped | 0 |
| `npm run typecheck` | Strict TypeScript passed | 0 |
| `npm run build` | Frontend assets built in `dist/` | 0 |
| `cargo +1.90.0 test --locked --workspace` | 241 passed, 0 failed, 1 ignored | 0 |
| `cargo +1.90.0 test --locked -p shiguang_core --features fault-injection` | 291 passed, 0 failed, 1 ignored | 0 |

Rust ran offline with the installed 1.90.0 toolchain. The single ignore in each Rust run is the historical v3 fixture generator. During development, strict typecheck caught two errors in the new test fixtures, a durability literal and an optional mock result. Both were corrected before the final runs.

## NOT_RUN

- Parent computerUse and Android hardware or WebView verification, including cold-start frames, keyboard, accessibility focus, slow real IPC and the 360/390 px light/dark layouts.
- Native upgrade with historical records and photos. The owner’s 0.1.12 screenshots establish light and dark launches on that version only. Old-data and photo retention on upgrade still require device verification.
- Android status and navigation bar color matching is deferred to the next visual chunk. This fix operates within the webview. Recent-apps protection, editor/photo restructuring and the broader visual redesign are outside this delivery.

Independent orchestrator verification completed at 2026-11-25 20:31 Asia/Shanghai: cargo241/fault291/npm268/typecheck/build/diff-check all exit0. Durable raw logs: `/workspace/sg-visual-01/startup/`. Branch renamed to `feat/mobile-stage01` before first push to use the existing `feat/**` CI trigger; stacked PR base remains `unit-0.12`.
