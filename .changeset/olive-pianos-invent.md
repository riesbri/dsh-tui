---
"@dshline/dshline": minor
"@dshline/renderer": minor
---

Add `/theme`, with five shipped palettes.

`default` is unchanged. `high-contrast` avoids the dim attribute and bright black entirely, both of which the default palette leans on and both of which are the first thing to vanish on a washed-out display. `ember` and `tide` are warm and cool palettes for a dark terminal, and `paper` is for a light one.

The last three are authored in 24-bit colour and each declares its own sixteen-colour fallback per role, so a terminal that cannot show one gets a reviewed decision rather than a nearest-colour approximation — and `/theme` names the fallback it used instead of degrading silently.

A theme reaches new rows only: committed scrollback is never rewritten, so rows above the live region keep the colours they were printed with. Applying one is confirmed by a single line drawn in the new palette, and the live region redraws with it.

The palette is a window preference, like the usage meter and the tool detail level — it survives reopening a session. User-authored palettes are not supported yet.
