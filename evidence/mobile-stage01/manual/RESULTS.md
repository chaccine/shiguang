# Stage 01 mobile UI — bounded manual pass

Run: 2026-11-25 evening (UTC+8). Only the local synthetic RAM fixtures were used. No service restart, source edit, deployment, install, user storage, or private photos. Device mode was set through Chrome DevTools Device Toolbar GUI; no JS, CDP, or Console automation.

## Viewport and evidence

- Responsive GUI dimensions were set to **390×844 CSS px** and **360×800 CSS px**. Page viewport readings matched those values on the empty fixture (390×844) and slow-lock fixture (360×800). A later read after changing the Device Toolbar back to 390×844 returned 390×800, so that last setting was inconsistent; treat the recorded target-specific captures as observed, but note this GUI/API mismatch. DPR was **not directly observable in the allowed GUI**, so it is not claimed here.
- Screenshots are genuine, uncropped captures. Files ending `-devtools.webp` are full desktop captures with the live Responsive dimensions visible; the PNGs are page-viewport captures at their stated pixel dimensions.
- No actual Android device was available: Android system chrome, IME, and native safe-area behavior remain NOT_RUN.

## Observed results

- **Light timeline, 390×844:** first record is the November 21 mint illustration, followed by November 14 entries; only the timed entry shows 09:15. Warm paper texture, readable text/photo, five bottom destinations in order (时光轴 / 日历 / ＋记录 / 博物馆 / 我的), and one visible plus. No horizontal overflow was apparent in the observed first screen.
- **Dark timeline, 390×844:** woven dark surface, muted mint frame/illustration, readable dates/body, same five destinations and one plus. No horizontal overflow apparent in the observed first screen.
- **Empty light, 390×844:** “这里还没有时光” and “写下第一段时光”; no sample timeline/photo/date appeared.
- **Filter:** sheet opened and closed with 完成; it exposed month, order, favorites, tags and management control. Individual filter combinations, focus cycling, Escape/outside/Back dismissal and scroll restoration were not exhaustively tested.
- **Search/read/return:** searching synthetic 薄荷 returned **1 / 1** mint entry. Opened its reader and returned; query chip and result scroll position were retained. No entry edits were made.
- **200% app text size:** selected via 我的 → 主题与外观 → 字体大小. Text grew and navigation labels wrapped; the large-type lock prompt remained readable and within the 360×800 viewport. No horizontal overflow was apparent in this sample. Navigation to another fixture reset the selector to 标准.
- **Lock enabled:** neutral code prompt shown without timeline content; synthetic code 0042 unlocked the fixture. A 9999 attempt was entered, but its rejection/error behavior was not conclusively observed.
- **Lock slow:** before the held settings reply resolved, accessibility content was only the opaque 拾光 cover; after it resolved the code prompt appeared, without timeline content exposed.
- **Lock error:** initial alert read “无法读取本机应用锁设置，请重试。”; retry opened the code prompt; 0042 then unlocked the populated fixture.

## Not run / incomplete

- DPR readout; actual Android system bars/IME; background-return and 60-second relock.
- Calendar-day navigation, museum/profile detail, 200% full-screen matrix, empty calendar/drafts/M05 checks, exhaustive filter conditions, IME composition, editor draft/save flows, per-record tag/trash actions, focus-ring and reduced-motion checks, and all 44px target audits.
- Wrong-code error state was not conclusively verified.

## Captures

- `light-responsive-390x844-devtools.webp`
- `dark-responsive-390x844-devtools.webp`
- `empty-light-390x844.png`
- `lock-enabled-cover-360x800-devtools.webp`
- `lock-enabled-unlocked-360x800-devtools.webp`
- `lock-error-before-retry-360x800-devtools.webp`
- `lock-slow-200pct-360x800.png`

## Archival limitation (orchestrator)

This is a bounded PARTIAL pass, not completion of the full checklist. The200% observation accepted for this archive is limited to larger text and navigation wrapping. The protected fixture was also legible at360×800, but fixture navigation resets its font selector: the filename `lock-slow-200pct-360x800.png` is not independent proof of a200% lock-layout pass. Filenames are retained verbatim and image bytes were not altered. No rejection of an incorrect passcode,60-second relock or native behavior is marked manually PASS.
