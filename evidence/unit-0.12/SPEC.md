# Unit-0.12 M05 SEARCH CORE + UI · 0.1.12

The committed core below remains unchanged. The UI delivery and current verification are recorded
at the end of this document and in [UNIT0.12_REPORT.md](../UNIT0.12_REPORT.md). Historical core-only
NOT RUN entries are superseded by [ORCHESTRATOR_VERIFICATION.md](ORCHESTRATOR_VERIFICATION.md)
and the new report's explicitly named commands, not by a product/device acceptance claim.

Core/data/adapter/test chunk on `unit-0.12`, starting at main `f8df685e88cf6bea72740edf9ca27d857a116bf5`.
Implementation authority: owner request and `/workspace/u12/PREFLIGHT_AND_PLAN.md`, fresh Drive copies
`m05.md` (SG-M05 v1.0 / SG-D-025), `m05-audit.md`, `contract.md` (G01–G06 / SG-D-030).
Prior implementation evidence: `evidence/UNIT0.11_REPORT.md`, `evidence/unit-0.11/SPEC.md`, M02 query,
independent tag/favorite transactions, schema v5 backup/merge and deletion authority.

The committed core chunk implemented no UI. It added no dependencies, persisted index, schema fields or migration.
The app/package/workspace/Tauri/thumbnail versions and their lockfile entries are **0.1.12**; schema stays **v5**.
No auth/account changes, extra Codex runs, browser/Playwright/CDP/screenshot work, installer/bundle,
deployment, git commit/merge/push, signing, workflow or generated-schema changes were performed.

## Query contract

- `Store::search_page` / `search::search_page` and Tauri `search_page` return an on-demand projection.
  `ShiguangApi.searchPage(filter, cursor, limit, today?)` is implemented in MemoryAdapter and TauriAdapter;
  `src/domain/search.ts` provides the corresponding pure TS query. MemoryAdapter reloads authoritative
  storage once per call; native search reads the current Store under the existing command lock.
- Only `status=active && formal != null`. Pure drafts, trash, deletion markers and conflict copies do not
  enter search. An active edit draft never supplies any searched content or photo presence.
  `museumHidden` affects automatic recommendations only and is ignored by active search.
- `keyword` defaults to empty, trims ECMAScript whitespace (including ideographic space/BOM), folds ASCII
  English A–Z, and matches a **contiguous literal substring within one field**: formal title, existing body
  string, each formal PhotoUse caption, manual location, or current associated tag name. It does not join
  fields, tokenize words, normalize accents, fold non-English Unicode, interpret regex/HTML/script syntax,
  inspect media filenames/pixels, perform OCR, or call AI/network services. Existing body is readable text;
  story blocks/editor remain deferred. Missing/broken preview bytes do not alter formal photo presence.
- `tagIds` are current dictionary IDs, OR within the selected set; duplicates and selection order are
  immaterial. An unknown/deleted/merged-away ID does not match. The caller can refresh existing tag
  management/list APIs after mutation. No second tag dictionary or favorite authority is introduced.
- `from`/`to`: optional inclusive event-date bounds, strict existing real `YYYY-MM-DD` validation,
  independent of timezone and created date. Empty/null means unbounded. Invalid dates and reversed ranges
  reject with `INVALID_EVENT_DATE` before any scan. Gregorian leap/century behavior reuses existing rules.
- `favoriteOnly=false` means all; true means the current formal favorite flag must be true.
  `hasPhoto=null`/omitted = all, true = with photos, false = without photos. Different dimensions AND.
  `{}` or empty keyword plus cleared filters restores all active formal records.
- `order` defaults to desc; asc supported. Ordering and card projection reuse M02: event date in requested
  direction, timed group before untimed in both directions, then time/createdAt/recordId in that direction.
  Future flags use caller/device-local `today`; no relevance ranking. Results dedupe by record ID.
- Page size is an integer **1–500**, with `items`, `total`, `nextCursor` plus `queryKey` and `sourceGeneration`.
  Cards preserve existing TimelineItem fields; full body/photos remain in the existing reading API.
  This chunk adds no highlighting or hit snippets. A match in a non-cover caption still returns its record.

## Cursor and source consistency

The opaque versioned `sg12` cursor wraps the existing M02 complete key, normalized query fingerprint,
and a SHA-256 content-derived source generation. Query fingerprint covers keyword, normalized tag set,
all filter values, direction, and `today`. It excludes page size so callers may change batch size.

Generation is recomputed from **all** active formal records, including nonmatching ones, sorted by record ID:
ID, createdAt, content revision, favorite/value revision, tag IDs/revision, complete formal scalar fields and
ordered PhotoUse fields. Current tag ID/name pairs are included, sorted by ID. Drafts, audit timestamps,
settings, hidden preference, media bytes and derived previews are excluded. This detects changed restored
content even when revision counters happen to coincide. Identical restored source content has the same
generation; this is a content identity, not a persisted monotonic counter.

