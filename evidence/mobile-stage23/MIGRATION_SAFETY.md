# T4.2b candidate migration safety

On 2026-11-26 in Asia/Shanghai, the state-only candidate passed **6 default Rust tests and 14 with fault injection** on `feat/mobile-stage23` at base `c9eff0546b3167cebc36cb61fb9401b2c6750bb4`. The fault total includes the six default tests. The existing native v3/v5 backup oracle passed all four tests. The working tree is uncommitted. [Command ledger](migration-safety/commands.jsonl) · [Final default log](migration-safety/07-final-default.log.gz) · [Final fault log](migration-safety/08-final-fault.log.gz) · [Native oracle log](migration-safety/05-native-oracle.log.gz)

M1 updated the receipt protocol described below. Its follow-up records both failed-sync reproductions and the recovery results with the confirmation witness. [M1 commit window](M1_COMMIT_WINDOW.md)

## Transaction contract

The candidate takes the Store's instance lock followed by its write lock, before opening the source state. This permits recovery of the exact v3 bytes before the existing v5 Store has an opportunity to upgrade them. Installation preflights the source version. If an import journal exists, the existing restore and merge routines run under the same locks and the candidate rereads the source. Simultaneous migration and import intents stop recovery. Ordinary Store opens and saves continue to use outer 1/schema 5. Their shared write-lock entry refuses a directory with a migration record, including writes from an already-open handle. Candidate installation and recovery compile only in the core unit-test target. [Transaction](../../core/src/migration.rs) · [Store ownership](../../core/src/store.rs)

The transaction creates or verifies `backups/state.schema-v<from>.<old-sha256>.json`. The backup file, its directory and the library root must sync successfully before the builder runs. It encodes the candidate, parses those bytes, compares the decoded value to the input, and requires the caller's domain validation. It rechecks the source and backup before publishing the pending record. The record contains exactly the constrained basename and the two distinct lowercase SHA-256 values. A synced pending record precedes the same-directory atomic replacement of `state.json`. The transaction also verifies the installed digest. [Verified copy and hashing](../../core/src/backup.rs) · [Atomic write and restore](../../core/src/persist.rs)

One record moves between three reserved names in the library root. A fresh owner finding `.state-migration-pending.json` or `.state-migration-clearing.json` verifies the backup and its legacy version, then checks the live state. An exact old file is retained and synced. An exact candidate is atomically replaced with the verified backup, rehashed and synced. Missing or unexpected bytes, an invalid path, or contradictory records leave the writer fenced. Preimage backups remain available after rollback and commit.

During retirement, a successful directory sync of the clearing name precedes the rename to `.state-migration-synced.json`. Failure to sync this confirmation attempts to move the intact record back to clearing. All three names fence ordinary writers, including on an additional filesystem error. A surviving synced receipt requires the expected state and backup hashes and a fresh directory sync before cleanup. Its final unlink is idempotent housekeeping. A crash after confirmed commit can therefore leave a receipt to clean up on reopen. [Record parsing and recovery](../../core/src/migration.rs) · [Retirement fault cases](../../core/src/migration/tests/faults.rs)

## Proof on disposable frozen copies

Each fixture was copied as a raw state file and a complete named media directory. Five snapshot slots in each archive were checked against the archived scalar fields, including body bytes, row or conflict ID, slot, status, occurrence order, asset identity, integrity metadata, captions and cover. V3 supplies the first use as its implicit cover. V5 includes reversed draft order, different formal and draft captions, two non-first covers, a trashed photo-only record and a conflict copy. Decoding each typed story and reconstructing the whole normalized legacy document also checks every other field and array position. [Fixture and round-trip tests](../../core/src/migration/tests.rs)

| Frozen source | Source SHA-256 | Disposable candidate SHA-256 | Named originals checked |
| --- | --- | --- | ---: |
| v3 | `2c0677c397b5d135262ae5194f4854a94b78d03979189e91bbca7c0d0afd5936` | `202c26ed2e7aae64777f688ef7877304d972da8f52ac50f5b788293543d8d20c` | 7 |
| v5 | `b41b45bc93fc65ed0915f8cf7197b0cf496c01b2e14b22271408f5f37bc86ccb` | `3a15407ccd457d825303f02f33d183d81c62df3b1480e54f34eee38e25e33ba7` | 2 |

The final fault log records the observed phase, fixture, injection visit where applicable, and recovery outcome. Each recovered preimage was compared by both SHA-256 and exact bytes. Every original was compared by filename and full digest. When a test deliberately damaged a file, it first asserted that failed recovery preserved the observed damaged bytes or absence. It repaired that disposable input before checking recovery of the exact old state. [Per-file hashes](migration-safety/preimage.json) · [Recorded cases](migration-safety/08-final-fault.log.gz)

