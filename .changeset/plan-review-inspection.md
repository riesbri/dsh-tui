---
'@dshline/dshline': minor
---

The completed-plan review is now a decision surface first: it shows the plan's heading, the choices, and a bounded preview of the plan's start, and advertises `ctrl-o` only when there is more to read. `ctrl-o` opens the full plan as one continuous scrollable document — the same content Harness already sends in the review request, laid out like the tool-output inspector (`↑`/`↓` scroll, `home`/`end` jump, `ctrl-o`/`esc` back). Returning preserves the pending decision and never answers or cancels the review; only `esc`/`ctrl-c` on the review itself still dismisses it to speak.

`ctrl-o` inspection also now generically reaches a tool CALL's own `presentCall` content when that content is what got elided, not only a result's. `exit_plan_mode` is the case that surfaced this — it echoes the plan back as call-time content — but the fix is a property of `ToolCards`, not a special case for that tool name.