- Changed query/direction/day: `SEARCH_CURSOR_MISMATCH`.
- Changed formal source/tag dictionary: `SEARCH_CURSOR_STALE`.
- Malformed/wrong-version/oversized cursor: `INVALID_CURSOR` (32 KiB outer bound). Native cursor
  input must be a flat scalar array before reaching the shared recursive JSON parser; nested outer/inner
  containers are rejected, with authored regression cases.
- Invalid page size: `INVALID_LIMIT`.

The client must discard accumulated pages and restart with `cursor=null` on mismatch/staleness. Fixed-source
pages compare the full M02 key and are gap/duplicate free, including same-date ties. This is stricter than
legacy timeline cursors, which remain unchanged. Cursors are opaque and local to an adapter; the inner M02
encoding is inherited from each implementation. Do not persist or transfer them between adapters.
For future UI async responses, capture the current input/request generation and reject responses belonging
to older requests; the backend cannot suppress delivery of already completed IPC promises.

No mutation hooks/cache invalidation paths are needed. Existing commit, independent favorite/tag transaction,
trash/restore, purge, overwrite and merge operations remain the sole writers. Failed metadata writes retain
old results/generation. Search follows the **result** of existing merge conflict rules; it does not invent a
last-writer-wins rename policy or revive deleted records. A local live tag name retained by merge remains the
searchable name. User-confirmed overwrite can intentionally restore older data under the existing G02/G03 flow.

## Complexity and measured scope

Each call scans current formal text and fingerprints it (linear in serialized source bytes), resolves tag
names by map, sorts references using M02 (O(n log n)), and materializes only the requested cards. Rust hashes
per-row JSON incrementally; TS reuses the existing synchronous SHA-256 utility over canonical tuple JSON.
No media reads/decodes, writes or durable search index. This favors correctness and simple restore behavior;
a future measured optimization could cache by a reliable source generation without changing this contract.

The reproducible synthetic benchmark uses 5,000 records, 6,250 PhotoUses, two current tags, about 2.4 KiB body
text per record, photos on 75% of records, favorites on about one third, hidden preferences, mixed dates,
times, English/Chinese fields and a 20% selective keyword. Node state is 16,795,302 UTF-8 bytes. Each normal
page returns 50 of 1,000 matches; the combined query returns 50 of 250. Four pages contain 200 unique IDs.
Field-size ranges, machine description and measured samples are in `search-benchmark-node.json`.

The **10,000 ms per-call** regression guard is deliberately broad for this synthetic debug/Node workload
on the measured Linux Xeon environment (8 logical CPUs, about 16 GiB RAM). It detects gross regressions;
it is not a user responsiveness target. Node first-call sample was 453.603 ms; adapter cold open + first
was 375.178 ms; warm first pages 344.853–366.200 ms; subsequent pages 344.263–350.507 ms.
Cold means a new Store/adapter plus validation and first query; OS caches are not flushed. Node's domain
measurements precede adapter measurements, so the adapter cold case does not mean cold V8 code.
Rust debug benchmark is authored with the same field distribution and guard, **NOT RUN / uncalibrated here**
because Rust 1.90 is unavailable. No device, Tauri IPC, UI frame/IME or large-photo performance PASS is claimed.

## Verification and next chunk

See [CORE_VERIFICATION.md](CORE_VERIFICATION.md) for actual commands, counts, initial test corrections,
missing-tool blockers and the Rust/TS coverage map. Rust tests are authored but unexecuted in this environment.

The subsequently implemented UI chunk: independent 查找时光 route/entry from timeline and museum/desktop sidebar while preserving five
mobile tabs; IME-safe input/debounce, loading/empty/error states, AND/OR copy, removable filters/reset,
query/order/scroll preservation, safe text-node highlighting, existing reading/favorite/tag routes,
stale-page refresh, both themes and accessibility. Browser and device checks belong to the parent via
computerUse. Story blocks/editor, OCR/AI, cloud search and persisted indexing remain out of scope.

Reproduction once the local prerequisites are available (no download/install implied):

```sh
export PATH=$HOME/.cargo/bin:$PATH
export CARGO_NET_OFFLINE=true
cargo test --locked --workspace
cargo test --locked -p shiguang_core --features fault-injection
SHIGUANG_SEARCH_STRESS_OUT=/tmp/unit012-search-rust.json cargo test --locked -p shiguang_core --test unit012_stress -- --nocapture
npm test
node --test --test-isolation=none tests/*.test.ts
npm run typecheck
npm run build
SHIGUANG_SEARCH_STRESS_OUT=/tmp/unit012-search-ts-benchmark.json node scripts/benchmark-u12.mjs
```

## UI delivery (2026-11-25)

