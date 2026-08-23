---
"@dshline/dshline": minor
---

Add `/plugins`: a terminal browser for the running agent's Harness preset composition — search, toggle a row, create a customizable copy of a built-in preset, switch a blank session's preset live, and set the default for new sessions.

Adopting this required moving the agent plane behind Harness's own agent-presets architecture, the same step deepseek-harness's own Web bundle already took: `dsh-base`'s model-facing tool rows (`tool-bash`, `tool-fs`, `tool-subagent`, `tool-workflow`, and the rest of the per-agent rows a preset also lists) are now disabled in `cordis.patch.yml` and mounted through a preset instead, defaulting to `standard`. A fresh session composes from the roster's default; a resumed one composes from whatever preset its own session log recorded, never today's default. A profile that mounts no `agentPresets` seam at all — or deliberately removes it — is unaffected: `/plugins` reports it is unavailable, and every agent keeps the flat, process-wide composition this frontend had before.
