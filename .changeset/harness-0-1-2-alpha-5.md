---
'@dshline/dshline': minor
---

Adopt DeepSeek Harness `0.1.2-alpha.5`, and drop `0.1.1-rc.2`.

dshline supports one Harness architecture at a time and migrates onto the new
one rather than bridging both, so this release moves the adopted generation in
`HARNESS_TARGET` from `0.1.1-rc.2` to `0.1.2-alpha.5` and deletes what the old
one needed. Every `dsh-*` dependency, devDependency, and peerDependency is now
exactly `0.1.2-alpha.5`.

The `0.1.2` line removes the public `Session.events` array. Each read moved to
the narrowest native API rather than to a snapshot of the whole log: `/context`
resolves a node with `eventAt()` and still stops its backward `callId` search
as soon as every wanted tool call is answered, and `/work` reconstructs a
child's current activity by scanning back from the end of its log and stopping
at the fork-inherited prefix — so a subagent's row can no longer be coloured by
its parent's history, and attaching to a long-running child no longer costs
that child's whole log.

`/plugins` gives its duplicated preset orchestration back to Harness. Which
preset a session runs is Harness's own `agentPreset` Session projection, not a
reverse scan this frontend kept; switching one is `agentPresets.select()`,
which serializes selections per session, re-checks the authoritative
`turnBoundary` projection inside that switch, refuses a started session,
recomposes, and records the choice. dshline no longer checks the lock at the
write path or appends `agent-preset/selected` itself. The resume path reads the
same projection, so `/plugins` and a reopened session can no longer disagree
about what a session runs. Behaviour a reader sees is unchanged, including the
pre-preset session that still resumes under `standard`.

The `ask_user_question` answerer registers directly on the scoped
`user-questions/request` waterfall; the runtime detection that also supported
the older `registerProvider` shape is gone. The Host-plane
`subagent-model-selection-settings` row likewise loses its resolution probe and
mounts outright — the subpath it needs is published by the generation this
bundle now pins.
