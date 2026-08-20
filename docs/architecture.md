# Architecture

## Boundary

```
DeepSeek Harness
        ↓
capability seams
        ↓
optional dsh-tui adapters
        ↓
presentation projection
        ↓
TuiSlots / Screen
        ↓
native terminal
```

DeepSeek Harness owns capabilities and their authority. dsh-tui owns terminal
presentation. An adapter reads a narrow service seam, turns its structured
facts into a small presentation projection, and gives that projection to a slot
or a bounded live-region overlay.

The renderer package is below that boundary. It knows about display widths,
control escaping, keys, boxes, and `Screen`; it must not learn about Harness,
agents, jobs, subagents, Codex, or any provider.

## Native scrollback

`Screen.commit()` sends finished transcript lines to the user's terminal. Those
rows are never retained as a virtual transcript and never redrawn. The live
region is the terminal's last bounded area and may contain a composer, a
streaming line, or an overlay. No adapter may introduce an alternate screen or
make history depend on an in-memory screen model.

This is why `/work` is an overlay: opening, updating, and closing it changes
only the live region, not committed scrollback.

## Optional adapters

An adapter may be absent because its Harness service is absent. That is normal:
the terminal frontend must still boot. It may show an unavailable or empty state
when a user opens the related local UI, but it must not create a substitute
runtime or infer state by parsing rendered tool output.

The Work adapter is intentionally small:

- `ctx.jobs` supplies current job snapshots and change/completion listeners.
  Passive presentation uses `list()` and does **not** consume `read()` output.
- `ctx.subagents` supplies discovery and lifecycle edges. The adapter keeps only
  observed open lifecycle edges, enriches them with direct-parent `listChildren()`, and
  does not fabricate details a provider did not publish. In particular, a
  remote one-shot lifecycle edge currently has provider/id but no label or
  active-run snapshot; Work can show an observed provider epoch, not a task
  title or an already-running process discovered after TUI startup. Showing
  those facts needs an upstream `ctx.subagents` active-run projection enriched
  with its label, rather than a provider-specific connection or parsed text.

Jobs and subagents stay as separate sections unless Harness publishes an
authoritative correlation identifier.

## Observation and control are separate contracts

A public Harness mutation method is not automatically a human-safe UI action.
Expose control only when its owning seam defines lifecycle, authorization,
scheduling, and model-awareness semantics for a human-originated action. For
example, `ctx.jobs.kill()` marks a job reported for model delivery, so `/work`
observes jobs but does not human-cancel them. Continuable subagents explicitly
provide human authority through `ctx.subagents.interrupt()`.

## Narrowest authority

Ask the service that owns the fact needed; do not route through a broader or
product-specific path:

| Need | Authority |
| --- | --- |
| jobs | `ctx.jobs` |
| subagents | `ctx.subagents` |
| tools | `ctx.tools` |
| commands | `ctx.commands` |
| model information | `ctx.llm` |

For example, a provider such as Codex appears through `ctx.subagents`; dsh-tui
does not import its package or connect to its app-server. A provider detail that
the seam does not expose remains unavailable until the Harness contract gains
it.

## Layout budget

The current slot registry composes known live-region views. It is not yet a
global allocator for arbitrary persistent third-party rows. A shared layout
budget, including priority and narrow/short-terminal behavior, is a prerequisite
before external plugins may contribute persistent live UI. Until then, new
capability views should prefer bounded overlays.

## Public API

The work adapter is internal and experimental. The currently exported
`TuiSlots`, `TuiSlotView`, `TuiSlotName`, and `TuiOverlay` vocabulary is also
experimental pre-1.0, not a stable plugin SDK. dsh-tui will not publish one
until several adapters demonstrate stable authority, lifecycle, and layout
requirements.
