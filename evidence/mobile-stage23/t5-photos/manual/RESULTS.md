# T5 photos — browser walkthrough RESULTS

Run: 2026-11-27 (Asia/Shanghai). Preview already serving current dist at http://127.0.0.1:1420/ (built 2026-11-27 05:41 Asia/Shanghai, tip a08317f). The existing `npm run preview` process was not killed or rebuilt; app source was not changed. Only the listed synthetic RAM fixtures and the two fixture PNGs under `core/tests/fixtures/v5/media/` were used (replacement used `ast-336cf1dd4efe5ef1.png`, a teal diagonal stripe). No private photos.

Chrome DevTools Device Toolbar was set to Responsive, Fit to window, and the CSS viewport was set explicitly for each required combination. Fresh RAM fixtures were loaded per pass (and refreshed when the shared one-shot replace failure had been consumed).

## Actual CSS viewports

| Target | Theme | Actual CSS viewport | DPR | Toolbar vs CSS |
| --- | --- | --- | --- | --- |
| 360×800 | Light paper | 360×800 | 2 | Matched. Console: `[360, 800, 2]`. |
| 360×800 | Lamplit dark | 360×800 | 2 | Matched. Toolbar was not changed between the 360 light and dark passes. |
| 390×844 | Light paper | 390×844 | 2 | Matched. `page.viewportSize()`, `html` bounding box, and screenshot IHDR were all 390×844. No 390×800 mismatch. DPR carried over from the 360 console reading; the toolbar DPR was not changed. A later Console re-measure at 390 did not yield a clean `[390, 844, 2]` line (expressions concatenated / drawer opened). |
| 390×844 | Lamplit dark | 390×844 | 2 | Matched. Toolbar remained Responsive 390 × 844; every Playwright PNG in this cell is 390×844. |

## Compact results (items 1–8)

Native Android-native touch, IME, TalkBack, native picker, native Back, and real-device upgrade/retention were **not** exercised and stay **NOT_RUN** in every cell.

| Cell (actual viewport) | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 360×800 light paper | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| 360×800 lamplit dark | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| 390×844 light paper | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| 390×844 lamplit dark | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |

### Shared caveats (do not change the PASS marks above)

- Under Device Toolbar touch emulation, a Playwright **desktop mouse** `locator.mouse` drag did **not** arm at 360×800. At 390×844, a `dispatchEvent` pointer with `pointerType: 'mouse'` armed immediately (begin without the 350 ms hold). Touch-emulated hold ≥350 ms, drop, and one undo **did** pass in every cell.
- A destination reached by holding near the scroll edge was demonstrated at 390×844 as a drop onto the **partially visible first cell** (`封面 ✓` at the top edge, destY ≈ 17–18). Continuous auto-scroll while holding at the scroller edge was **not** separately demonstrated on the two-photo Simple album.
- `page.evaluate` is blocked in this browser automation, so `document.activeElement` could not be read directly. Focus after moves / cancel / replace was recorded from the gold focus ring, aria snapshots, and which control was enabled (after 上移/下移 to an end position, focus correctly falls back to 拖动排序 because the move button becomes disabled).
- File-chooser cancel used the automation chooser with paths omitted (not a native Android picker).
- After a refused 色样乙 publish in item 8, the EMPTY_CONTENT / “已移除最后一张照片” banners can remain visible when navigating to formal 色样甲. That is leftover chrome, not a failure of 甲’s shared mint original.
- Favicon 404 and the fixture clock “已自动保存 08:00” were noted and are non-blocking.
- App-shell width can read 345 CSS px inside a 360 CSS viewport when a classic scrollbar is present; no bad horizontal overflow of content was observed.

---

## 360×800 light paper — items 1–8

Actual viewport: **360×800**, DPR **2**. URLs as in the checklist (`theme=light`).

