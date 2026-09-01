---
'@dshline/dshline': minor
'@dshline/renderer': minor
---

`ctrl-z` undoes the last draft edit and `ctrl-y` redoes it, in both keyboard
formats. Consecutive typing joins into one undo step no matter how the terminal
delivered it, while a cursor move, a completion acceptance, or a deliberate
newline starts a fresh one. History keeps its own ownership: a recalled history
line or a submitted prompt is a new baseline, so `ctrl-z` never walks back
across history navigation or into a prompt that was already sent. Undo history
is bounded (fifty steps, with a character budget for very large drafts) and
lives only in the renderer — nothing is stored in Harness and nothing survives
a session.
