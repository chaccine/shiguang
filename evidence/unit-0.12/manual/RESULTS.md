# Parent computerUse results — PARTIAL

Source: parent-reported browser acceptance, 2026-11-25 18:46 UTC+8; executor did not operate the browser. RESULTS.md had not been present when the executor checked; this record transcribes the parent-provided findings without inventing extra checks.

## Observed PASS (actual wide viewport only)
- Light mixed results.
- Dark combined filters: 2/2 matches.
- Script-looking text remains literal with safe highlighting.
- Reading/back preserves context.
- Favorite toggle reflected in museum cabinet.
- Paging: 24/31 to 31/31.
- No-result state and empty store.

## Scope limits / NOT_RUN
- Actual reported browser viewport **1920×1072**, DPR unknown. PNG pixel dimensions are recorded separately and cannot establish CSS viewport or DPR.
- Could not set phone viewport. **390×844 and 360px narrow phone layout/touch/keyboard/IME/system scaling NOT_RUN**.
- Native Android installation, native IPC and real-device performance NOT_RUN.
- These captures are wide-viewport functional observations, **not phone screenshots** and **not full desktop-specific acceptance** (desktop specialization DEFERRED).
- favicon.ico returned 404, non-blocking; no fix requested.

## Actual captures
- m05-actual-1920x1072-light-mixed.png
- m05-actual-1920x1072-dark-combined.png
- m05-actual-1920x1072-empty-light.png

See ARTIFACTS.json for file hashes and pixel dimensions; no image was resized or passed off as a different viewport.