1. **PASS.** Empty (`?stage01=empty&theme=light`): empty-library state, no sample timeline. Timeline (`?stage01=timeline&theme=light`): opened a mint photo in reading and 返回. Photos kept original illustration colors (not theme-tinted). Text contrast readable on light paper. Controls labelled. No bad horizontal overflow.
2. **PASS.** Simple (`?stage23=simple&theme=light`): read 两张色样, edit, 速记. Second (orange) photo is 封面 ✓. 上移 / 下移 moved it; end-position move buttons disabled; captions, cover and thumbnails updated; focus fell back to 拖动排序 at an end. Undo / redo restored and reapplied order. Reopening the draft in the same tab (继续草稿) kept the saved order (orange first after the up move). Formal reading stayed on the original order until 存入时光.
3. **PASS.** Touch-emulated hold ≥350 ms on 拖动排序, move onto the other cell, release: order matched the equivalent button moves; one undo restored the entire pre-drop order. Desktop-pointer direct mouse drag did not arm under touch emulation at this viewport (see caveats); mouse-arm was later confirmed at 390.
4. **PASS.** Early lift before the hold: no `.dragging`. Escape during an active drag, and release outside any target: order, captions, cover and thumbnails matched the starting state; drag class and drop-target cleared; handle regained focus at the starting scroll position.
5. **PASS.** Interleaved (`?stage23=interleaved&theme=light`): formal title 两张色样. Continued draft 两张色样（校样）. In 故事编辑, moved a photo across the italic quote and past the other photo. Heading stayed `<strong>两种颜色</strong>` and quote stayed `<em>光线改变了纸上的颜色。</em>`. Protected 速记 and back via 进入故事编辑. 预览草稿 showed the new cover / in-story order (orange then heading/quote/orange/mint as applicable). 返回编辑 kept selection/scroll. Formal reading before publishing still showed the original order.
6. **PASS.** Shared (`?stage23=shared&theme=light`): read 色样甲, edit mint. 替换照片 + cancel in the file chooser: mint, caption 甲册的薄荷, and cover unchanged. First actual replacement opened 照片替换失败 (MEDIA_STATE_WRITE_FAILED). 取消 left the same photo, position, caption and cover. Refresh of this RAM fixture, fail again, then 重试: thumbnail changed to the teal stripe; position, caption and cover stayed fixed. Notice “照片已替换，请核对这张照片的说明。” and focus on 照片说明. Undo restored the mint illustration (srcLen ~14750); redo restored the stripe (~1374).
7. **PASS.** Published 色样甲 and reopened from the timeline: orange cover, stripe in-story with caption 甲册的薄荷. 色样乙 kept the original mint illustration and independent caption 乙册独立说明. Search for that caption: 已显示 1 / 1, 色样乙; 阅读全文 opened it. Museum 照片展墙 order: stripe, orange (11-21), mint (11-14). Photo view opened 照片 1 / 甲册的薄荷 / 色样甲.
8. **PASS.** Fresh Simple: removed the orange cover. Announcement “已移除封面，第一张剩余照片已成为封面。” Mint became 封面 ✓. Undo restored orange as cover. Fresh Shared: removed 色样乙’s only photo. Announcement “已移除最后一张照片，封面已清除。” 存入时光 refused EMPTY_CONTENT (“还需要调整一下 / 缺少正文或照片，无法存入时光（仅标题不能提交）”). 色样甲 still showed the original mint illustration.

---

## 360×800 lamplit dark — items 1–8

Actual viewport: **360×800**, DPR **2**. Same fixtures with `theme=dark`.

Behaviors matched the 360 light cell. Woven dark surface, gold accents, photos kept original (untinted) colors, text contrast readable, labelled controls, no bad horizontal overflow.

1. **PASS.** Empty and timeline; open mint in reading; 返回.
2. **PASS.** Simple 速记: orange is cover; 上移 / 下移, end buttons, undo / redo, 继续草稿 reopen with saved order.
3. **PASS.** Touch hold ≥350 ms drop and one undo restored pre-drop order. Desktop mouse drag did not arm under touch emulation (same 360 caveat).
4. **PASS.** Early lift, Escape, outside release: starting order/captions/cover/thumbs; indication cleared; handle focus at starting scroll.
5. **PASS.** Formal 两张色样; continue 两张色样（校样）; moves across quote; formatting kept; protected 速记; 预览草稿 new order; formal still original.
6. **PASS.** Chooser cancel unchanged; fail + 取消 unchanged; refresh + fail + 重试 stripe; notice and 照片说明 focus; undo mint / redo stripe.
7. **PASS.** Published 甲 (orange cover, stripe in-story); 乙 original mint + 乙册独立说明; search 1/1; museum stripe / orange / mint.
8. **PASS.** Simple remove orange cover + announcement + new first-photo cover + undo. Shared: 乙 only photo removed, cleared-cover announcement, cannot publish, 甲 mint original.

---

## 390×844 light paper — items 1–8

Actual viewport: **390×844**, DPR **2**. No toolbar/CSS mismatch.

