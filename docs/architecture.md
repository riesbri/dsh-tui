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
dsh-tui will not replace `Screen` with a reconciler that owns historical
terminal output, or adopt an alternate-screen/full-screen transcript model.
React + Ink can support different terminal trade-offs; dsh-tui keeps normal
terminal scrolling, selection, and copying available for its finished
transcript.

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
| models | `ctx.llm` | Read registered provider/model metadata, and the configurable-provider directory of routes configuration can activate. |
| user configuration | `ctx.settings` | Read redacted namespace descriptors; write path ops against the revision they were read at. |
| secrets | `ctx.credentials` | Ask whether a reference or record is configured and writable; never hold a value. |
| obtaining a credential | `ctx.authorization` | Render the seam's neutral notice and prompt vocabulary; own no login protocol. |
| human commands | `ctx.commands` | Discover and execute the registered command contract. |
| tools | `ctx.tools` | Render tool-owned presentation intents, not tool-name cases. |
| sessions | `ctx.sessionQuery` | Query Harness's live-preferred session corpus; do not build another database. Its full-text methods are abstract, so treat content search as optional. |
| attachments | `ctx.attachments` | Use durable, authorized attachment references; do not save paths or base64. |
| log-derived state | `ctx.sessionProjections` | Consume registered domain snapshots and changes. |

A new subagent provider should appear through `ctx.subagents`; a background
producer through `ctx.jobs`; an LLM adapter through `ctx.llm`; and a command
or tool through its standard registry. The real Codex acceptance has proven
that a provider publishing `ctx.subagents` / `ctx.jobs` is shown by generic
Work, not by Codex-specific dsh-tui code. [Provider acceptance](provider-acceptance.md)
records that evidence and its configuration boundary. If a required fact is
absent from the surface, improve the upstream contract rather than parse text
or connect to a provider privately.

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
and emits a change only when a unit changes. dsh-tui's internal,
session-scoped observer subscribes once for the exact `Session`, coalesces an
invalidation in a microtask after that synchronous drive settles, and leaves
all values in the registry for adapters to read through `snapshot()`. It is not
a second projection store. Projection-key presence is process-wide, not a
per-session capability signal: a key registered by any composition can appear
in every session snapshot. Interpret the projection value (for example, a Todo
list or `null`) rather than treating the presence of `todos` as proof that this
exact agent has Todos enabled. This is an internal architecture pattern, **not**
a stable public `ProjectionAdapter` interface.

`todos` is the second proof. `@deepseek-ai/dsh-tool-todo` supplies the
model-facing `todo_write` tool, durable whole-list `todo/write` events, and the
optional `todos` projection. dsh-tui presents its current snapshot through a
bounded `/todos` overlay and an optional `todo completed/total` status segment;
it owns no Todo mutation, lifecycle, fold, or persistence. Todo items have only
`content` and `pending`, `in_progress`, or `completed` status; each write
replaces the complete list. The projection is `null` before a write, contains
the latest list, and clears on the next `turn/start`. The intended path is:

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

The manually validated Codex provider is an acceptance proof for these generic
contracts, not a direct dsh-tui integration. Claude Code through
`@deepseek-ai/dsh-subagent-claude-code`, `ctx.subagents`, and `ctx.jobs` is the
logical next target, but has not been manually validated. The required path for
both and future providers is documented in [Provider acceptance](provider-acceptance.md).

## Sessions: one corpus, and two lifetimes

Sessions is the third adapter, and it reads exactly one authority. `ctx.sessionQuery`
already publishes a live-preferred logical corpus that merges `ctx.sessions` with
whatever persistence is mounted, so the browser lists `listSessions()` records,
folds their titles with one batched `readTitleSnapshots()` observation, and takes
the selected row's event count from `listEvents()`. There is no sessions-directory
scan, no title cache, and no second index; a frontend index would disagree with
the corpus the first time either changed.

The engine's two full-text methods are its ONLY abstract surface, so content
search is an optional capability rather than a guaranteed one. A deployment whose
backend implements none reports `SESSION_QUERY_SEARCH_DISABLED`, and the browser
keeps filtering the rows it already has while saying that content search is off.
Filtering is not a private index: it matches the text a row already displays.

Sessions also forced a lifetime split the frontend did not previously need:

```
window        terminal, key routing, model route, reader preferences
   ↓ attaches
attachment    one Agent, its log projection, its capability adapters, its views
```

While a launch drove exactly one session for the life of the process, the plugin
fiber and the session were the same lifetime, and `ctx.effect` was the right
owner for everything. Reopening a session in place breaks that identity: the slot
registrations, the log listener, the spinner, and the Work and projection
adapters all describe one session, so they belong to a `SessionScope` that comes
down before its agent handle does. Key routing moved the other way, up to the
window, which is also why `ctrl-d` now quits from the launch browser without that
browser owning a keyboard of its own.

Reopening uses the supported lifecycle and nothing else: the owned
`AgentHandle.dispose()` retires the current agent — the handle is this
frontend's capability because this frontend created the agent — and
`ctx.agents.resume` opens the next one. The transcript is appended into native
scrollback under what is already there; nothing committed is rewritten. A
rejected resume neither ends the process nor substitutes a session: by then the
previous agent is already retired, so the window commits Harness's reason and
asks again through the same browser. Dismissing that is how a reader chooses a
fresh session deliberately.

## Connect: configuration is four seams, not one

Provider configuration is where a frontend is most tempted to grow its own
opinions — a provider list, an OAuth implementation, a file it writes keys to.
Harness already owns all of it, in four separate surfaces that answer four
different questions:

