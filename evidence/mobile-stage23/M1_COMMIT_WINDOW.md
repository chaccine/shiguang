# M1 migration commit window

Both failed-confirmation histories now recover the exact v3 or v5 preimage. The existing post-commit interruption still keeps the verified candidate. This change applies to the test-only candidate on `feat/mobile-stage23` at base `85d13a549a9886b6551ccb19589f41df0094cd8b` (PR12). Live Store open/save uses outer 1 / schema 5. [Candidate entry points](../../core/src/migration.rs#L37) · [Store version](../../core/src/store.rs#L22) · [Schema version](../../core/src/schema.rs#L3)

## Red reproduction

Four new fault tests exercise two histories on separate disposable copies of each frozen fixture. Both use the ordinary install path and fail parent-directory sync visit 6 after the rename to `synced`. For the first history, the installing test process exits with code 86 after the sync reports failure and before it can compensate. The parent process acquires fresh ownership for recovery. For the second, the fault hook creates a directory at the `clearing` destination. The kernel rejects the compensating rename with `EISDIR`. The test removes only that directory after install returns, leaving the original `synced` receipt alone for the next owner. [Contrast tests](../../core/src/migration/tests/faults.rs#L275)

Before recovery each case checks the writer fence, both hashes in the surviving receipt, the installed candidate, the named backup and every named original. In the red run, all four calls to recovery returned success, deleted the receipt and released the fence with the candidate digest still active. All four failed at the expected old-digest assertion. The existing confirmed-commit control passed for both fixtures. The bodies of `finish()` and `recover()` matched the preserved source byte for byte at this run. [Red source check](m1-commit-window/00b-red-source.txt) · [Raw red run](m1-commit-window/01-red.txt)

| Fixture | Old state and retained backup SHA-256 | Candidate SHA-256 | Original filenames and SHA-256 values checked |
| --- | --- | --- | ---: |
| v3 | `2c0677c397b5d135262ae5194f4854a94b78d03979189e91bbca7c0d0afd5936` | `202c26ed2e7aae64777f688ef7877304d972da8f52ac50f5b788293543d8d20c` | 7 |
| v5 | `b41b45bc93fc65ed0915f8cf7197b0cf496c01b2e14b22271408f5f37bc86ccb` | `3a15407ccd457d825303f02f33d183d81c62df3b1480e54f34eee38e25e33ba7` | 2 |

## Commit point and recovery

The installer still holds the instance lock and then the write lock from source inspection through cleanup. It verifies and syncs the preimage backup before publishing the pending record or replacing the state. The new receipt starts with `confirmed=0`. It carries that value through the `clearing` and `synced` renames. Only after the final directory sync returns durable does the installer publish `confirmed=1` in the existing receipt file. The two encodings have equal length and differ in one digit. The installer syncs that inode before the post-commit interruption point and before unlinking the receipt. [Install and confirmation](../../core/src/migration.rs#L169)

| Receipt under fresh ownership | Recovery decision |
| --- | --- |
| `pending`, `clearing` or `synced` with `0` | Verify the backup and the live state. Keep exact old bytes or atomically restore them from the backup. Rehash and sync the old file and sync the directory before removing the fence. |
| `synced` with `1` | Require the verified backup, the exact candidate hash and its version pair. The digit records the installing owner's successful directory sync. Recovery flushes the witness and directory before cleanup. A cleanup sync error leaves the fence in place. |
| Pre-M1 three-field receipt | `pending` and `clearing` still roll back. A three-field `synced` receipt cannot identify which history occurred, so recovery preserves the receipt, state and backup and keeps writers fenced. |
| Invalid digit, positive witness under another name, contradictory records or unexpected state hash | Reject recovery and retain the fence. |

The two additional fault tests cover witness I/O and receipt compatibility. A stop after directory sync but before the witness write leaves `0` and rolls back. A stop after the write but before its file sync leaves a visible `1` on this filesystem. That witness already proves the installer observed directory-sync success. Fresh recovery flushes it and keeps the candidate. The existing `MigrationAfterCommit` control runs after the witness file sync. [Witness and legacy receipt tests](../../core/src/migration/tests/faults.rs#L395) · [Recovery decision](../../core/src/migration.rs#L210)

## Recorded runs

Rust and Cargo 1.90.0 ran with `PATH=/home/box/.cargo/bin:$PATH`, `CARGO_NET_OFFLINE=true`, the lockfile and default test scheduling. The four expected red assertions account for every test failure. The first implementation passed each requested run. [Commands, exit codes and log hashes](m1-commit-window/commands.jsonl)

| Run | Passed | Failed | Raw output |
| --- | ---: | ---: | --- |
| Pre-fix contrast, including the existing post-commit control | 1 | 4 | [Red](m1-commit-window/01-red.txt) |
| Same contrast after the fix | 5 | 0 | [Green](m1-commit-window/02-green.txt) |
| Candidate default | 6 | 0 | [Default](m1-commit-window/03-candidate-default.txt) |
| Candidate with fault injection, including the default tests and the contrast | 20 | 0 | [Fault suite](m1-commit-window/04-candidate-fault.txt) |
| Native v5 oracle, including archived v3 packages | 4 | 0 | [Native oracle](m1-commit-window/05-native-oracle.txt) |
| Existing v3 migration interruption fault test | 1 | 0 | [Legacy migration](m1-commit-window/06-legacy-migration.txt) |

All four green regression cases compared the restored state and retained backup by exact bytes and SHA-256, checked the complete filename-to-digest map for the originals, and reopened the old state a second time. All 10 protected oracle entries matched their recorded lengths and SHA-256 at start and end. The working candidate matched all 9 starting entries. The preserved candidate copy matched all 9 at both checks. [Start integrity](m1-commit-window/00-preimage.txt) · [End integrity](m1-commit-window/07-postimage.txt)

## Residual windows and NOT_RUN

- A physical power cut between the witness write and its file sync can lose an unacknowledged witness. Recovery follows the surviving valid digit. An unreadable or malformed receipt stays fenced. The tests control these I/O boundaries on Linux. Torn sectors, device write-cache behavior and physical power loss were **NOT_RUN**.
- Final unlink is cleanup. An interrupted or lost unlink can leave a receipt for another owner. The post-commit control covers a surviving confirmed receipt. An actual unlink I/O error, power loss resurrecting an unlink and device-specific recovery were **NOT_RUN**. The separate partial-first-backup-copy window (M2) remains outside M1.
- **NOT_RUN** includes the full default npm suite, full-workspace Rust suites, typecheck/build, H1, v6 package reading/overwrite/merge, occurrence identity, editor/T5 and device runs. The existing npm gate remains with the orchestrator. [Independent gate record](MIGRATION_SAFETY_BLOCKED.md)

## Independent orchestrator verification

2026-11-26 23:41–23:42 Asia/Shanghai, Rust 1.90, `CARGO_NET_OFFLINE=true`, each suite once with default scheduling.

| Command | Observed result | Exit |
| --- | --- | ---: |
| `cargo +1.90.0 test --locked -p shiguang_core --lib migration::tests` | 6 passed | 0 |
| same with `--features fault-injection` | 20 passed, including the four unconfirmed-window tests, witness I/O, legacy receipts, and post-commit control | 0 |
| `cargo +1.90.0 test --locked -p shiguang_core --test v5_oracle` | 4 passed | 0 |
| `cargo +1.90.0 test --locked --workspace` | 260 passed, 0 failed, 1 historical generator ignored | 0 |
| `cargo +1.90.0 test --locked -p shiguang_core --features fault-injection` | 324 passed, 0 failed, 1 ignored | 0 |

No npm suite was run in this M1 verification. The production writer remains outer 1 / schema 5. [Independent logs](/workspace/sg-stage23/m1-h1/independent-m1/)
