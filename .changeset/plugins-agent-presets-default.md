---
"@dshline/dshline": minor
---

Add `/plugins`: a terminal browser for the running agent's Harness preset composition — search, toggle a row, create a customizable copy of a built-in preset, switch a blank session's preset live, and set the default for new sessions.

Adopting this required moving the agent plane behind Harness's own agent-presets architecture, the same step deepseek-harness's own Web bundle already took: `dsh-base`'s model-facing tool rows (`tool-bash`, `tool-fs`, `tool-subagent`, `tool-workflow`, and the rest of the per-agent rows a preset also lists) are now disabled in `cordis.patch.yml` and mounted through a preset instead, defaulting to `standard`. A fresh session composes from the roster's default; a resumed one composes from whatever preset its own session log recorded, never today's default — and a session from before this bundle adopted presets, which recorded none, resumes under `standard` specifically rather than whatever the default happens to be today, so old history is never silently rebuilt under a different composition than it actually ran with. A deployment that ships no usable `standard` resumes such a session under its own default and reports the substitution in the transcript, rather than refusing to open its own history.

A profile that mounts no `agentPresets` seam at all leaves the new composition step a no-op — but that only recovers the old flat `dsh-base` tool set for a deployment that never applied this bundle's own agent-plane disable list to begin with. Removing the seam from an otherwise-stock dshline install leaves an agent with no tools at all; `/plugins` itself still degrades cleanly and reports the capability unavailable either way.