1. **PASS.** Empty and timeline (`?stage01=empty|timeline&theme=light`). Empty state; opened a timeline photo in reading and 返回. Original photo colors, readable contrast on light paper, labelled controls, no bad horizontal overflow.
2. **PASS.** Simple: read 两张色样, edit, 速记, orange is cover (second). 上移 made orange first; 下移 returned it; end buttons disabled at ends; captions/cover/thumbs updated; focus on 拖动排序 at the end. Undo / redo. 继续草稿 dialog “这段时光已有修改草稿”; reopened draft kept orange-first saved order. Formal reading stayed original until publish.
3. **PASS.** Touch hold ≥350 ms on 拖动排序 (handle 1 scrolled into view), drop onto the partially visible first cell (`封面 ✓` at the top edge, destY ≈ 17.8): swapped to mint first / orange still 封面 ✓, notice “照片已移到第 1 张。” One undo restored the entire pre-drop order. Dispatched desktop `pointerType: 'mouse'` armed immediately. Scroll-edge destination = the partially visible first cell (continuous auto-scroll not separately shown on this 2-photo album).
4. **PASS.** Early lift: no `.dragging`. Escape during an active drag, and outside release: order/captions/cover/thumbs matched start; `.dragging` / drop-target cleared; 拖动排序 regained focus at startY = 447.95.
5. **PASS.** Formal 两张色样; continue draft 两张色样（校样）. 故事编辑: moved mint across the quote then past orange (“照片已移到第 4 块.”). `<strong>两种颜色</strong>` and `<em>光线改变了纸上的颜色。</em>` kept. Protected 速记, then 进入故事编辑. 预览草稿: heading 两张色样（校样）, cover orange, then heading/quote/orange/mint. 返回编辑: focus 拖动排序. Formal after still original (heading, mint, quote, orange).
6. **PASS.** Shared 色样甲 mint: chooser cancel left mint / 甲册的薄荷 / cover. First replace → 照片替换失败; 取消 unchanged. Refresh, fail, 重试: teal stripe thumb; position, caption and cover fixed; “照片已替换，请核对这张照片的说明。” and focus in 照片说明. Undo mint / redo stripe.
7. **PASS.** Published 甲: orange cover, stripe in-story with 甲册的薄荷; reopened from timeline. 乙: original mint + 乙册独立说明. Search 乙册独立说明: 1/1 色样乙, 阅读全文 opened it. Museum 照片展墙: stripe, orange (11-21), mint (11-14).
8. **PASS.** Fresh Simple: remove orange cover → “已移除封面，第一张剩余照片已成为封面。” mint 封面 ✓; undo restored. Fresh Shared: remove 乙’s only photo → “已移除最后一张照片，封面已清除。”; 存入时光 refused EMPTY_CONTENT; 甲 still had the original mint illustration.

---

## 390×844 lamplit dark — items 1–8

Actual viewport: **390×844**, DPR **2**. Same URLs with `theme=dark`. Woven dark surface, gold accents, photos kept original colors, readable contrast, labelled controls, no bad horizontal overflow.

1. **PASS.** Empty, timeline, open mint in reading, 返回.
2. **PASS.** Simple 速记: orange cover; 上移 orange first, focus 拖动排序; undo / redo; 继续草稿 reopen orange first.
3. **PASS.** Same as 390 light: touch hold ≥350 ms drop of mint onto the partially visible first cell; notice; one undo restored pre-drop order; dispatched mouse pointer armed immediately; startY 447.95.
4. **PASS.** Early lift, Escape, outside release: starting state; indication cleared; handle focus at startY 447.95.
5. **PASS.** Formal 两张色样 + strong/em original order. Continue 两张色样（校样）. 下移 mint across quote then past orange, “照片已移到第 4 块。” Formatting kept; story order 橘色 then 薄荷. Protected 速记; 进入故事编辑. 预览草稿: 两张色样（校样）, cover orange, heading, quote, orange, mint. 返回编辑 focus 拖动排序. Formal after still original (heading, mint, quote, orange).
6. **PASS.** Chooser cancel: imgs mint srcLen 14750 + orange 12962, captions 甲册的薄荷 / 橘色色样, covers 设为封面 / 封面 ✓. First replace → 照片替换失败 (MEDIA_STATE_WRITE_FAILED); 取消 left the same state. Refresh fixture, fail, 重试: mint srcLen 1374 (stripe), caption and cover unchanged. Notice “照片已替换，请核对这张照片的说明.” Status + gold focus ring on the first 照片说明. Undo → srcLen 14750 mint illustration; redo → 1374 stripe.
7. **PASS.** 存入时光 色样甲: orange cover, stripe in-story with 甲册的薄荷; reopened from the timeline with the same final order. 色样乙: original mint plant illustration + 乙册独立说明. Search 乙册独立说明: 已显示 1 / 1 段时光, 色样乙, 图片说明 highlighted; button 阅读：色样乙 opened the record. Museum 照片展墙 (发生日期：从近到远): stripe 11-21, orange 11-21, mint 11-14. Photo view: 照片 1, 甲册的薄荷, 色样甲, 进入完整故事.
8. **PASS.** Fresh Simple: remove orange cover; announcement “已移除封面，第一张剩余照片已成为封面.”; remaining mint is 封面 ✓; undo restored orange 封面 ✓ and both photos. Fresh Shared: remove 乙’s only photo; announcement “已移除最后一张照片，封面已清除.”; photo area “还没有照片，可以附上几张.”; 存入时光 refused “还需要调整一下 / 缺少正文或照片，无法存入时光（仅标题不能提交）”. Formal 色样甲 still showed the original mint plant illustration (甲册的薄荷) plus orange cover. (Leftover 乙 error/remove banners were still visible on 甲; not a product failure.)

