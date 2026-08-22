---
"@riesbri/dsh-tui": patch
---

Count what the suggestion list is actually hiding, and bound it to the screen.

The `… N more` row reported `candidates.length - shown.length`, which is the same
number at every scroll position: fifteen commands showed `… 9 more` with the first
highlighted and still `… 9 more` with the last. It now counts the rows below the
window, so it reaches zero at the bottom, and the help line carries the position
(`10/15`) so the rows scrolled off above are accounted for without a second marker.

The list also ignored the terminal height the slot contract passes it, so on a short
terminal it pushed the composer out of the live region — where `Screen` can no longer
erase it, and the next redraw left a duplicate frame in scrollback. It now takes at
most the rows the screen has room for.