- `View=search` / preview `?view=search` is independent of `collect` and preserves the five `NAV_TABS`.
  Timeline, museum and desktop sidebar entries use the same search instance. Existing favorites and
  tag-manager routes/transactions remain authoritative.
- Input uses a 450 ms trailing debounce and explicit form submit. Every raw input/composition/filter
  change cancels the scheduled callback, advances the request generation and removes obsolete results
  immediately. Composition does not dispatch intermediate searches. API pages, errors and delayed
  hit reads all check the captured generation. Filters use the existing core semantics; Chinese copy
  explains tag OR / dimension AND. Chips remove individual conditions, including a deleted tag ID
  retained with an actionable label rather than silently broadening the query. Clear-all clears search
  conditions while retaining the chosen date sort.
- Inclusive date fields validate actual dates, range order and native `validity.badInput`; errors offer
  correction/removal. The status is polite/live, errors use `role=alert`, results expose `aria-busy`.
  Page size is 24; Load more is an explicit accessible button. Source/query/invalid cursor errors discard
  accumulated pages and retry the first page once; repeated failure exposes retry, without a loop.
- Result cards reuse M02 `TimelineItem`, formal-card styles, ordering and the existing observer-backed
  thumbnail loader. They use actual titles only. Safe highlight output is text nodes and `mark` elements;
  input never becomes a regular expression or HTML. Excerpts preserve actual formal body, PhotoUse
  caption (including non-cover), location and current tag-name text, bounded to four field snippets of
  about 240 UTF-16 units each. Generated ellipses, normalized whitespace and joined tag names cannot
  masquerade as literal hits. Long literal matches keep their visible matched portion highlighted.
- Existing page projections explain ordinary hits without extra record reads. Unresolved deep-body or
  non-cover-caption hits hydrate through existing `getRecord`, sequentially with event-loop yields,
  bounded by each requested page. These reads never consume draft text. Projection changes or loss of
  the actual match trigger refresh. There is no new IPC, backend algorithm or persistent index.
- Reading/back retains keyword, all filters, order, loaded depth, scroll and focus. Re-entry revalidates
  the authoritative source/query generation; unchanged results keep their DOM, changed results rebuild
  to the previous depth with bounded pages. Interrupted snippet reads resume on return. Committing an
  edit opened from search returns through the existing reader so its back path is preserved.
- A UI API wrapper observes successful commit/favorite/tag/trash/restore/purge/backup restore/merge
  calls and invalidates the search session. Failed writes and draft-only writes do not falsely publish
  changes. Favorite calls use existing `setFavorite` CAS and expose the returned durability qualification;
  no draft commit is invoked. `museumHidden` remains outside active search filtering.
- Styling uses existing warm-paper / 灯下展馆 tokens, rem sizes, 44 px minimum action/label targets,
  visible focus and reduced motion. This is implementation/harness evidence, not visual or AT acceptance.
- Explicit browser-only `?searchDemo=mixed|empty` uses a separate synthetic storage key and fixed clock;
  native sessions and normal startup cannot auto-seed it. Mixed has 32 formal records, two drafts
  (one editing a formal record) and one trash entry. See [BROWSER_CHECKLIST.md](BROWSER_CHECKLIST.md)
  for exact IDs, URLs, query counts, actions and pending light/dark phone/desktop screenshots.

## UI verification and release measurement

Current local results: Rust workspace 241 passed / 1 historical ignored; fault injection 291 passed /
1 historical ignored; frontend 254 passed (219 existing + 28 UI + 7 synthetic fixture), typecheck and
frontend build passed. Existing tests/assertions are unchanged. CI, screenshots, browser IME/AT,
native IPC and product/device acceptance remain NOT_RUN pending parent/orchestrator checks.

The literal `cargo +1.90` alias tried to synchronize an unavailable alias and was blocked by the sandbox's
read-only rustup temp path. Without installing or changing a toolchain, the already installed explicit
`cargo +1.90.0` ran the release benchmark successfully. Results are in
[search-benchmark-rust-release.json](search-benchmark-rust-release.json): cold open + first 270.784 ms;
warm first 79.873 / 79.411 / 79.102 ms; pages 2–4 81.465 / 79.870 / 80.108 ms;
combined first 81.243 ms. Dataset: 5,000 records, 6,250 PhotoUses, 16,632,810 state bytes,
2,440–2,459 UTF-8 body bytes; 1,000 keyword / 250 combined matches, page size 50, four pages with
200 unique IDs. The 10 s guard is still only a gross-regression guard. No backend optimization was made.
The earlier ~350 ms synchronous TS preview cost remains a browser responsiveness concern; debounce,
bounded pages and yielded snippet reads are not evidence of phone or browser latency acceptance.

This sandbox rejected the static preview server bind with `EPERM`; parent must start the existing server
on the host before using the checklist URLs. No browser or screenshot automation was run here.
