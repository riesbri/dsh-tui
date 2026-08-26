---
'@dshline/dshline': minor
'@dshline/renderer': minor
---

Give dshline one coherent visual root: the composer and every temporary overlay now draw through a shared frame (`dshline` anchored on the left, the workspace or the view's identity on the right, navigation help integrated into the bottom border), so a browser reads as the composer expanded rather than as a detached modal. The spinner changes from ten Braille frames to six arc frames. The renderer gains a generic `frame()` primitive — left and right top-border labels, an integrated bottom-border footer, and divider rows — while the existing `box()` API stays unchanged. Overlay key ownership, Harness authority, and overlay/Composer state remain fully separate; only presentation is shared.