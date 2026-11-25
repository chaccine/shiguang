# Android-first timeline acceptance

**Status — NOT_RUN.** The parent owns the browser and device observations. Record the actual viewport, zoom or font setting, theme, result and any screenshot filename for each pass. The automated results are in [VISUAL.md](VISUAL.md).

## Local preview

From `/workspace/shiguang-app`, with the existing dependencies, run `PORT=1420 npm run preview`. Open one of the URLs below in the parent-controlled browser. Each URL loads the same built application and creates a fresh synthetic device in RAM. Refreshing starts the selected scenario again. Navigate within the page while checking edits or return positions.

| Initial state | URL |
|---|---|
| Light timeline | [Warm paper](http://127.0.0.1:1420/?stage01=timeline&theme=light) |
| Dark timeline | [灯下展馆](http://127.0.0.1:1420/?stage01=timeline&theme=dark) |
| Empty, light | [Empty paper](http://127.0.0.1:1420/?stage01=empty&theme=light) |
| Empty, dark | [Empty gallery](http://127.0.0.1:1420/?stage01=empty&theme=dark) |
| Active conditions, sheet open | [November cutoff and favorites](http://127.0.0.1:1420/?stage01=timeline&theme=dark&filters=active&panel=open) |
| Enabled lock | [Protected timeline](http://127.0.0.1:1420/?stage01=timeline&theme=dark&lock=enabled) |
| Slow enabled lock check | [Held settings reply](http://127.0.0.1:1420/?stage01=timeline&theme=dark&lock=slow) |
| First settings check fails | [Retry then unlock](http://127.0.0.1:1420/?stage01=timeline&theme=dark&lock=error) |

The default lock state is disabled. The three protected fixtures use the public synthetic code `0042`. The slow fixture holds its first settings reply for 2.4 seconds. The error fixture fails that reply once. Both use the existing preview verifier. The populated fixture has five formal samples, two months, two locally authored color illustrations and three text-only records. Three are marked 珍藏. Calendar “today” is 2026-11-25 on each synthetic device. The empty fixture has zero records, drafts, tags and media.

The verification used the real local server's HTTP request handler, the built files and these query strings in-process. A loopback bind was denied with `EPERM` in the implementation sandbox. Live browser serving and visual observations belong to this pass.

## Viewports and interaction

Run the light, dark and empty views at **360 × 800** and **390 × 844** CSS pixels. Repeat with 200% text using 我的 → 主题与外观 → 字体大小 → 200%. Also exercise browser text enlargement or the Android system font setting when available.

| Check | What to exercise and observe | Result |
|---|---|---|
| First screen | Identify 拾光, 查找 and 筛选 immediately. November 2026 leads directly into the large mint cover. Inspect the paper grain in light and the woven wall, local illumination and muted frame in dark. Inspect fine month/date rules and contrast on both backgrounds. | NOT_RUN |
| Photos and text | Compare the mint and orange illustrations between themes, then open each original in reading. Check the same leaf greens, terracotta pot and orange swatch. Inspect the edges for a veil or tint. Read both November 14 samples. Only the timed one has 09:15. The body-only entry has a readable date and no image slot. | NOT_RUN |
| Navigation | Read all five labels in order — 时光轴 / 日历 / ＋记录 / 博物馆 / 我的. Identify calendar bindings, museum pediment and columns, writing pencil and profile silhouette. Count one visible plus. Check the active tab and activate each tab using touch and keyboard. | NOT_RUN |
| Sheet | Tap 筛选. Focus lands on 完成. Tab and Shift+Tab through month, 回到最近, order, 只看珍藏 and tags. Open 管理标签, enter and cancel an unsubmitted name, then return to the sheet. Test 完成, Escape, an outside tap and browser Back separately. Each dismisses the top surface. Focus returns to 筛选 when the sheet closes. Scroll inside and check the background holds its place. | NOT_RUN |
| Individual conditions | Open the active-condition fixture. It shows three matches. With 只看珍藏 still on, choose October, change to 由远到近 and select both 色样 and 排印. One orange entry matches. Close the sheet. Remove 色样 for zero matches, the cutoff for one, 珍藏 for three, sort for the default order, then 排印 for all five. Check focus after each removal and verify the corresponding sheet control each time. Also try 回到最近 and 清除筛选 in the filtered empty state. | NOT_RUN |
| Read and return | Scroll to an October record. Tap its photo or text, edit, then use 返回阅读 with a pending draft. The formal text is intact. Repeat and explicitly 存入时光. Reading shows the update. 返回 restores the dated entry, filters, focus and scroll position. Repeat with browser Back from the editor and reader. Visit 日历, choose November 2026 and the 14th, read and return to that day and position. Switch between both tabs after scrolling each. | NOT_RUN |
| Per-record controls | From the same entry use the star, the more-actions disclosure, 标签 and 移到回收站. Verify the picker and the existing confirmation/cancel flow. Check the star's pressed state and that the text remains directly readable with the controls closed. | NOT_RUN |
| M05 and IME | Open 查找, compose 薄荷 with a Chinese IME, commit the candidate and submit. The mint entry matches. Open it, return and inspect the retained query and position. With the IME visible check the focused input, submit, dismiss, and focus rings. Repeat in 管理标签. | NOT_RUN |
| Reflow and safe areas | At both widths and 200%, inspect wrapped navigation labels, long text, date controls and chips. Reach the final record and actions above the navigation and gesture area. Check for page-wide horizontal panning or clipped focus rings. In a short viewport scroll the sheet and lock form to every control. Inspect the 44 CSS px minimum interactive targets. Repeat dismissal and reading with reduced motion enabled. | NOT_RUN |
| True empty | Visit each empty URL. Look for the single empty-state invitation and 写下第一段时光. Check the absence of sample dates, photos, timeline items and draft notices. Inspect 草稿箱, calendar counts and M05 results before creating anything. | NOT_RUN |

## Startup and device observations

| Condition | Expected observation | Result |
|---|---|---|
| Disabled | On reload, the initial cover contains only 拾光. The admitted route appears without a password prompt. Watch for a flash of photos, text, navigation or credential controls before the current status resolves. | NOT_RUN |
| Enabled | From the neutral cover proceed to the focused code field. Try one incorrect code, then 0042 including both leading zeros. Only successful verification reveals the timeline. Check button reachability with the numeric keyboard. | NOT_RUN |
| Slow | During the held reply inspect the full viewport and try Tab. Only the opaque 拾光 cover is available. The password prompt follows the reply. The shell, filters and content are inaccessible throughout verification. | NOT_RUN |
| Error | The initial error offers 重试 while content stays hidden. Retry opens the enabled prompt. Wrong credentials keep the cover in place. Correct credentials admit the populated fixture. | NOT_RUN |
| Background | With the protected fixture unlocked and the sheet open, background the page. Return before 60 seconds and inspect focus and the dismissed sheet. Repeat after at least 60 seconds, expecting the credential prompt. Record any transient content, stacked dialog or late verification behavior. | NOT_RUN |
| Android system chrome | On actual Android hardware inspect status icons, gesture or three-button navigation, cutout and IME insets. Exercise explicit light/dark and 跟随系统 during a system appearance change. Record OS, WebView version and navigation mode. Browser chrome supplies separate observations. | NOT_RUN |

## Orchestrator live handoff

The loopback service is now running outside the implementation sandbox at `http://127.0.0.1:1420/`; all eight exact URLs and required assets independently returned200 with matching built bytes. It is the static built app, not an installed Android APK. Save genuine screenshots and observations under `evidence/mobile-stage01/manual/`; report actual CSS viewport/DPR only if observed. If390/360 cannot be set through the approved GUI, retain those itemsNOT_RUN and label wider images with their real size. Do not crop, zoom or rescale screenshots to claim a phone viewport. Do not access ordinary user storage or private photos: use only these RAM-only synthetic fixture URLs.
