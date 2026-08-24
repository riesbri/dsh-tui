---
"@dshline/dshline": patch
---

Redraw the timing panel's bars as mid-height strokes (`━`) over a dim track (`─`) instead of full blocks whose remainder was left blank. Blank remainders hid where each row's scale ended, and stacked full-height blocks fused rows of near-equal length into one slab that obscured where one span's bar ended and the next began; the stroke keeps whitespace between rows however close their durations are.
