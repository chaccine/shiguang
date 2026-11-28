# BROWSER_CHECKLIST — parent walkthrough

**Status — NOT_RUN.** Use a fresh RAM fixture for each pass. Refresh resets that fixture, including edits, appearance and its one-shot failure. In `/workspace/shiguang-app`, run `npm run preview`. Open the links below. The server binds to 127.0.0.1 on port 1420.

| RAM fixture | Light paper | Lamplit dark |
| --- | --- | --- |
| Empty library | [Empty · light](http://127.0.0.1:1420/?stage01=empty&theme=light) | [Empty · dark](http://127.0.0.1:1420/?stage01=empty&theme=dark) |
| Populated timeline | [Timeline · light](http://127.0.0.1:1420/?stage01=timeline&theme=light) | [Timeline · dark](http://127.0.0.1:1420/?stage01=timeline&theme=dark) |
| Legacy simple album, second photo is cover | [Simple · light](http://127.0.0.1:1420/?stage23=simple&theme=light) | [Simple · dark](http://127.0.0.1:1420/?stage23=simple&theme=dark) |
| Marked story, pending modification draft | [Interleaved · light](http://127.0.0.1:1420/?stage23=interleaved&theme=light) | [Interleaved · dark](http://127.0.0.1:1420/?stage23=interleaved&theme=dark) |
| Two albums share the mint original | [Shared · light](http://127.0.0.1:1420/?stage23=shared&theme=light) | [Shared · dark](http://127.0.0.1:1420/?stage23=shared&theme=dark) |

Use only the synthetic PNGs from `core/tests/fixtures/v5/media/` for file selections. Either PNG looks different from the fixture's mint and orange illustrations.

| CSS viewport | Theme | Parent observation |
| --- | --- | --- |
| 360 × 800 | Light paper | NOT_RUN |
| 360 × 800 | Lamplit dark | NOT_RUN |
| 390 × 844 | Light paper | NOT_RUN |
| 390 × 844 | Lamplit dark | NOT_RUN |

Repeat the following at each viewport and theme. Record the actual viewport, fixture URL, control, expected and observed result. Record focus and scroll around each move or cancellation.

1. Open **Empty** and **Timeline**. Check the empty state, open a timeline photo in reading, then return. Check photo color, text contrast, labelled controls and horizontal overflow.
2. Open **Simple**, read 两张色样, then edit. In 速记, check that the second (orange) photo is the cover. Move it up and down with 上移 and 下移. Check the end buttons, captions, cover, thumbnails and focus after each move. Undo and redo. Reopen the draft in the same tab to check saved order.
3. On **Simple** or **Interleaved**, drag from 拖动排序. With touch emulation, hold the handle for at least 350 ms, move onto a different cell or story block and release. With a desktop pointer, press and drag directly. Try a destination reached by holding near the scroll edge. Check the same result as the equivalent button moves. Check one undo restores the entire pre-drop order.
4. Repeat a drag but lift before the hold activates, press Escape during an active drag, or release outside any target. Check the order, captions, cover and thumbnails against the starting state. Check that the active drag indication clears and the handle regains focus at the starting scroll position.
5. Open **Interleaved**. The formal title is 两张色样. Edit and continue the existing draft 两张色样（校样）. In 故事编辑, move a photo across the italic quote and past the other photo. Check that the bold heading and quote retain their formatting. Switch to protected 速记 and back through 进入故事编辑. Open 预览草稿, verify the cover and in-story order, then use Back or 返回编辑. Check selection and scroll. Return to formal reading before publishing and compare with the original order.
6. Open **Shared**, read 色样甲 and edit its mint photo. First open 替换照片 and cancel in the file chooser. Verify the old photo, caption and cover. Choose a synthetic PNG. The first actual replacement opens 照片替换失败. Choose 取消 and check the same photo, position, caption and cover. Refresh this RAM fixture and repeat the failed replacement, then choose 重试. Check that the thumbnail changes while its position, caption and cover stay fixed. Check the caption-review message and focus in 照片说明. Undo and redo and compare the images at each step.
7. Publish 色样甲 and reopen it from the timeline. Confirm the final order, cover and caption. Open 色样乙 and check the original mint illustration and its independent caption 乙册独立说明. Search for that caption and open the matching record. Check the published photo order in the museum photo view.
8. In a fresh **Simple** edit, remove the orange cover. Check the announcement, the new first-photo cover and undo. In **Shared**, remove 色样乙’s only photo. Check the cleared-cover announcement and that its photo-only draft cannot publish. Return to 色样甲 and verify its shared mint original.

**Native coverage** — Android-native touch and scrolling, IME and keyboard avoidance, TalkBack, native picker, native Back, real-device restart and upgrade retention are all **NOT_RUN**. The parent browser walkthrough has its own result column above.
