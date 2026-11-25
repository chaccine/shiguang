# Unit-0.12 M05 search — parent computerUse checklist

Status: **NOT_RUN**. This file describes reproducible checks. No browser, screenshot, device or final product PASS is claimed. Execute through the parent's approved computerUse only; do not use Playwright, CDP, shell-driven browsing, browser launch scripts or screenshot scripts.

## Current scope: Android phone first

Owner update 2026-11-25 18:18 UTC+8: Android phone is the only priority delivery/specialized acceptance target. Desktop-specific layout/build acceptance and desktop screenshots are DEFERRED. Existing desktop code remains supported and is not removed. Shared Rust/TS correctness, backup compatibility and G01–G06 tests remain mandatory. Use 390×844 plus 360 px narrow width checks; prioritize touch, scrolling, reading/back context and perceived response. Desktop instructions below are retained only for future work, not required now.

## Start and reset the synthetic preview

1. From `/workspace/shiguang-app`, build with `npm run build`. Start the existing static server with `node scripts/preview-server.mjs` if port 1420 is not already serving this checkout. This command only serves built files; it does not open or drive a browser.
2. In the shared browser, navigate to **http://127.0.0.1:1420/?searchDemo=mixed&view=search**. The explicit `searchDemo=mixed` parameter resets and seeds only `shiguang.preview.unit012.search`, using the normal MemoryAdapter APIs and fixed audit timestamps. It does not clear the ordinary preview key or read private files. Wait until the search status reports results and the list is no longer busy.
3. To get a genuinely empty store, navigate to **http://127.0.0.1:1420/?searchDemo=empty&view=search**. There are no fake records or tags. Do not combine either URL with `demo=1`.
4. Reloading either URL resets that isolated synthetic fixture. Do not reload during a reading/back or mutation check. Navigate with app controls to preserve the test's changes and context.
5. Both demo values are ignored by the native/Tauri runtime. Missing, unknown or differently capitalized `searchDemo` values never opt in. The seeding function refuses a nonempty adapter. The fixtures are developer previews, not a production data import.

The app's existing theme control is under `mine-tab` → `appearance-link` → `theme-select`: choose `light` (浅色 · 暖纸本) or `dark` (深色 · 灯下展馆). Return via `timeline-tab` → `timeline-search`. Set the theme again after resetting the fixture. Use the parent's normal viewport controls for 390 × 844 phone and 1440 × 900 desktop CSS-pixel viewports; record the actual viewport and device scale used.

## Deterministic fixture

The mixed fixture has **32 active formal records**, **2 drafts** (one uncommitted edit to an existing formal entry and one pure draft), and **1 trashed record**. It uses only locally authored SVG bytes. A page contains at most **24** results.

| Purpose | Record ID / testID suffix | Exact keyword | Expected matching field |
|---|---|---|---|
| Titled photo entry, already favorite, pending private edit | `rec-000004` | `青苔书签` | Title `合成：海边旅行的青苔书签` |
| Untitled text entry, already favorite | `rec-000006` | `慢车` | Near the end of a long formal body, beyond the initial summary |
| Untitled photo-only entry, already favorite | `rec-000007` | `玻璃倒影` | Caption of the second photo, not the cover |
| Manual location, initially not favorite | `rec-000010` | `海风车站` | Formal location |
| Current tag name | `rec-000012` | `星河主题` | Associated tag, not title/body |
| Literal/script-looking content | `rec-000013` | `<script>alert("search-demo")</script>` | Formal body, displayed literally |
| Museum-hidden formal entry, already favorite | `rec-000014` | `隐蔽小径` | Formal body; remains searchable |
| Outside the combined date range | `rec-000015` | `旧时旅行` | Title; event date `2023-01-01` |
| Text-only, initially not favorite | `rec-000017` | `不含照片的旅行` | Title |
| Future entry | `rec-000018` | `未来时光` | Title; event date `2099-01-01` |
| 22 pagination entries | `rec-000019` through `rec-000045` with gaps for photo uses | `分页集合` | Body, exactly 22 results |
| Pure draft | `rec-000046` | `纯草稿线索` | Must not match |
| Trash | `rec-000047` | `回收站线索` | Must not match |

Tag IDs are stable: 旅行 = `tag-000001`; 朋友 = `tag-000002`; 星河主题 = `tag-000003`. All special-string checks must type or paste the text into the search input; never execute it in a console.

## Controls and exact testIDs