| Question | Authority |
| --- | --- |
| Which provider routes can be configured at all? | `ctx.llm.listConfigurableProviders()` |
| Which are registered right now? | `ctx.llm.listProviders()` |
| How is one configured, and at what revision? | `ctx.settings.describe()` / `mutate()` |
| Is the secret it names present, and writable? | `ctx.credentials.describe()` / `set()` |
| How is a credential *obtained* when it must be asked for? | `ctx.authorization` |

`/connect` is the join of those and nothing else. Three consequences follow, and
each is the reason a shortcut was refused:

**No provider registry.** A route reaches the browser because a mounted adapter
declared it configurable — which a bare-mounted `llm-pi-ai` does for its whole
installed catalog before any route exists. dsh-tui ships no list of provider
names, so an adapter that adds one is presented without a code change here.

**No field-name knowledge.** Storing an API key needs to know which profile
property carries the credential *reference*, and both shipped adapters call it
`apiKeyEnv`. dsh-tui does not: it reads the namespace's serialized schema from
`describe()` and takes the property whose schemastery role is `credential-ref`.
The role is the contract; the name is a coincidence.

**No login protocol.** `ctx.authorization` renders as one notice shape and three
prompt shapes — `text`, `secret`, `select` — which is deliberately smaller than
any provider's own vocabulary. A surface that renders one flow renders all of
them, so OAuth, device code, and a key typed into a provider library's prompt
all arrive here as the same interaction. The terminal-specific decision is only
*where* each half goes: a notice is committed to native scrollback, because a
sign-in URL and a device code are the two things a person most needs to select
and copy, while a prompt is a bounded overlay because it takes the keyboard.

The browser owns the lifetime of what it starts. An authorization attempt can
sit waiting on a browser callback with no prompt mounted, so closing `/connect`
aborts the attempt's signal — the seam settles it as `cancelled`, any mounted
prompt comes down with it, and a later notice or prompt from a flow that has not
yet observed its signal is dropped rather than drawn over an unrelated
transcript.

Because both surfaces write the same namespace and the same reference, a change
made in the terminal is visible on the official web Models page and the other
way round. Neither has a store of its own to disagree from. The
`<ROUTE>_API_KEY` derivation for a route whose profile names no reference yet is
shared for exactly that reason.

The one thing `/connect` deliberately does NOT do is join its two sections. A
configurable-provider entry is addressed by `settingsNs` plus a route key; an
authorization flow is addressed by a `CredentialKey` whose scope is its owning
plugin's registered name. Those coincide for the adapter shipped today, but
Harness publishes no contract that they must, so merging the rows would be the
frontend inventing a correlation — the same refusal Work makes when it keeps
jobs and subagents apart. Both are listed, each under the identity Harness gave
it.

The seam surfaces themselves are written out structurally in
`connect/harness.ts` rather than type-imported, for the reason
`SessionQueryReads` gives — naming the calls a view makes is more legible than
depending on a whole service — and for a second, concrete one: the settings,
credentials, and authorization packages cannot currently be added to this
workspace, because resolving any of them moves every `next`-tagged Harness
dependency onto a line whose own peer graph does not resolve. They become type
imports when that floor moves.

## Observation is not control

A callable Harness mutation is not automatically a human-safe UI operation.
Before exposing a human action, verify that the owning surface explicitly
provides lifecycle semantics, authorization, scheduling semantics, and the
model-awareness or notification consequences of that action.

Sessions is the case where this rule pointed the other way. `AgentHandle` is
handed to the caller that created the agent, and its documentation says the
disposer is a capability held by that owner — so retiring the agent is authorized
here, and reopening a session is a human action the frontend may take. What
Harness does NOT define is what should happen to a job or a delegated subagent
whose owning agent disappears mid-flight, so the window refuses to reopen while
either is attached, and refuses mid-turn, naming the reason rather than guessing.
Renaming a session is deferred for the mirror-image reason: `ctx.sessionTitle`
models explicit `user` authority, so it will be exposed when the browser has a
text-entry mode, not as a side effect of listing titles.

`ctx.jobs.kill()` is the current counterexample: successful cancellation moves
the job to `stopping` and marks terminal delivery reported, which is a
model-facing control semantic. Work therefore observes jobs but does not offer
human cancellation. `ctx.subagents.interrupt(..., { kind: 'user',
parentSessionId })` is the contrasting case: the seam explicitly models human
authority to stop a live continuable child. This rule applies to every future
capability, not only Work. Likewise, Work presents lifecycle and job state,
not provider reasoning, commands, tool activity, progress, or diffs unless
Harness exposes those facts through a generic contract; it must never scrape
provider output.

## Upstream compatibility

Harness is evolving quickly, so compatibility with its published surfaces is a
first-class engineering concern. The repository already probes upstream
`master` daily by building its declarations and type-checking this project;
it is an early warning, not permission to assume unreleased behavior is stable.

The intended coverage is layered: retain a supported Harness peer floor, test
the current released Harness, and keep a Harness `main`/`master` compatibility
probe for changes to jobs, subagents, commands, projections, attachments, and
other consumed surfaces. The bleeding-edge probe may remain non-blocking when
external availability makes that appropriate, but failures should prompt an
explicit compatibility decision rather than a surprise release break. All of
it shares one daily workflow: the master job typechecks against freshly built
upstream declarations; the released job pins every Harness devDependency in
both manifests to the exact published version (`pnpm run sync-harness`),
re-verifies the peer ranges, runs the full suite, and boots the packed plugin
beside the published launcher in a real profile; and a sibling job — which by
construction executes no dependency code — opens an automated sync pull request
when the published line moves, titled as a routine bump or as a required peer
compatibility decision according to what the ranges accept.
