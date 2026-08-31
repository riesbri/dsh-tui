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
because Harness genuinely publishes those facts through the generic seam. A run
from a provider that manages its own model and tool traffic out of process —
Codex, and Claude Code when it is validated — shows a static lifecycle mark, its
elapsed time, and `activity  provider-managed`, and no more. Both live in the
same list under the same rules; the difference is what the seam carries, not
which provider dshline recognizes. Should a provider contract later expose
intermediate activity generically, those runs gain it with no dshline change
naming them.
