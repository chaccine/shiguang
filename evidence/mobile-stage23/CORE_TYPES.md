# T-4.1 ordered story types

Verified on `feat/mobile-stage23` at `0dca11d76f6e95380b7c5e17642b2998cbf00330`. The live writer emits outer version 1 and schema 5. Only the new synthetic Rust tests call the in-memory story model. The scope follows M01 C13/C14/C20/C21, the v1.3 audit and SG-D-030 G03/G04. [Stage plan](PLAN.md) · [Snapshot writer](../../core/src/model.rs#L183) · [State version check](../../core/src/schema.rs#L40)

## Implemented behavior

- One sequence holds paragraphs, small headings, quotes, dividers and existing `PhotoUse` values. Text runs carry independent bold and italic flags. The decoder requires each variant’s exact fields. All entry points reject duplicate occurrence IDs. A story with photos requires a cover pointing to one of its uses, and a story without photos requires a null cover. Separate stories can reference different originals at the same occurrence. [Types and decoder](../../core/src/story.rs) · [Malformed inputs](../../core/tests/story.rs#L243)
- A zero-length legacy body contributes zero blocks. Every other body becomes one plain run in one paragraph, followed by the photo uses in array order. Tests reconstruct body, photos and cover from the story, compare v5 writer bytes, and check the source snapshot’s bytes again. Cases include CRLF, whitespace-only bodies, repeated originals with distinct IDs and captions, integrity metadata and a non-first cover. [Legacy conversion](../../core/src/story.rs#L145) · [Writer oracle](../../core/tests/story.rs#L38)
- R02 classifies zero or one leading unmarked paragraph followed only by photos as simple. Plain text concatenates runs verbatim and joins textual blocks, including empty ones, with one newline. The photo iterator retains each occurrence’s caption. Whitespace and dividers alone fail the formal content minimum. A standalone caption is an invalid block. Publication also requires the existing date and stored-original checks. Tests cover equal plain text with different structure, all marks, combining characters and literal script and Markdown text. [Projections](../../core/src/story.rs#L175) · [Behavior tests](../../core/tests/story.rs#L112)

## Local verification

Rust and Cargo 1.90.0 ran from the installed rustup toolchain with Cargo offline. Node was v24.22.1. Rust totals sum the per-target test summaries.

| Command | Actual result | Exit |
| --- | --- | ---: |
| `cargo +1.90.0 test --locked -p shiguang_core --test story` | 9 passed | 0 |
| `cargo +1.90.0 test --locked --workspace` | 250 passed, 0 failed, 1 ignored | 0 |
| `cargo +1.90.0 test --locked -p shiguang_core --features fault-injection` | 300 passed, 0 failed, 1 ignored | 0 |
| `npm test` during concurrent Rust/TS work | 26 files passed, 2 failed | 1 |
| `npm test` on its own | 28 files passed, 0 failed | 0 |
| `node --test --test-isolation=none "$suite"` once per `tests/*.test.ts`, each in a fresh process | 285 cases passed, 0 failed or skipped | 0 |
| `npm run typecheck` | TypeScript check passed | 0 |
| `npm run build` | Web build passed | 0 |
| `git diff --check` | Clean | 0 |

Git’s whitespace check also covered the three new files separately against `/dev/null`. The two files reported on the first npm run were `unit011-museum-ui.test.ts` and `unit011-museum.test.ts`. The runner gave file-level results. Both passed on rerun with the same assertions and timing limits. Each Rust suite ignored the existing frozen-v3 fixture generator. [Museum timing checks](../../tests/unit011-museum.test.ts#L422) · [Frozen fixtures](../../core/tests/fixtures/v3/README.md)

**NOT_RUN for ordered stories** — disk migration and rollback, old-reader replay, backup verify/restore/merge/re-export, live UI/IPC/query integration, replacement, browser and native checks. Existing backup regression results apply to the v5 writer. Rust is the sole story-format implementation. TS projection parity belongs at the first consuming adapter.

## Occurrence identity before T-4.2

The canonical record origin `(source recordId, createdAt)` distinguishes reused IDs across different records. A recorded photo alias resolves an earlier remap. Today the validator includes current asset and digest in occurrence ownership, and merge includes them in its fallback source key. This can reject or split a genuine replacement. [Owner check](../../core/src/merge.rs#L165) · [Origin and normalization](../../core/src/merge.rs#L246)

**Minimal counterexample.** Two backups of record `R` have no aliases or conflict copies. Local revision 1 has `pu-000002 → X`. Incoming revision 2 has `pu-000002 → Y`. Both covers point at that ID.

| History consistent with those backups | Identity |
| --- | --- |
| Copy R after publishing X. Replace X with Y and publish revision 2. | One occurrence |
| Copy the unpublished draft R with `seq = 1`. Both copies allocate `pu-000002` independently. One publishes X, the other publishes Y and makes an ordinary edit to reach revision 2. | Two occurrences |

All observable metadata can agree between the histories. The sequential ID, revision and empty remap table cannot distinguish them. [Current allocator](../../core/src/store.rs#L1495) · [Same-record collision regression](../../core/tests/unit06_merge.rs#L452)

**Proposed mapping, design only**

1. Assign each new insertion a collision-resistant `photoUseId` and retain it on replacement. The existing field can carry the birth identity. Check numeric-suffix/`seq` validation and both adapters before choosing the spelling. Keeping the sequential allocator would require independent birth information.
2. For a legacy use, retain its existing photo alias or freeze the v5 source tuple `(source recordId, original useId, assetId, full SHA-256)` with record `createdAt` in the existing remap table, even when source and local IDs agree. V5 supported no same-use replacement. Keep that binding through future asset changes. Legacy forks that independently inserted the same original at the same ID with no distinguishing history remain ambiguous. Preserve divergent versions under the existing conflict policy.
3. Map each source occurrence once across formal, draft and conflict copies. Reserve live IDs and alias targets, reuse an existing mapping or a free ID, and allocate once on collision. Reject contradictory aliases. Map each embedded use and its cover together, then compare complete stories. Reimport must preserve state bytes, `seq` and conflict counts, including after re-export. Media integrity still uses size and full hash. [Cover remap regression](../../core/tests/unit010_schema.rs#L541) · [Conflict deduplication](../../core/src/merge.rs#L343)

## Migration and rollback gate

- The future reader must accept outer 1 with schema absent/1 through 5, and outer 2 with schema 6. Unknown pairs must fail before writes or cleanup. The early reader at `425e57c` checks only outer `version` and defaults absent `body` and `photos` to empty. Outer 2 gives it a refusal path. Keep plain `.sgbak` and `SGBAKENC` v1 envelopes, with schema 6 in future backup manifests. [Preflight](../../core/src/store.rs#L1706) · [Manifest check](../../core/src/backup.rs#L448) · [Encrypted envelope](../../core/src/backup/crypto.rs#L9)
- Under the existing write lock, recover pending imports, back up and verify the exact original state bytes, then validate an encoded round trip of every formal, draft, trashed and conflict snapshot. The current migration discards the final replacement’s durability result. Reuse verified copy, same-directory atomic replacement and directory sync. A durable pending migration entry needs the backup name and old/new hashes. Clear and sync it only after verifying a durable install or rollback. On recovery with an entry present, keep an intact old state or atomically restore and verify the preimage if the candidate is visible. Stop on an unexpected hash or an unverifiable backup. An uncertain sync keeps the writer closed until recovery resolves the pending entry. [Migration write](../../core/src/store.rs#L469) · [Atomic replacement](../../core/src/persist.rs#L51)
- Reuse the overwrite and merge journals for imports. The former coordinates a media-directory swap. The latter records a candidate hash and added files. Neither holds the exact state-only migration preimage. Gate the writer switch on schemas 1–6, old-reader refusal, frozen v3 plain/encrypted verify and restore, merge twice and re-export with replacements and fork collisions, media hashes after reopen, and pre/post-rename sync and interruption faults. [Restore recovery](../../core/src/backup.rs#L1132) · [Merge recovery](../../core/src/backup.rs#L1399)

## Independent orchestrator verification

Serial workspace250/fault300/npm285/typecheck/build/diff-check all passed (exit0), with original assertions/timing limits unchanged. Each cargo suite retains the single historical fixture generator ignore. Machine record: [CORE_TYPES_VERIFICATION.json](CORE_TYPES_VERIFICATION.json); durable raw logs `/workspace/sg-stage23/verification/t4-core/`. These are not story migration/restore results.