| Final fault cases across both fixtures | Count | Observation |
| --- | ---: | --- |
| Verified backup, preparation, candidate install and retirement | 32 | Backup verification refusal, pending write and rename failure, candidate temp create/write/half-write/file-sync/rename failure, interruptions before and after install, and all six directory-sync visits. Each uncommitted case reopened to the exact old state. |
| Rollback write, rename and sync failures | 8 | The writer remained fenced with known candidate or old bytes. Fresh ownership recovered the preimage and all originals. |
| Missing/corrupt backup and third/missing state | 16 | Rejected on both sides of installation, with the offending state, backup and pending record preserved. |
| Invalid pending documents | 26 | Covered duplicate and extra fields, size, syntax, traversal, absolute and backslash paths, unrelated basenames, and invalid or identical hashes. |
| Symlink cases | 10 | State, backup, backups directory and record paths stayed intact on refusal. |
| Contradictory records and version pairs | 8 | Two phase names, an outstanding import, a wrongly named legacy backup and a foreign state with a matching supplied digest all failed closed. |
| Interruption after confirmed commit | 2 | A surviving receipt continued to fence the writer during a further sync failure. Successful receipt recovery retained the verified candidate and every original. |

The default tests also proved successful commit and reopen, old-reader refusal, malformed and lossy round-trip rejection, preservation of a pre-existing wrong or partial preimage copy, both held locks, and prior merge-journal recovery. A fault test exercised an already-open v5 handle while the original bytes were still visible. The existing v3/v5 native reader separately verified plain and encrypted packages, populated overwrite, merge twice, re-export, reopen and tamper/password rejection. The existing v3-to-v5 migration fault test also passed. [Native oracle](../../core/tests/v5_oracle.rs) · [Legacy migration log](migration-safety/06-legacy-migration.log.gz)

## Runs and failure counters

Rust and Cargo 1.90.0 used the installed toolchain with `PATH=/home/box/.cargo/bin:$PATH` and `CARGO_NET_OFFLINE=true`. Commands ran serially with Cargo's default test scheduling.

| Ledger runs | Focus | Passed |
| --- | --- | --- |
| 01, 02 | Initial candidate and fault matrix | 4, 10 |
| 03, 04 | Same-directory retirement, raw fixture comparisons and extended rejection cases | 6, 14 |
| 05, 06 | Existing native backup oracle and existing legacy migration fault case | 4, 1 |
| 07, 08 | Final candidate, including explicit file sync when retaining or restoring verified old bytes | 6, 14 |

**Unexpected test or build failures were zero** across these eight commands. Run 01 emitted one unused-import warning, corrected by scoping the import to the fault tests. One local source-edit helper failed to match a line after rustfmt expanded it. Its counter was one, and the remaining edit was applied against the formatted source. No test ran in that edit command. Deliberately injected failures are counted separately above. The original 172.558 ms timing failure and its INCONCLUSIVE investigation remain frozen. All ten protected entries and all fifteen archived state, package and media files matched their pre-work hashes. [Authoring diagnostic](migration-safety/edit-diagnostic.txt) · [Ledger and exact commands](migration-safety/commands.jsonl) · [Integrity and counters](migration-safety/verification.json)

## Scope and next gate

The source changes are `core/src/migration.rs`, `core/src/migration/tests.rs`, `core/src/migration/tests/faults.rs`, `core/src/store.rs`, `core/src/persist.rs`, `core/src/backup.rs`, `core/src/fault.rs` and `core/src/lib.rs`. The evidence additions are this report and the files in `evidence/mobile-stage23/migration-safety/`. The allocator, remaps, lock settings, tombstones and frozen fixtures retain their existing code or bytes. [Final file inventory](migration-safety/verification.json)

**NOT_RUN** for the candidate v6 package reader, verify/overwrite, merge twice and re-export, occurrence birth/replacement collisions, production writer activation, UI, T5, Android and physical power-loss testing. Faults and deliberate interruptions ran on the local Linux filesystem. The independent post-change full Rust, fault, default npm, typecheck and build regression belongs to the orchestrator. No npm suite ran in this block.

The next gate is the orchestrator's single full default regression on this working tree. After that, replay the frozen v3/v5 plain and encrypted packages through a separately tested candidate reader, with populated overwrite, merge twice, re-export and reopened media hashes. The identity-collision and production-writer gates follow separately. [Frozen reader gate](V5_ORACLE.md) · [Migration plan](CORE_TYPES.md)
