# Roadmap

This is an architectural roadmap, not a feature checklist. dsh-tui is a terminal
presentation layer inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
**Harness owns capabilities; dsh-tui owns terminal presentation.**

## Principles

- **Native terminal scrollback is an invariant.** Finished transcript rows are
  committed to the user's real terminal and are never virtualized, rewritten, or
  moved to an alternate screen. Temporary UI stays in the bounded live region.
- **Capabilities remain optional.** A profile without a service still starts;
  the related view is unavailable rather than becoming a boot failure.
- **Use generic Harness seams before product integrations.** `ctx.subagents`
  beats a Codex-specific connection, `ctx.jobs` beats parsing tool output,
  `ctx.tools` beats tool-name special cases, and `ctx.commands` beats a local
  copy of Harness commands.
- **No silent degradation.** Show the useful capability state Harness exposes;
  when a seam cannot answer a question, say less rather than guess from text.
- **The renderer stays Harness-independent.** It continues to know only about
  terminal text, widths, keys, boxes, and the append-plus-live-region screen.
- **An extension API comes later.** Internal adapters must first prove a stable
  shape across several capabilities before dsh-tui publishes a plugin SDK.

## Major areas

### 1. Harness Work

The first adapter is generic Work: background jobs from `ctx.jobs` and activity
from `ctx.subagents`, presented through a bounded `/work` overlay and a small
optional status summary.

- jobs
- subagents
- Codex acceptance through `ctx.subagents` / `ctx.jobs`
- Claude Code acceptance through the same generic seams

Codex and Claude Code are acceptance targets, not dsh-tui integrations. If a
provider-specific detail is absent from the generic Harness seam, the follow-up
is an upstream capability enrichment rather than a direct provider connection.

### 2. Sessions

Improve session discovery, resume, and session-oriented terminal presentation
only through Harness session services and projections.

### 3. Agent state

Present todos, goals, permissions, and plan state through their owning Harness
services, events, and projections. This includes deciding a global live-region
layout budget before persistent third-party rows are allowed.

### 4. Attachments

Turn terminal attachment gestures into real Harness attachment capabilities,
rather than treating a path completion as an attachment.

### 5. Eventual TUI extensibility

After multiple internal capability adapters have demonstrated stable lifecycle,
layout, and authority rules, design a public extension API. It is deliberately
not a pre-1.0 promise today.

## Explicit non-goals

- another agent runtime
- another job runtime
- provider-specific subagent engines
- replacing Harness persistence
- replacing native terminal scrollback
- cloning Claude Code or Codex feature-by-feature