| Control | `data-testid` | Values / behavior |
|---|---|---|
| Timeline / museum / desktop sidebar entry | `timeline-search`, `museum-search`, `sidebar-search` | Open independent 查找时光 view `#view-search` |
| Keyword and explicit submit | `search-input`, `search-submit` | 450 ms debounce after normal input; composing text waits for IME commit |
| Inclusive event-date bounds | `search-from`, `search-to` | Native date input, `YYYY-MM-DD` |
| Favorite-only | `search-favorite` | Checkbox |
| Photos | `search-photos` | `all`, `with`, `without` |
| Event-date order | `search-order` | `desc` = 从近到远; `asc` = 从远到近 |
| Tag selection | `search-tag-tag-000001`, `search-tag-tag-000002`, `search-tag-tag-000003` | Buttons with `aria-pressed` |
| Selected-condition removal | `search-chip-keyword`, `search-chip-from`, `search-chip-to`, `search-chip-favorite`, `search-chip-photos`, `search-chip-tag-tag-000001` (and other tag IDs) | Removes only that condition |
| Clear all / load more | `search-clear`, `search-more` | Explicit actions; no unbounded automatic loading |
| List / status / error / retry | `search-list`, `search-status`, `search-error`, `search-retry` | List has `aria-busy`; status is polite `role=status`; error is `role=alert` |
| Open formal reading | `search-read-<recordId>` | Example: `search-read-rec-000007` |
| Durable favorite mutation | `search-favorite-<recordId>` | Example: `search-favorite-rec-000004` |
| Existing reader | `reading-back`, `reading-edit`, `reading-content`, `reading-cover`, `reading-photo` | Formal content; original photo order and captions |
| Existing tag management | `search-manage-tags` | Opens the same manager used from the timeline/我的 |
| Existing museum favorites | `museum-tab` → `museum-enter-favorites` | Existing same-authority cabinet; `museum-read-<recordId>` |

## Interaction checks

Record PASS/FAIL/NOT_RUN for each performed check, actual observations and screenshot names. Unit tests do not substitute for these observations.

