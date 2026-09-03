# Provider acceptance

A provider is accepted by dshline when Harness can expose its ordinary capability
contracts and the existing terminal presentation shows them unchanged.

> **Harness owns capabilities; dshline owns terminal presentation.**

This is not a provider-integration guide. dshline neither starts a provider
runtime nor maintains provider configuration, state, permissions, or output
parsers.

## Codex acceptance: manually proven

A real `@deepseek-ai/dsh-subagent-codex` provider ran through Harness. The
existing generic `/work` UI observed the active provider through
`ctx.subagents` and its background task through `ctx.jobs`; both disappeared
from Work after completion. The delegated run then performed real repository
work that became [PR #54](https://github.com/riesbri/dshline/pull/54), so this
was more than a synthetic lifecycle test.

[PR #53](https://github.com/riesbri/dshline/pull/53) also adds the opt-in
`pnpm test:codex` acceptance fixture. It composes the real provider with
Harness and verifies the provider-neutral subagent lifecycle in the existing
Work projection and overlay. Neither acceptance added Codex-specific dshline
production code, configuration, or a `/work` branch.

## Two different things called "Codex"

Codex reaches a dshline session through two unrelated Harness seams, and `/work`
shows different amounts about each. The difference is architecturally
important, so it is named here rather than left to be rediscovered.

**Codex as a subagent backend.** `@deepseek-ai/dsh-subagent-codex` starts an
external native Codex child over its own product protocol. It publishes the
generic subagent lifecycle and, today, no local Harness `Agent`, so its
internals stay provider-managed:

```
dsh-subagent-codex
        → generic ctx.subagents lifecycle
        → remote/provider-managed detail in /work
```

**Codex as an ordinary Harness LLM route.** A parent Agent can instead run on a
registered route such as `openai-codex/<model>` and delegate through the
ordinary Harness `subagent` tool, whose standard path is the generic `spawn`
backend. The child is then a real in-process Harness Agent with Harness tools
and a Harness Session:

```
openai-codex model route
        → ordinary spawn child
        → local Harness Agent
        → generic /work semantic activity + the child's actual route
```

That second path is what `/work` can say the most about, and it needs no Codex
knowledge at all. The row's backend is `spawn`, its model is whatever the
child's own `request/header` envelope recorded, and its activity is folded from
the child's own session events and tool presentations:

```
Codex intelligence
+ Harness Agent/runtime/tools
+ dshline observability
```

with zero Codex-specific dshline production code. Substituting any other
registered provider route changes nothing in dshline.

### Configuration boundary

Installing a provider makes it available to Harness. Making it available to an
Agent is a separate permission and tool-binding decision made through generic
Harness mechanisms. The temporary YAML used for the manual acceptance was test
profile configuration, not a desired dshline provider-integration workflow.

dshline must not maintain Codex-, Claude-, or provider-specific configuration,
and this document does not prescribe how a Harness deployment grants an Agent
provider access.

## Next acceptance target: Claude Code

`@deepseek-ai/dsh-subagent-claude-code` is the logical next target: installed
and configured in Harness, it should publish through `ctx.subagents` and
`ctx.jobs` for the same generic `/work` presentation. Claude Code has **not**
been manually validated in dshline yet.

The acceptance criterion for Claude Code and every future provider is:

```
provider installed/configured in Harness
        → standard Harness capability contracts
        → generic /work
        → zero provider-specific dshline production code
```

## Observation limit

`/work` presents lifecycle and job state that Harness publishes. It does not
see provider reasoning, commands, tool activity, progress, or diffs. Those
facts can become terminal presentation input only if Harness exposes them
through a generic capability contract; dshline must not scrape provider output.

This is visible in the cockpit rather than explained away by it. A subagent run
whose provider publishes an in-process child Agent — `spawn`, today — folds that
child's own session events into a semantic activity word and an animated mark,
reads its effective model route from the child's own logged request envelope,
and reads its active time from the `subagentTiming` session projection, because
Harness genuinely publishes all of those facts through generic seams. It also
reads a token total from the `tokenUsage` projection, but only for a child
whose Session has no fork-inherited history: that projection folds the complete
log and, unlike `subagentTiming`, does not reset at the child's descriptor, so
for a seeded child the figure includes usage the child did not spend and is
omitted rather than mislabelled. A run from a provider that manages its own
model and tool traffic out of process — Codex, and Claude Code when it is
validated — shows a static lifecycle mark, its elapsed time, and
`activity  provider-managed`, and no more: no model row, no token figure, no
active-time claim. Both live in the same list under the same rules; the
difference is what the seam carries, not which provider dshline recognizes.
Should a provider contract later expose intermediate activity generically, those
runs gain it with no dshline change naming them.

The asymmetry is deliberate, and it is not a gap to be closed by inference.
dshline must never read a provider's configuration or auth state, parse its
output, infer a model from package configuration, or infer activity from
process names to make a provider-managed row look richer than the seam
allows.
