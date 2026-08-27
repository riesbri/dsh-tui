---
'@dshline/dshline': patch
---

A resumed session now paints its composer and status line before the transcript replay finishes, so the window is visible — and a draft can be typed — during the replay instead of holding a blank live region with live key routing behind it. The status reports the replay instead of claiming `ready`, and an enter pressed during the replay keeps the draft and explains that nothing was sent, committed below the history instead of above it. `/plugins` and `/profiles` are imported on demand, so a launch that never opens either pays no module-evaluation cost for them.