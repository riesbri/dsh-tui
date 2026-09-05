---
"@dshline/dshline": minor
---

Guide a fresh install from `dshline` to a working model, and close the gap between signing in and having one.

Three changes, all through Harness's own authorities:

- **The authorization seam is now composed.** At the adopted Harness generation no shipped bundle mounts `@deepseek-ai/dsh-authorization`, and `dsh-llm-pi-ai` scopes its sign-in flows to that seam's presence — so account sign-in was unavailable in every stock dshline profile and `/connect`'s Sign-ins section was permanently empty. This bundle's `cordis.patch.yml` now inserts the row, exactly as it already does for `session-stats`.
- **`/setup`**, which runs by itself on a launch that would otherwise reach the composer without a model it can send to — no registered route, no selection, a selection naming a route nothing registered, or a selected route whose credential Harness reports as absent (the stock first install, where a default model and its route both exist before any key does). Uncertainty never counts: a route naming no credential reference, or a store that cannot answer, leaves the launch alone. It commits a reading of the installation to scrollback — Node, dshline, the Harness generation compared against the one this build targets, the profile, what can configure a provider, and why there is no model — then hands off to `/connect` and, once connecting produces the missing route, straight into `/model`. It re-reads Harness each pass, stores no first-run state, and writes nothing you did not choose.
- **A successful sign-in now offers to activate the route it authenticates.** A credential record and a settings profile are separate writes, so signing in used to leave `/model` with nothing to offer and no explanation. `/connect` now says which route an account authenticates (for `llm-pi-ai`, which documents that correspondence itself), shows `signed in · <route> route not active`, and asks before activating — against a fresh reading, and never automatically.