---

## Native coverage (all cells)

| Topic | Result |
| --- | --- |
| Android-native touch and scrolling | NOT_RUN |
| IME and keyboard avoidance | NOT_RUN |
| TalkBack | NOT_RUN |
| Native picker | NOT_RUN |
| Native Back | NOT_RUN |
| Real-device restart and upgrade retention | NOT_RUN |

---

## Screenshot paths

All files live under `/workspace/shiguang-app/evidence/mobile-stage23/t5-photos/manual/`.

### 360×800 light paper
- `360x800-light-empty-devtools.webp`
- `360x800-light-empty.png`
- `360x800-light-timeline.png`
- `360x800-light-reading.png`
- `360x800-light-simple-reading.png`
- `360x800-light-simple-edit.png`
- `360x800-light-simple-edit-orange-cover-end.png`
- `360x800-light-simple-edit-order-after-up.png`
- `360x800-light-simple-reopen-order.png`
- `360x800-light-simple-drag-active.png`
- `360x800-light-simple-order-restored.png`
- `360x800-light-interleaved-formal-reading.png`
- `360x800-light-interleaved-story-edit-before.png`
- `360x800-light-interleaved-story-after-moves.png`
- `360x800-light-interleaved-protected-quick.png`
- `360x800-light-interleaved-draft-preview.png`
- `360x800-light-interleaved-formal-after-draft.png`
- `360x800-light-shared-jia-reading.png`
- `360x800-light-shared-replace-failed.png`
- `360x800-light-shared-replace-success-notice.png`
- `360x800-light-shared-replace-success-thumb.png`
- `360x800-light-shared-replace-undo-mint.png`
- `360x800-light-shared-replace-redo-stripe.png`
- `360x800-light-shared-jia-published.png`
- `360x800-light-shared-jia-published-instory.png`
- `360x800-light-shared-yi-mint-caption.png`
- `360x800-light-shared-search-query.png`
- `360x800-light-shared-search-yi-caption.png`
- `360x800-light-museum-wall-preview.png`
- `360x800-light-museum-photo-view.png`
- `360x800-light-simple-remove-cover.png`
- `360x800-light-simple-remove-cover-undo.png`
- `360x800-light-shared-yi-photo-removed.png`
- `360x800-light-shared-yi-cannot-publish.png`
- `360x800-light-shared-jia-mint-after-yi-remove.png`

### 360×800 lamplit dark
- `360x800-dark-empty.png`
- `360x800-dark-timeline.png`
- `360x800-dark-reading.png`
- `360x800-dark-simple-reading.png`
- `360x800-dark-simple-edit-order.png`
- `360x800-dark-simple-drag-active.png`
- `360x800-dark-simple-drag-drop.png`
- `360x800-dark-interleaved-formal.png`
- `360x800-dark-interleaved-draft-preview.png`
- `360x800-dark-shared-replace-failed.png`
- `360x800-dark-shared-replace-success.png`
- `360x800-dark-shared-replace-undo.png`
- `360x800-dark-shared-replace-redo.png`
- `360x800-dark-shared-jia-published.png`
- `360x800-dark-shared-yi-reading.png`
- `360x800-dark-shared-search-yi.png`
- `360x800-dark-museum-wall-preview.png`
- `360x800-dark-museum-photo-view.png`
- `360x800-dark-simple-remove-cover.png`
- `360x800-dark-shared-yi-cannot-publish.png`
- `360x800-dark-shared-jia-mint-after-yi-remove.png`

