---
'@dshline/dshline': minor
---

Make `/work` say what each Harness worker is actually doing, and which LLM is powering it.

A subagent row used to lead with its `ctx.subagents` backend — `spawn` first, the task label after it, the activity word almost last — because the backend was once the only identity Harness exposed. That order is now inverted: the child's durable task label leads and never yields, the semantic activity word and its operation target come next, and a narrowing terminal gives up the clock first, then the route, then the target, then the word, always as whole facts. The backend takes overview space only for a child whose work is not observable, where it is the fact that explains the silence.

A live in-process child now reports the LLM route its requests actually use, read from `Session.requestHeader()` — the canonical fold of the child's own `request/header` snapshots — and falling back to the options it was created with only before its first request. A later route change is simply a later envelope, so a delegated model selection shows up without dshline tracking it. The two sources are never mixed field by field: a header that carries no reasoning effort has none. That is also why the detail stage now says `backend  spawn` and `model  openai-codex/…` in two rows instead of calling both of them `provider`; a `spawn` child can be powered by any registered route at all.

The detail stage also gains Harness's own telemetry for a local child: `active time` from the `subagentTiming` projection — completed turns plus an open one, advancing only while the child is genuinely running and freezing at the projection's bound when it is not — and a `tokens` total from the four disjoint `tokenUsage` buckets. Both come from the cheap `ctx.sessionProjections` snapshot, narrowed to those two keys; nothing calls `tokenMeter.measure()`, which prices the whole surface per call. A profile that registers neither unit shows neither fact, and the row keeps the weaker observed `elapsed` clock rather than claiming an active time it cannot prove. Only one clock is ever shown.

The two projections are not attributable on the same terms, so they are not presented on the same terms. `subagentTiming` resets at the child's own `subagent/descriptor`, which is what makes it child-relative; `tokenUsage` folds provider-reported usage over the complete log and has no such reset, so a fork-seeded child's figure includes the parent's completed turns it inherited. The token fact therefore appears only when `Session.inheritedEventCount` is zero — the generic Harness lineage cut, not a backend name and not a Work-local usage fold — and is omitted otherwise. A seeded child can still show `active time`.

Workflow members inherit all of it through the one join Work already made on Harness's published `childId`, so a member whose child is live says what that child is doing and which route executed it — never what the script's `meta.phases` declared it would use.

Provider-managed children degrade honestly and deliberately: a run with no in-process child Agent gets no model row, no token figure and no active-time claim, only its backend, its elapsed time and `activity  provider-managed`. Nothing reads a provider's configuration, auth state, or output to fill that in.
