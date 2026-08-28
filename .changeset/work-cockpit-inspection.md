---
'@dshline/dshline': minor
---

`/work` grows a selected-row detail stage: `↵` inspects the curated
Harness-published facts of one job or subagent (provider/kind, lifecycle,
live Agent status, semantic activity and operation, mode, durable session
id, session residency, child sessions, lineage, lifecycle run id, owner,
interrupt availability) and `esc` returns to the list. The list action reads
`k interrupt` to match the seam's interrupt semantics rather than a generic
"stop".

The overview now communicates live work: rows spin with the status line's
shared arc spinner only while Harness says the work is active (a Job in
`running`, a subagent whose in-process child Agent is running), and a live
child can show a semantic activity word plus the running tool's own
presentation title, folded from the same Harness session events and tool
presentation the status line uses. A run without an in-process child shows
no invented activity. Selection in the overlay is identity-based: settling
rows never move a human interrupt onto the item that inherited the old
screen position.
