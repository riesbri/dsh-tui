# Architecture

## Product boundary

```
DeepSeek Harness
        ↓
capability surfaces and domain state
        ↓
internal dsh-tui presentation adapters
        ↓
bounded TuiSlots / Screen rows
        ↓
native terminal
```

**Harness owns capabilities; dsh-tui owns terminal presentation.** Harness is
where lifecycle, state, persistence, provider selection, authority, and policy
belong. dsh-tui reads the narrowest authoritative surface, turns structured
facts into terminal rows, and does not recreate a runtime, a provider
connection, or a domain state machine.

The renderer package is below that boundary. It knows display widths, control
escaping, keys, boxes, and `Screen`; it must not learn about Harness, agents,
jobs, providers, or a domain such as Todos.

## Native scrollback is the terminal model

`Screen.commit()` writes finished transcript rows into the user's real terminal
scrollback. Those rows are never virtualized, retained as an in-memory screen,
or rewritten. `Screen` redraws only the bounded live region at the bottom: a
streaming line, composer, status, or temporary overlay. Every terminal write
passes through it so that live region stays last.

This is deliberate product architecture, not a temporary implementation choice.
dsh-tui is not moving to React + Ink or another full-screen/alternate-screen
renderer. That is a different terminal architecture with different trade-offs;
dsh-tui keeps normal terminal scrolling, selection, and copying available for
its finished transcript.

Future view code may become more declarative, but its final output must still
be bounded terminal rows for `TuiSlots` and `Screen`. An overlay may change the
live region while it is open; it must not rewrite committed scrollback.

## Supporting Harness capabilities

Supporting a Harness plugin does not mean copying each plugin or provider into
dsh-tui. The upstream service graph calls some of these surfaces *seams* and
others core services; for presentation, the important distinction is whether
there is a standard authoritative contract dsh-tui can consume.

### 1. Generic capability surfaces

Prefer a standard Harness surface over a concrete package or provider:

| Need | Authority | Presentation consequence |
| --- | --- | --- |
| background work | `ctx.jobs` | Observe generic job snapshots and changes. |
| delegated work | `ctx.subagents` | Observe provider-neutral lifecycle and discovery. |
| models | `ctx.llm` | Read registered provider/model metadata. |
| human commands | `ctx.commands` | Discover and execute the registered command contract. |
| tools | `ctx.tools` | Render tool-owned presentation intents, not tool-name cases. |
| sessions | `ctx.sessionQuery` | Query Harness's live-preferred session corpus; do not build another database. |
| attachments | `ctx.attachments` | Use durable, authorized attachment references; do not save paths or base64. |
| log-derived state | `ctx.sessionProjections` | Consume registered domain snapshots and changes. |

A new subagent provider should appear through `ctx.subagents`; a background
producer through `ctx.jobs`; an LLM adapter through `ctx.llm`; and a command
or tool through its standard registry. Codex is the intended proof: a Codex
provider that publishes `ctx.subagents` / `ctx.jobs` is shown by generic Work,
not by Codex-specific dsh-tui code. If a required fact is absent from the
surface, improve the upstream contract rather than parse text or connect to a
provider privately.

### 2. Known projection domains

A domain plugin may publish structured, log-derived state through
`ctx.sessionProjections`. dsh-tui can offer a native presentation adapter for a
known key such as `todos` or `goal`, but the domain and Harness remain the
state authority. The TUI must not parse tool output, fold a second copy of the
session log, or create a competing persistence format.

The projection pattern is:

```
domain plugin
        ↓ registers a projection unit
Harness projection registry drives, caches, and notifies
        ↓ snapshot + change feed
dsh-tui presentation adapter
```

For authoritative projection state, read
`ctx.sessionProjections.snapshot(session)` and subscribe with
`ctx.sessionProjections.onChanged(...)`. The registry drives registered pure
units over committed events, gives `snapshot()` one synchronous consistent cut,
and emits a change only when a unit changes. A future internal projection
observer should subscribe once and feed native presentation adapters, rather
than every feature independently replaying the same log. This is an internal
architecture direction, **not** a stable public `ProjectionAdapter` interface.

`todos` is the next proof. `@deepseek-ai/dsh-tool-todo` supplies the
model-facing `todo_write` tool, durable whole-list `todo/write` events, and the
optional `todos` projection. Todo items have only `content` and `pending`,
`in_progress`, or `completed` status; each write replaces the complete list.
The projection is `null` before a write, contains the latest list, and clears
on the next `turn/start`. The intended path is:

```
@deepseek-ai/dsh-tool-todo
        ↓ todo/write and todos projection
ctx.sessionProjections
        ↓
dsh-tui Todo presentation
```

It must not inspect `todo_write` calls or rendered cards to infer state.

Goal is another known projection domain, with one important extra authority:
its durable `goal` projection represents log-derived goal state, while
`ctx.goals` owns live, process-local continuation activation. A goal view that
claims a resumed session will continue must therefore use the goal service for
that live fact; a projection alone cannot supply it. Plan remains governed by
its documented Harness authority.

### 3. Novel third-party capabilities

A third-party plugin can introduce a domain for which dsh-tui has no native
adapter. That is the reason to eventually offer a small TUI contribution API,
not a reason to promise bespoke UI for every plugin. First we need several
internal adapters to establish authority, lifecycle, and layout rules.

`TuiSlots`, `TuiSlotView`, `TuiSlotName`, and `TuiOverlay` are experimental
pre-1.0 vocabulary. They are not a stable SDK, and no public API package is
committed yet. Persistent extension rows additionally need a global layout
budget; until then, capability UI belongs in bounded overlays.

## Work: the first generic adapter

Harness Work is the first adapter following this model. It presents `ctx.jobs`
and `ctx.subagents` in separate sections through `/work` and an optional status
summary. It reads job snapshots with `list()` and observes `onJobsChanged()`;
it does not consume the model-facing `read()` cursor. It observes subagent
lifecycle edges and enriches only from `listChildren()` facts that Harness
publishes. It neither merges jobs and subagents without an authoritative
correlation id nor invents labels or active runs that a provider did not expose.

Providers including spawn/fork, Codex, and Claude Code are acceptance targets
for the generic contracts, not direct dsh-tui integrations.

## Observation is not control

A callable Harness mutation is not automatically a human-safe UI operation.
Before exposing a human action, verify that the owning surface explicitly
provides lifecycle semantics, authorization, scheduling semantics, and the
model-awareness or notification consequences of that action.

`ctx.jobs.kill()` is the current counterexample: successful cancellation moves
the job to `stopping` and marks terminal delivery reported, which is a
model-facing control semantic. Work therefore observes jobs but does not offer
human cancellation. `ctx.subagents.interrupt(..., { kind: 'user',
parentSessionId })` is the contrasting case: the seam explicitly models human
authority to stop a live continuable child. This rule applies to every future
capability, not only Work.

## Upstream compatibility

Harness is evolving quickly, so compatibility with its published surfaces is a
first-class engineering concern. The repository already probes upstream
`master` weekly by building its declarations and type-checking this project;
it is an early warning, not permission to assume unreleased behavior is stable.

The intended coverage is layered: retain a supported Harness peer floor, test
the current released Harness, and keep a Harness `main`/`master` compatibility
probe for changes to jobs, subagents, commands, projections, attachments, and
other consumed surfaces. The bleeding-edge probe may remain non-blocking when
external availability makes that appropriate, but failures should prompt an
explicit compatibility decision rather than a surprise release break.
