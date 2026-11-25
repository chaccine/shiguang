# T-4.2a native v5 compatibility oracle

The production 0.1.12 Store at `feat/mobile-stage23@21691eaf8505ea542cdcf099113c6ff5b1bac376` wrote the five frozen files below. Its state uses outer `version=1`, `schemaVersion=5`, scalar `body`, ordered `photos` and `coverPhotoUseId`. The reader tests open disposable libraries and read the archived packages directly. [Frozen files](../../core/tests/fixtures/v5) · [Reader tests](../../core/tests/v5_oracle.rs)

## Native output and provenance

| File under `core/tests/fixtures/v5/` | Bytes | SHA-256 |
| --- | ---: | --- |
| `state.json` | 5,596 | `b41b45bc93fc65ed0915f8cf7197b0cf496c01b2e14b22271408f5f37bc86ccb` |
| `plain.sgbak` | 6,961 | `1e6219684710aa3ed5676fb4950713def97f106e9dee161f2ae677a905a2384b` |
| `encrypted.sgbak` | 7,263 | `ee63e120c01ab959e8990d7f2cd11aab2e5f27bc191f20c39a95f04063e4976f` |
| `media/ast-5be0e93dd09a92cb.png` (tea) | 297 | `5be0e93dd09a92cbff3c68ff6003585022b464bcc475bf2c780f29d0a8f15076` |
| `media/ast-336cf1dd4efe5ef1.png` (window) | 295 | `336cf1dd4efe5ef1d304b86c058f3e1bea3148cba705f45a4d2e698996b5b2e8` |

The one-time generator used `Store::open_exclusive` on a new temporary root with seed `synthetic-v5-oracle` and clock `2026-11-24T09:30:00Z`. It attached the two generated acceptance PNGs after losslessly recompressing each existing IDAT with zlib level 9. It copied the Store's on-disk state and originals and called `export_backup` and `export_backup_encrypted`. The archived generator source sits outside Cargo target discovery. [Generator](freeze_v5.rs) · [Original synthetic PNGs](../acceptance/fixtures) · [Acceptance fixture commands](../../scripts/run_acceptance.sh)

The plain package has magic `SGBAK\0\0\x01` and a `shiguang-backup` manifest with `formatVersion=1`, `schemaVersion=5` and `appVersion=0.1.12`. The encrypted package has magic `SGBAKENC\0\x01` and a `shiguang-backup-encrypted` header with `formatVersion=1`. It uses the native defaults of Argon2id v19 (65,536 KiB, three iterations, one lane) and XChaCha20-Poly1305. Its public **test-only** password is `synthetic-fixture-pass`. The salt and nonce prefix were sampled once. Decryption reproduces all 6,961 bytes of the frozen plain package, whose three entries match the standalone state and originals byte-for-byte.

`git diff 77a06375825b5e39045e447b0b7e42cc7b0d88bb 21691eaf8505ea542cdcf099113c6ff5b1bac376 -- core/src` compares the archived `unit-0.12` core with the source writer. The diff adds the unconsumed story module and its module declaration, extracts the existing SHA-256 validation in `PhotoUse::from_json` and exposes the optional-string reader within the crate. The Store, Snapshot and photo serializers, schema, and plain/encrypted backup implementations are identical at those commits.

To replay the generator with the pinned core and the two frozen synthetic originals, use a fresh scratch directory. A replay samples fresh encryption randomness.

```sh
scratch=$(mktemp -d)
cargo +1.90.0 build --locked -p shiguang_core
rustc +1.90.0 --edition 2021 evidence/mobile-stage23/freeze_v5.rs \
  --extern shiguang_core=target/debug/libshiguang_core.rlib \
  -L dependency=target/debug/deps -o "$scratch/freeze_v5"
media=core/tests/fixtures/v5/media
"$scratch/freeze_v5" "$scratch/run" \
  "$media/ast-5be0e93dd09a92cb.png" "$media/ast-336cf1dd4efe5ef1.png"
```

## Contents and observed reader behavior

The verified v5 manifest counts two active formal records, one active modification draft, one trashed record, one conflict copy, one tag, one favorite, two originals, zero missing media and zero deletion markers. The three rows and one conflict copy hold five snapshots in total, with seven photo references to four distinct use IDs.

