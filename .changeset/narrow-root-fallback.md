---
'@dshline/dshline': patch
---

Fix the root composer and status line so they never ask the terminal to draw a row wider than itself below the chrome floor (terminals narrower than 12 columns). Previously the shared root frame's 12-column presentation floor, and the status line's 10-column budget floor, could both exceed a narrower real terminal; `Screen` re-wrapped the overlong logical row into extra physical ones after the live region had already been budgeted in logical rows, which invalidated the live-region height assumptions. Below the floor, the composer now draws its own rows directly against the terminal's width with no frame, keeping an editable buffer and a valid cursor; the status line now bounds its budget to the real width and gives up entirely when there is no room at all. Widths at or above 12 columns are unchanged.
