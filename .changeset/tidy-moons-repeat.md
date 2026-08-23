---
"dshline": minor
---

Make every truncated tool result reachable, and keep the end of a command's output.

`ctrl-o` armed an inspector only for a truncated **compact** card, so a `full` card
that hit its own row cap printed `… 3 more lines` with nothing able to open it. The
inspector now has its own, far larger row budget — its rows live in the windowed live
region, where a card's are committed into scrollback permanently — so it has more to
show than any card did, and every truncated card arms it and says so.

Command output is now elided from the TOP rather than the bottom. What `pnpm test` was
run to find out is the failure and the summary at the end; keeping the first six rows
kept the banner and threw away the answer. File reads, searches, and diffs are
unchanged: their first rows are what was asked for.

The status line also lists `ctrl-o output` while a turn is running. A truncated card
arms a one-shot opportunity that the next result takes away, so a turn is exactly when
that keystroke needs advertising — and it was the one moment the hint was missing.

Every presentation resolves its budget through one function, so a diff and a search
are inspected at the inspector's budget too rather than keeping the card's cap. The
inspector renders once per width instead of once per keystroke: the inspected result
is a completed log entry, so scrolling a thousand-row body no longer re-runs the
presenter on every arrow key.