1. **Entry/navigation.** Reset mixed. Go to `timeline-tab`, select `timeline-search`; verify the independent 查找时光 heading. Go to `museum-tab`, select `museum-search`; verify the same search view. On desktop use `sidebar-search`. On phone verify exactly five persistent primary tabs in order: 时光轴 / 日历 / ＋记录 / 博物馆 / 我的. The existing 我的 → 标签管理 · 收藏 destination remains reachable.
2. **Individual fields and real excerpts.** From cleared conditions, submit each of the first five keywords in the fixture table. Each returns exactly one listed ID. The long-body hit includes 慢车; the photo-only hit includes 玻璃倒影 from the second photo's caption; location and tag hits display their actual matched text. Untitled entries remain untitled/naturally labeled, with no fabricated keyword title. Read `rec-000007`; verify two original photo uses and captions, with the correct cover, then return.
3. **Literal highlight safety.** Search the entire literal `<script>alert("search-demo")</script>`, then `[a-z]+`, `.*`, `^$`, `\d`, `(x|y)`, `%_`, and `<img src=x onerror=alert(1)>`. Each matches only `rec-000013`; text and `<mark>` highlighting remain literal, no alert or injected image appears. Search `[A-Z]*`: zero matches. The content must not be parsed as regex or HTML. Search `  青苔书签  `: the same single title result despite surrounding spaces.
4. **AND/OR filters.** Clear all. Select 旅行 and 朋友: exactly **7** unique results, including records that have only one of these tags. Keep both selected, keyword `旅行`, from `2024-02-29`, to `2024-03-03`, favorite-only checked, photos=`with`: exactly **2** results, `rec-000004` and `rec-000007`. Verify the Chinese explanation says tags match any selected tag and different dimensions all apply together. Toggle order `asc`/`desc`: these two reverse by event date. Remove one condition chip and verify only that control clears.
5. **Photo dimension and inclusive dates.** With all other filters cleared, photos=`with` returns **9** records, `without` returns **23**, `all` returns **32**. Set from and to both `2024-02-29`: exactly `rec-000004`, proving inclusive boundaries. Set from `2024-03-04`, to `2024-02-29`: actionable date error, no stale result accepted; correcting or removing a bound recovers. Test keyboard and native date-picker input.
6. **No match/reset/empty.** Enter `演示里不存在的紫色鲸鱼`: “没有找到相符的时光”, selected keyword chip, and a usable clear action; no manufactured result. Remove the keyword chip or clear all to recover. Open the empty URL and confirm an honest neutral empty state, no fake tags/cards, working search/clear controls, and the same five phone tabs.
7. **IME, debounce and rapid typing.** On an available Chinese IME, begin composing 旅行 without committing; verify the UI does not treat intermediate phonetic composition as a finalized search. Commit the candidate, then explicitly submit as well. Type/delete/change quickly between 青苔书签 and 慢车: final results must correspond to the current displayed input. Observe accessible loading/status feedback; do not infer a race PASS solely from speed. Automated TS tests provide the controlled stale-response case.
8. **Bounded paging and reading/back.** Reset mixed; keyword `合成` yields **31** results (the long untitled body lacks this keyword). Set order=`asc`, load the next page using `search-more`, then scroll to `search-read-rec-000013`. Open and use `reading-back`. Verify keyword, order, both loaded pages, previous scroll position and sensible focus survive. Separately repeat with the two-result combined filter from check 4 to verify tag/date/favorite/photo context. Open the literal entry, choose `reading-edit`, append `合成修改已正式保存` to its body, explicitly commit, and use the provided reading/back path; the search context survives and the changed formal content is reflected.
9. **Formal/draft isolation and favorites/museum linkage.** Reset mixed. Search 青苔书签; read it and verify the formal body begins “这是一条虚构的正式记录”, never “草稿专属未发布”. Return and toggle `search-favorite-rec-000004` off; wait for successful persisted feedback. `museum-tab` → `museum-enter-favorites` no longer lists that record. Return via museum search, toggle it on, and confirm it reappears in the cabinet. Search `草稿专属未发布` and `草稿专属地点`: both remain zero. The pending edit is still in the existing 草稿箱 and has not been implicitly committed. Search `纯草稿线索` and `回收站线索`: zero. Search `隐蔽小径`: one (`rec-000014`), although its museum automatic-recommendation preference is hidden.
10. **Tag authority refresh.** Reset mixed. Search 星河主题, yielding `rec-000012`; open `search-manage-tags`, rename the existing 星河主题 tag to 星河新主题 through the existing dialog and confirmation flow. After closing/re-entry, the old keyword yields zero, the new one yields one, and selectable tags/chips show current dictionary names. Merge into 朋友 and later delete only the tag through the same existing controls, accepting the shown impact confirmation. Search/tag choices refresh; the formal record remains and no record/photo is deleted. Existing unit tests cover failed atomic writes; this is a manual UI observation.
11. **Keyboard/accessibility and layout.** Tab through input, submit, tag buttons, bounds, favorite checkbox, photos/order selects, chips, clear, read/favorite and load more. Verify visible focus, logical order, label announcements and busy/error/status announcements with the parent's available assistive technology. At 390 px and enlarged text, controls wrap without clipping; touch targets are at least 44 CSS px. Verify both theme token systems, reduced-motion preference, lazy thumbnail loading and photo failure labels if exercised. Report any unavailable assistive technology/device checks as NOT_RUN.

## Screenshot matrix (all pending)

Capture using computerUse only, after recording viewport/theme and waiting for final current-query results. Suggested filenames below are planned artifacts, not files created by this implementation.

| Viewport/theme | Mixed cleared (first page) | Combined two-result filter | Empty URL |
|---|---|---|---|
| Phone 390 × 844, light | `m05-phone-light-mixed.png` | `m05-phone-light-combined.png` | `m05-phone-light-empty.png` |
| Phone 390 × 844, 灯下展馆 | `m05-phone-dark-mixed.png` | `m05-phone-dark-combined.png` | `m05-phone-dark-empty.png` |
| DEFERRED Desktop 1440 × 900, light | `m05-desktop-light-mixed.png` | `m05-desktop-light-combined.png` | `m05-desktop-light-empty.png` |
| DEFERRED Desktop 1440 × 900, 灯下展馆 | `m05-desktop-dark-mixed.png` | `m05-desktop-dark-combined.png` | `m05-desktop-dark-empty.png` |

Also capture the literal-highlight result, long-body/non-cover-caption hit, no-match with removable chips, invalid-range error, reading/back context and favorite cabinet linkage if needed to substantiate observations. Save actual evidence paths and a concise result log separately. CI, native IPC, real-phone responsiveness, final product/device acceptance and screenshots remain the orchestrator/parent's responsibility.
