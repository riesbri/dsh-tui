---
"@dshline/dshline": patch
"@dshline/renderer": patch
---

Coalesce live-region repaints instead of drawing once per request: redraws asked for within the same event-loop turn — streamed deltas, capability feeds invalidating together, a resize storm — now share one compose-and-write at the turn's end, and `Screen.setLive` skips output entirely when the wrapped frame and cursor already match what is on screen. A 300-delta burst measured 90% fewer terminal bytes (325 KB → 32 KB) and an 88% shorter render path; a thousand redundant invalidations with unchanged content now write nothing. Pixels changed behind the screen's back — `ctrl-l`'s display clear (now exposed as the window's `clear`) and terminal resizes — mark the frame stale once and repaint synchronously through the same scheduler, so no commit can land against wiped or reflowed pixels. Input stays same-turn: the collapsed paint still lands before the next poll cycle begins.
