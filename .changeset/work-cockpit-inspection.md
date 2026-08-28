---
'@dshline/dshline': minor
---

`/work` grows a selected-row detail stage: `↵` inspects the curated
Harness-published facts of one job or subagent (provider/kind, mode, durable
session id, session residency, child presence, lineage, lifecycle run id,
owner) and `esc` returns to the list. The list action now reads `k interrupt`
to match the seam's interrupt semantics rather than a generic "stop".