# Schema 6 production writer

The production writer is enabled in the uncommitted worktree on `feat/mobile-stage23`, base `77e8af547c87ac782db0bc66425c7c850ae33f60`, PR12. **T-5 readiness is on hold.** The native and preview paths demonstrated durable ordered stories. The one-pass verification recorded a Rust fixture failure and five npm failures. The corrective changes have compile or syntax coverage only. [Command ledger](schema6-writer/commands.txt) · [Changed files](schema6-writer/files.txt)

## Live format and compatibility

| Path | Contract |
| --- | --- |
| Native state | `state.json` uses outer `version=2` and `schemaVersion=6`. Every formal, draft, trashed and conflict snapshot stores content in `story = {blocks, coverPhotoUseId}`. Paragraph, small heading and quote contain literal runs with independent bold and italic flags. Divider has a kind only. A photo block embeds its existing `PhotoUse`. |
| Read and edit | The native reader accepts outer 1 with schema absent or 1–5, and outer 2 with schema 6. An unknown pair fails before lock creation, cleanup or migration writes. Snapshot views expose body, photos and cover derived from the ordered story. A complex story rejects scalar body replacement. Drafts can retain an editor mode. Formal publication still checks the entry revision, required content, date and originals. |
| Backups | New native packages use `SGBAK\0\0\x01`, manifest `formatVersion=1`, `schemaVersion=6`. Password protection retains `SGBAKENC\0\x01` and its v1 header. Frozen v3 and v5 packages continue to identify their input schemas. Re-export after import declares schema 6. |
| Preview | MemoryAdapter writes outer 2/schema 6 with story-only snapshots. Its synthetic preview envelope retains its own format. Opening a legacy preview validates it in memory and preserves the stored bytes until a write. Native Store upgrades a legacy file during open. |

The editor serializes typed saves. It checks the expected story before changing an existing document and uses the existing attach/unlink allocator and undo receipt for membership changes. An acknowledged draft includes the ordered blocks, marks, literal text, photo uses, captions and cover. The reading view uses formal content. Undo history, composition state and pending photo handles belong to the editing session. [Core shape](../../core/src/story.rs) · [Editor save path](../../src/domain/story-editor.ts) · [Native commands](../../src-tauri/src/lib.rs)

## Upgrade and rollback

Ordinary and exclusive Store open preflight the version pair. Migration and recovery own the instance and write locks. Pending import recovery precedes selection of the migration source. The installer copies and verifies the exact original bytes in `backups/state.schema-v<from>.<old-sha256>.json` and syncs the file and directories. It builds the candidate, parses its encoded bytes, traverses every snapshot and reconstructs the old content for comparison. It verifies the installed hash after same-directory atomic replacement. [Open path](../../core/src/store.rs) · [Conversion and validation](../../core/src/schema.rs) · [Receipt protocol](../../core/src/migration.rs)

An unconfirmed receipt keeps normal writes fenced. Recovery verifies the backup and live hash, keeps or restores the exact old bytes, and verifies them before clearing the receipt. An ordinary open can then start a fresh upgrade. A valid synced receipt with `confirmed=1` retains the verified candidate. A third hash, contradictory receipts, a missing or corrupt preimage, or an ambiguous historical synced receipt stops recovery. The four M1 crash and compensation cases passed. Windows sync opens the necessary writable handles and propagates an unsuccessful flush. Windows behavior remains unverified. [M1 fault results](schema6-writer/migration-fault.log.gz) · [M1 witness and physical-device limits](M1_COMMIT_WINDOW.md)

| Frozen source | Exact preimage SHA-256 | Verified candidate SHA-256 | Original media files |
| --- | --- | --- | ---: |
| v3 | `2c0677c397b5d135262ae5194f4854a94b78d03979189e91bbca7c0d0afd5936` | `202c26ed2e7aae64777f688ef7877304d972da8f52ac50f5b788293543d8d20c` | 7 |
| v5 | `b41b45bc93fc65ed0915f8cf7197b0cf496c01b2e14b22271408f5f37bc86ccb` | `3a15407ccd457d825303f02f33d183d81c62df3b1480e54f34eee38e25e33ba7` | 2 |

