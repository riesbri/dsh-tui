---
'@dshline/dshline': minor
'@dshline/renderer': minor
---

Make the Sessions browser a picker first and an inspector second.

The `/sessions` list was answering one question — which session — while drawing
every fact Harness could state about each row. An ordinary row is now a title
and a relative age. The only mark that stays on the right is `open`, for the
session the window is already driving, because that is the row reopening
refuses. Workspace, origin, availability, lineage, event count, parent, and
session id moved behind `→`, which discloses one session with its own facts and
its own actions (find in this session, lineage, and rename where it is valid).

That is also a cost change, not only a visual one. The bounded `listEvents()`
read behind an event count and a last-activity time used to be taken for the
selected row, so every arrow press loaded and surface-folded a whole session
log. It is now taken when the surface that presents those facts is opened.
Ordinary browsing is one `listSessions()` and one batched `readTitleSnapshots()`
observation, and nothing else.

Filters left the per-session action menu for `ctrl-f`. They narrow the corpus
rather than the row under the cursor, and offering them under one row's title
said otherwise. A ctrl gesture rather than a bare `f` because every printable
character in this browser is already search input; `ctrl-f` is new to the
renderer's key vocabulary, in both the legacy and the enhanced encodings.

The keyboard model is now: type to search, `tab` for contents, `ctrl-f` for
filters, `→` for details, `↵` to reopen. Session archival stays out: Harness
owns it in the Workspace domain, but `archiveSession()` is one-way with no
unarchive operation, and archive state is not a fact the session corpus
publishes — so dshline neither offers an irreversible hide nor hides sessions
out of the one surface that can still resume them.