- `rec-000002` has distinct formal and saved draft body bytes, including CRLF, surrounding whitespace, emoji and decomposed `e\u{301}`. The formal orders tea then window, with window as cover. The draft reverses the uses, edits the tea caption and sets tea as cover. Both covers are second. The record also carries leap-day date, time, distinct location and mood per snapshot, a tag and a favorite.
- `rec-000005` has a separate use of the tea original, an independent caption, and the museum-hidden preference. Resolving its edited draft with `KeepFormal` produced a recoverable copy with its own body and caption. The trashed `rec-000008` has an empty body and one captioned window photo. The library theme is dark.
- Both package forms passed native verification and overwrite of a populated disposable library. Reopening recovered the complete state and full media hashes. For v5 the tests also restored the trashed row and the conflict copy into its draft slot and checked both after another reopen.
- Each package merged into a separate populated library with its own formal record, original, tag, favorite and light theme. The tests compared every incoming and local row, tag, conflict and marker, including nested uses, captions and covers. They reopened, merged the same package again, and checked the state-file hash and every named media hash. Each merged library was re-exported in the input's encryption mode, verified, restored to another root and reopened.
- A wrong password, a flipped plain payload byte, and a flipped encrypted authentication-tag byte each failed verify, overwrite and merge. The tests checked the destination's in-memory state and the SHA-256 of its state file and originals after each attempted write and after reopen. The single-chunk encrypted reader reports `BACKUP_PASSWORD_WRONG` for either authentication failure. The plain reader reports `BACKUP_CORRUPT`.

The same tests also consumed both archived 0.1.9 packages from `b882029`, with outer 1/schema 3 in their source state and schema 3 in the plain manifest. That source adds a pure draft and a deletion marker. Its plain and decrypted state/media entries match the archived originals, and both packages passed populated overwrite, merge twice and re-export through the current v5 reader. Byte comparisons use scratch copies for opening raw states. The fixture-scoped Git attributes preserve the raw JSON bytes on checkouts with line-ending conversion. [Historical v3 provenance](../../core/tests/fixtures/v3/README.md) · [Fixture attributes](../../core/tests/fixtures/.gitattributes)

## Verification

Run on 2026-11-25 with the installed Rust/Cargo 1.90.0 toolchain, Cargo offline, and Node v24.22.1. Each regression command finished before the next began. Rust counts sum the per-target summaries.

| Command | Observed result | Exit |
| --- | --- | ---: |
| `cargo +1.90.0 test --locked -p shiguang_core --test v5_oracle` | 4 passed, 0 failed or ignored | 0 |
| `cargo +1.90.0 test --locked --workspace` | 254 passed, 0 failed, 1 historical generator ignored | 0 |
| `cargo +1.90.0 test --locked -p shiguang_core --features fault-injection` | 304 passed, 0 failed, 1 historical generator ignored | 0 |
| `npm test` with Node's default file concurrency | 27 files passed, 1 failed (`unit011-museum.test.ts`), 0 skipped | 1 |
| `node --test --test-isolation=none tests/unit011-museum.test.ts` | 19 cases passed, including the 5,000-record timing assertions | 0 |
| `taskset -c 0 npm test` | 28 files passed, 0 failed or skipped | 0 |
| `node --test --test-isolation=none "$suite"` for each `tests/*.test.ts`, serially in fresh processes | 285 cases passed across 28 files, 0 failed, skipped or cancelled | 0 |
| `npm run typecheck` | TypeScript check passed | 0 |
| `npm run build` | Web build passed | 0 |
| `git diff --check` | Clean | 0 |

During test development, an intermediate focused build exited 101 before running tests. The new reopen assertions attempted to compare two `RecordRow` values directly. The passing version compares their complete `to_json()` values. The first npm run reported only a file-level failure. On the full rerun the npm process had one available CPU, which makes this Node runner execute one test file at a time. All runs used the repository's existing assertions and timing limits.

The whitespace check also covered the nine new files individually against `/dev/null`. After the suites, all 15 archived state, package and media files across v3 and v5 matched their pre-regression SHA-256 values.

## Next migration gate

**NOT_RUN** for the candidate v6 reader, migration and atomic rollback, existing-ID birth and replacement collisions, production activation, browser, native-device and owner-private upgrade checks.

Before enabling the production writer, test the candidate on disposable copies of these exact v3 and v5 files. Inject write, rename, directory-sync and interruption failures and verify recovery of the exact preimage and original media hashes after reopen. Then replay both backup forms through the candidate v6 reader, including overwrite, repeated merge and re-export. Test birth identity in the existing use ID and remap fields separately with divergent formal/draft and forked insertions. [Migration and rollback gate](CORE_TYPES.md#migration-and-rollback-gate)