The native oracle checked frozen envelope magic, header and manifest versions, package and source hashes, and decrypted package bytes. Disposable source, overwrite, double merge, re-export and reopen preserved literal bodies, photo order, captions, non-first covers and separate uses of a shared original. All tracked v3/v5 fixture bytes match HEAD. Of the ten entries in the recorded oracle manifest, only the authorized live-writer test source changed. [Frozen oracle run](schema6-writer/oracle.log.gz) · [Before/after hashes and generator integrity](schema6-writer/integrity.txt)

## Observed durability

- A native seven-block story included a marked heading, two paragraphs, an intervening quote and divider, two uses of one original, and text after a photo. Its draft reopened intact, publication cleared the draft, plain and encrypted overwrite restored the complete story, and re-export preserved its media hash. Scalar flattening, stale story comparison and an unauthorized membership change failed without changing the state bytes. [Native integration output](schema6-writer/workspace.txt) · [Regression case](../../core/tests/schema6_writer.rs)
- A separate populated CLI merge forced two unrelated records to share their source record and occurrence IDs. The existing mapper assigned `pu-000005` and `pu-000006` to incoming uses and kept the second as cover. All seven block positions, runs, captions and the existing local formal matched. The second import left the state SHA-256 identical. Restoring the re-export in a fresh library recovered both records and one original with its full SHA-256. [CLI merge and media proof](schema6-writer/cli-populated-merge.txt)
- The Node editor and MemoryAdapter round trip saved a complex draft, reopened it through a fresh adapter and editor, published it, restored a preview backup, merged twice and restored the re-export. The event-DOM cases exercised composition, in-flight saves, protected quick mode and reopening from the draft list. The typed Tauri command contract and the separate-process CLI draft/publish test passed. Native desktop execution has its own status below. [Node output](schema6-writer/npm-test.log.gz) · [CLI test output](schema6-writer/workspace.txt)

## One-pass verification

Rust and Cargo used 1.90.0 with the lockfile, `CARGO_NET_OFFLINE=true` and `/home/box/.cargo/bin` first on PATH. The session used the supplied personal prolite runtime configuration. The requested model, effort and tier were `gpt-6.2-astra`, `max` and `priority`. Verification used synthetic data. [Commands and exit codes](schema6-writer/commands.txt)

| Check | Recorded result |
| --- | --- |
| Frozen v5 oracle, including archived v3 | 4 passed. [Log](schema6-writer/oracle.log.gz) |
| Default migration | 7 passed. [Log](schema6-writer/migration-default.log.gz) |
| Fault-injected migration, including M1 | 22 passed. [Log](schema6-writer/migration-fault.log.gz) |
| `unit010_faults` v3 interruption | 1 passed. [Log](schema6-writer/v3-interruption.log.gz) |
| Full Cargo workspace command | 61 passed, 1 failed before Cargo stopped. The 35 previously unreached integration binaries added 204 passes and 1 ignored generator. Observed total **265 passed, 1 failed, 1 ignored**. [Command output](schema6-writer/workspace.txt) · [Remaining binaries](schema6-writer/workspace-unreached.log.gz) |
| Full core fault command | 72 passed, 1 failed before Cargo stopped. The 35 previously unreached integration binaries added 257 passes and 1 ignored generator. Observed total **329 passed, 1 failed, 1 ignored**. [Command output](schema6-writer/fault.txt) · [Remaining binaries](schema6-writer/fault-unreached.log.gz) |
| `npm test`, default scheduling | **318 passed, 5 failed**, 323 total. [Full worker output](schema6-writer/npm-test.log.gz) |
| `npm run typecheck` and `npm run build` | Both exited 0 before the follow-up preview corrections. [Typecheck](schema6-writer/typecheck.log.gz) · [Build](schema6-writer/build.txt) |
| Offline Tauri desktop compile | **BLOCKED** during dependency resolution. The existing Cargo cache lacked `serde_json` for the separate desktop manifest. [Compiler output](schema6-writer/desktop.txt) |

