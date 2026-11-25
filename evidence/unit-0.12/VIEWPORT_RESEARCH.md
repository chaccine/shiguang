# Bounded read-only viewport research — 2026-11-25 UTC+8

Loaded and followed unblock-research in full; also read recent-changes, box-desktop and X guide. No browser action, DevTools/CDP access, Playwright, screenshot resizing, account/auth change, installation, deployment or newly invented target URL was performed.

## Budget used
- Three lookups/searches total (conservatively including memory): RecallMemory; one WebSearch including “Grok Bot” and 2026; one public X search including “Grok Bot” / “@bot”. No pagination or extra searches.
- Two public page reads. Tool-schema inspection and installed skill reads were read-only capability checks.

## Findings
1. Recent-changes lists no relevant viewport feature update. Memory gave no proven method. Current executor tool discovery exposes no viewport/resize control; parent computerUse may have different UI abilities, not proven here.
2. Web search surfaced community recommendations for Playwright device contexts. They are explicitly disallowed by current box-desktop instructions and owner constraints; NOT used or recommended for execution here. The fetched community GitHub page returned no actual source text, so its search snippet cannot establish a supported current capability.
   Source: https://github.com/yanqingcheng/grokbot-actually-good-qa-tester/blob/main/skills/machine-setup/references/grok-bot-box.md
3. Public X query `("Grok Bot" OR "@bot") (viewport OR "device mode" OR "mobile testing" OR "responsive mode") -is:retweet` returned no sufficiently specific, verified Grok Bot method. Irrelevant posts are not treated as instructions or evidence.
4. Verified official Chrome documentation describes a legitimate **manual GUI-only** option: DevTools Device Toolbar → Responsive → explicit CSS width/height, optional explicit DPR and Mobile/Touch type. This changes the emulated viewport, unlike image resizing or page zoom. Official page also warns it is an approximation, not native phone execution.
   Verified source: https://developer.chrome.com/docs/devtools/device-mode

## Safe proposal to parent (NOT executed)
If the parent's existing computerUse can access the actual Chrome DevTools UI (not merely the managed page surface), it may use the documented Device Toolbar controls to set 390×844 and 360px width, record visible width/height/DPR/device type, and capture the toolbar together with application evidence. Use the existing verified localhost preview URLs from BROWSER_CHECKLIST; do not invent an alternate browser/debug endpoint. No console JS, CDP, Shell browser automation or scaled-image substitution.

This method is officially documented for Chrome, but **availability in this managed browser/computerUse surface remains unverified**. If the UI is absent/blocked, stop that attempt; preserve phone viewport NOT_RUN rather than bypass via protocols or claim native acceptance. Do not repeat attempts indefinitely. Real Android install/IME/performance still NOT_RUN even if responsive emulation succeeds.

No confirmed Grok Bot-specific viewport API was found within this bound; no method has been saved as “worked”. Research is complete, not a reason to delay PR10 delivery.