### 390×844 light paper
- `390x844-light-devtools-toolbar.webp`
- `390x844-light-empty.png`
- `390x844-light-timeline.png`
- `390x844-light-reading.png`
- `390x844-light-simple-timeline.png`
- `390x844-light-simple-reading.png`
- `390x844-light-simple-edit.png`
- `390x844-light-simple-edit-orange-cover-end.png`
- `390x844-light-simple-edit-order-after-up.png`
- `390x844-light-simple-edit-order-after-down.png`
- `390x844-light-simple-undo.png`
- `390x844-light-simple-redo.png`
- `390x844-light-simple-reopen-dialog.png`
- `390x844-light-simple-reopen-order.png`
- `390x844-light-simple-drag-cancel-escape.png`
- `390x844-light-simple-drag-active.png`
- `390x844-light-simple-drag-drop.png`
- `390x844-light-interleaved-timeline.png`
- `390x844-light-interleaved-formal-reading.png`
- `390x844-light-interleaved-story-edit-top.png`
- `390x844-light-interleaved-story-edit-before.png`
- `390x844-light-interleaved-story-after-moves.png`
- `390x844-light-interleaved-protected-quick.png`
- `390x844-light-interleaved-draft-preview.png`
- `390x844-light-interleaved-formal-after-draft.png`
- `390x844-light-shared-timeline.png`
- `390x844-light-shared-jia-reading.png`
- `390x844-light-shared-jia-edit.png`
- `390x844-light-shared-replace-failed.png`
- `390x844-light-shared-replace-cancel-unchanged.png`
- `390x844-light-shared-replace-success-notice.png`
- `390x844-light-shared-replace-undo-mint.png`
- `390x844-light-shared-replace-redo-stripe.png`
- `390x844-light-shared-jia-published.png`
- `390x844-light-shared-jia-published-instory.png`
- `390x844-light-shared-jia-reopened.png`
- `390x844-light-shared-yi-mint-caption.png`
- `390x844-light-shared-search-query.png`
- `390x844-light-shared-search-yi-caption.png`
- `390x844-light-museum-wall-preview.png`
- `390x844-light-museum-photo-view.png`
- `390x844-light-simple-remove-confirm.png`
- `390x844-light-simple-remove-cover.png`
- `390x844-light-simple-remove-cover-undo.png`
- `390x844-light-shared-yi-photo-removed.png`
- `390x844-light-shared-yi-cannot-publish.png`
- `390x844-light-shared-jia-mint-after-yi-remove.png`

### 390×844 lamplit dark
- `390x844-dark-empty.png`
- `390x844-dark-timeline.png`
- `390x844-dark-reading.png`
- `390x844-dark-simple-reading-timeline.png`
- `390x844-dark-simple-reading.png`
- `390x844-dark-simple-edit-order.png`
- `390x844-dark-simple-edit-order-after-up.png`
- `390x844-dark-simple-drag-cancel-escape.png`
- `390x844-dark-simple-drag-active.png`
- `390x844-dark-simple-drag-drop.png`
- `390x844-dark-interleaved-formal-reading.png`
- `390x844-dark-interleaved-story-edit-before.png`
- `390x844-dark-interleaved-story-after-moves.png`
- `390x844-dark-interleaved-protected-quick.png`
- `390x844-dark-interleaved-draft-preview.png`
- `390x844-dark-interleaved-formal-after-draft.png`
- `390x844-dark-shared-timeline.png`
- `390x844-dark-shared-jia-reading.png`
- `390x844-dark-shared-replace-failed.png`
- `390x844-dark-shared-replace-success.png`
- `390x844-dark-shared-replace-undo.png`
- `390x844-dark-shared-replace-redo.png`
- `390x844-dark-shared-replace-redo-stripe.png`
- `390x844-dark-shared-jia-published.png`
- `390x844-dark-shared-jia-published-instory.png`
- `390x844-dark-shared-jia-reopened.png`
- `390x844-dark-shared-yi-mint-caption.png`
- `390x844-dark-shared-search-query.png`
- `390x844-dark-shared-search-yi-caption.png`
- `390x844-dark-shared-search-yi-opened.png`
- `390x844-dark-museum-wall-preview.png`
- `390x844-dark-museum-photo-view.png`
- `390x844-dark-simple-remove-confirm.png`
- `390x844-dark-simple-remove-cover.png`
- `390x844-dark-simple-remove-cover-undo.png`
- `390x844-dark-shared-yi-cannot-publish.png`
- `390x844-dark-shared-jia-after-yi-remove.png`
- `390x844-dark-shared-jia-mint-after-yi-remove.png`

Note: the 390×844 dark item-8 “乙 photo removed” announcement was recorded in the page text; the dedicated empty-photos screenshot is `390x844-dark-shared-yi-cannot-publish.png` (the announcement may be off-screen in that frame). Chooser-cancel unchanged state at 390 dark was recorded in structured observations (mint srcLen 14750, captions and cover unchanged); there is no separate `replace-cancel-unchanged` PNG in that cell.