The 5,000-record run measured **homeSummary at 1.158 ms in MemoryAdapter and 10.191 ms in the domain**, against 150 ms. Adapter reunionPage measured 45.184 ms against its existing 200 ms exception. Historical **313.050 ms remains INCONCLUSIVE**. The existing worker-output preload forwarded the default workers' output. The measured run emitted its timings from test teardown so an early assertion could also report them. The final benchmark function and npm scheduling match the pre-activation tip. [Timing output](schema6-writer/npm-test.log.gz) · [Source comparison](schema6-writer/integrity.txt)

## Recorded failures and T-5 assessment

Both Cargo commands executed the previously compiled version of the same new equal-text/different-structure merge test. Its fixture called overwrite on a nonexclusive Store and received `STORE_NOT_EXCLUSIVE` before comparing the stories. The fixture now takes exclusive handles. The earlier passing native round trip and the populated CLI collision proof exercised different cases. The failed case was not rerun. [Native test](../../core/tests/schema6_writer.rs) · [Fault run](schema6-writer/fault.txt)

Five npm failures led to three corrections in MemoryAdapter. Two H1 assertions found that a preview import safety copy re-encoded the original v5 JSON. The import paths now copy the validated raw string. Two conflict tests found that comparing complete view objects with `JSON.stringify` could create spurious conflict copies when key order changed. Conflict resolution now compares metadata and canonical typed stories. One museum UI assertion exposed a legacy read that gained a story field only after its first write. Row and conflict views now expose a typed story before and after that write. The failing tests kept their original safety and content assertions. A final interface review also aligned CLI trash/conflict views with other record replies and passed the optional story comparison through native unlink without an undo session. The full suites were each run once. Subsequent Rust compile checks and Node syntax checks are recorded separately. [Preview implementation](../../src/platform/memory-adapter.ts) · [Rust checks](schema6-writer/final-rust-check.txt) · [Node syntax](schema6-writer/final-ts-syntax.txt)

**T-5 readiness is on hold.** Position, marks, cover remapping and media identity survived the observed round trips. The red cases still need behavioral verification on the corrected source. Same-use replacement and fork-collision ambiguity retain the existing design boundary. **NOT_RUN** covers browser, Android-native, Windows-native, owner-private upgrade and T-5. The worktree has no commit, push or merge. The pre-existing untracked `src-tauri/gen/` and `evidence/mobile-stage23/migration-safety/` remain outside the change inventory. [Occurrence identity decision](CORE_TYPES.md) · [Changed files](schema6-writer/files.txt)

## Independent orchestrator verification

Re-ran the default suites once on the corrected worktree after Codex finished, on 2026-11-27 05:15 Asia/Shanghai, without changing clocks, limits, scheduling or retrying. Codex's earlier one-pass recorded 1 Rust failure (`STORE_NOT_EXCLUSIVE` in `schema6_writer`) and 5 npm failures; those fixtures/adapters were fixed in the worktree and were not rerun by Codex. This orchestrator run is the required independent default regression of the final source.

Results: cargo workspace 266 passed, 0 failed, 1 ignored; fault injection 330 passed, 0 failed, 1 ignored; `npm test` 323 passed, 0 failed; typecheck and build exit 0. `adapter.homeSummary` measured **1.966 ms** against the unchanged 150 ms gate (**PASS**). `adapter.reunionPage` measured **25.47 ms** against its specific authorized 200 ms gate. The historical **313.050 ms** result remains **INCONCLUSIVE**. Production writer is outer 2 / schema 6. [Independent log](schema6-writer/independent-full.txt)

After this green independent pass, the ordered `PhotoUse` position model survives editor reopen, formal publish, backup restore and merge on synthetic data. **T-5 has not started.** The start condition is considered met, subject to the existing occurrence-identity ambiguity for independently forked same-ID insertions (documented, not expanded). Browser, Android-native, Windows-native and owner-private upgrade remain **NOT_RUN**.
