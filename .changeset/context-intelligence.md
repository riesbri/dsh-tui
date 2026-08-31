---
'@dshline/dshline': minor
---

`/context` inspects what the model is currently carrying: projected context
occupancy, the estimated system/tools/messages composition, and the largest
current context entries as a share of message context — each named from the
session log, with a bounded preview. `/compact` stays Harness-owned; `c` inside `/context` dispatches the
same registered command, and a compaction is now presented from its own durable
event, so an automatic one is reported too. Bare `/usage` becomes an inspector
over Harness's cumulative token buckets and dshline's cost estimate, while
`/usage cost|tokens|off` still sets the status display immediately. The status
line no longer runs the token meter's O(surface) measurement on every redraw.
