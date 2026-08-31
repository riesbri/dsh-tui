# Architecture

English | [中文](architecture.zh.md)

## Product boundary

```
DeepSeek Harness
        ↓
capability surfaces and domain state
        ↓
internal dshline presentation adapters
        ↓
bounded TuiSlots / Screen rows
        ↓
native terminal
```

**Harness owns capabilities; dshline owns terminal presentation.** Harness is
where lifecycle, state, persistence, provider selection, authority, and policy
belong. dshline reads the narrowest authoritative surface, turns structured
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
dshline will not replace `Screen` with a reconciler that owns historical
terminal output, or adopt an alternate-screen/full-screen transcript model.
React + Ink can support different terminal trade-offs; dshline keeps normal
terminal scrolling, selection, and copying available for its finished
transcript.

Future view code may become more declarative, but its final output must still
be bounded terminal rows for `TuiSlots` and `Screen`. An overlay may change the
live region while it is open; it must not rewrite committed scrollback.

## Supporting Harness capabilities

Supporting a Harness plugin does not mean copying each plugin or provider into
dshline. The upstream service graph calls some of these surfaces *seams* and
others core services; for presentation, the important distinction is whether
there is a standard authoritative contract dshline can consume.

### 1. Generic capability surfaces

Prefer a standard Harness surface over a concrete package or provider:

| Need | Authority | Presentation consequence |
| --- | --- | --- |
| background work | `ctx.jobs` | Observe generic job snapshots and changes. |
| delegated work | `ctx.subagents` | Observe provider-neutral lifecycle and discovery. |
| orchestrated work | `ctx.workflowEngine` + durable `tool-workflow/*` records | Observe run identity, phases, and members; own no run handle. |
| models | `ctx.llm` | Read registered provider/model metadata, and the configurable-provider directory of routes configuration can activate. |
| user configuration | `ctx.settings` | Read redacted namespace descriptors; write path ops against the revision they were read at. |
| secrets | `ctx.credentials` | Ask whether a reference or record is configured and writable; never hold a value. |
| obtaining a credential | `ctx.authorization` | Render the seam's neutral notice and prompt vocabulary; own no login protocol. |
| human commands | `ctx.commands` | Discover and execute the registered command contract. |
| tools | `ctx.tools` | Render tool-owned presentation intents, not tool-name cases. |
| human answers | `ctx.userQuestions` | Register a terminal answerer; claim a request this frontend can present, never assuming it was addressed only to this frontend. |
| sessions | `ctx.sessionQuery` | Query Harness's live-preferred session corpus; do not build another database. Its full-text methods are abstract, so treat content search as optional. |
| attachments | `ctx.attachments` | Use durable, authorized attachment references; do not save paths or base64. |
| log-derived state | `ctx.sessionProjections` | Consume registered domain snapshots and changes. |
| context occupancy | `ctx.sessionProjections` (`contextPressure`, `contextBreakdown`, `tokenUsage`) | Read the O(1) folds; never count tokens or tokenize. |
| context composition per entry | `ctx.tokenMeter` | Ask for the per-node measurement only when an inspector needs it; its own contract calls it O(surface). |
| reducing context | `ctx.commands` (`/compact`) | Dispatch the registered command; observe `compaction/*` events. Never call `ctx.compaction`. |
| agent composition | `ctx.agentPresets` | Read the roster, one preset's composition, and which preset a session actually runs; join or switch an agent through the seam, never a private registry. |
| host composition | `ctx.dshHomePath`, `ctx.baseUrl`, `dsh plugin` | Read the profile roster from Harness's own home-path service and the booted profile from the Loader's base URL; mutate only by forwarding to `dsh plugin`, never by writing a profile manifest. |
| provider health | `ctx.subagents` | Ask the registry which providers exist before presenting a row that names one as usable; never infer availability from a row being enabled. |

A new subagent provider should appear through `ctx.subagents`; a background
producer through `ctx.jobs`; an LLM adapter through `ctx.llm`; and a command
or tool through its standard registry. The real Codex acceptance has proven
that a provider publishing `ctx.subagents` / `ctx.jobs` is shown by generic
Work, not by Codex-specific dshline code. [Provider acceptance](provider-acceptance.md)
records that evidence and its configuration boundary. If a required fact is
absent from the surface, improve the upstream contract rather than parse text
or connect to a provider privately.

### 2. Known projection domains

A domain plugin may publish structured, log-derived state through
`ctx.sessionProjections`. dshline can offer a native presentation adapter for a
known key such as `todos` or `goal`, but the domain and Harness remain the
state authority. The TUI must not parse tool output, fold a second copy of the
session log, or create a competing persistence format.

The projection pattern is:

```
domain plugin
        ↓ registers a projection unit
Harness projection registry drives, caches, and notifies
        ↓ snapshot + change feed
dshline presentation adapter
```

For authoritative projection state, read
`ctx.sessionProjections.snapshot(session)` and subscribe with
`ctx.sessionProjections.onChanged(...)`. The registry drives registered pure
units over committed events, gives `snapshot()` one synchronous consistent cut,
and emits a change only when a unit changes. dshline's internal,
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
optional `todos` projection. dshline presents its current snapshot through a
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
dshline Todo presentation
```

It must not inspect `todo_write` calls or rendered cards to infer state.

Permission selection follows the same boundary: the optional `permissions`
projection supplies the deployment-defined selectable values and current state;
a bare terminal `/permission` only presents that select, while a chosen value
runs the registered Harness `/permission <preset>` command. dshline never folds
permission events or calls the preset service directly, and without the
projection the bare command falls through unchanged.

Context intelligence is the fourth, and it is the one that separates a cheap
authority from an expensive one. `@deepseek-ai/dsh-token-meter` publishes three
projection units — `contextPressure` (the provider's newest prompt sample, the
same sample plus the signed heuristic repricing of the surface since, and the
newest recorded route capacity), `contextBreakdown` (heuristic system/tools/
messages composition), and `tokenUsage` (cumulative provider buckets) — all
O(1) folds. Those are what the status line and `/context`'s headline read.

The same service also exposes `measure(session)`, which prices every node of the
current surface and returns a deep clone; its own documentation states that
measurement is therefore O(surface). That is the per-entry X-ray, and the rule
is that only an open inspector may ask for it. dshline keys a cached
measurement on Harness's own surface revision — the node count plus
`replaceGeneration` — so an inspector left open through a streaming reply
measures once, and a landed compaction is picked up on the next paint. No timer
exists for it.

The two vocabularies are never mixed. Provider-anchored occupancy and heuristic
composition are presented side by side and never divided into each other, and
per-entry prices are presented as estimates because the node meter is
route-priced or heuristic rather than a provider's tokenizer. Scaling one into
the other to make a panel add up would be dshline inventing accounting.

Compaction follows the observation/control split. dshline reads the durable
`compaction/start`, `compaction/summary`, `compaction/end`, and
`compaction/prune` events to present what changed, including for an automatic
compaction that has no command lifecycle at all, and correlates a command
result with the event it names through `sourceEventSeq` — honoured only for an
event this frontend actually projects. Reduction itself stays the registered
`/compact` command's, which owns validation, the idle-agent lock, cancellation,
the durable lifecycle, and the persistence checkpoint. `compactRegion` exists on
the service and is deliberately not exposed: the human command is argument-free,
and a range-selection UI would be a control contract upstream has not defined.

Goal is another known projection domain, with one important extra authority:
its durable `goal` projection represents log-derived goal state, while
`ctx.goals` owns live, process-local continuation activation. A goal view that
claims a resumed session will continue must therefore use the goal service for
that live fact; a projection alone cannot supply it. Plan remains governed by
its documented Harness authority.

### 3. Novel third-party capabilities

A third-party plugin can introduce a domain for which dshline has no native
adapter. That is the reason to eventually offer a small TUI contribution API,
not a reason to promise bespoke UI for every plugin. First we need several
internal adapters to establish authority, lifecycle, and layout rules.

`TuiSlots`, `TuiSlotView`, `TuiSlotName`, and `TuiOverlay` are experimental
pre-1.0 vocabulary. They are not a stable SDK, and no public API package is
committed yet. Persistent extension rows additionally need a global layout
budget; until then, capability UI belongs in bounded overlays.

**Composer and overlays share a visual root, not ownership.** The composer and
every temporary overlay draw through one shared frame — `dshline` on the left,
the workspace or the view's identity on the right, navigation help inside the
bottom border — so a browser reads as the composer expanded rather than as a
detached modal. The sharing is presentation only: while an overlay is mounted it
still replaces the entire live region and owns every keystroke, the composer's
buffer and cursor are not underneath it, and closing it restores the composer
untouched. The shared chrome is a pure helper with no state, no inputs beyond
what it renders, and no lifetime or view of Harness; input and state ownership
are not shared with it.

## Work: the first generic adapter

Harness Work is the first adapter following this model. It presents `ctx.jobs`,
`ctx.subagents`, and Harness workflow runs in separate sections through `/work`
and an optional status summary. It reads job snapshots with `list()` and
observes `onJobsChanged()`; it does not consume the model-facing `read()`
cursor. It observes subagent lifecycle edges and enriches only from
`listChildren()` facts that Harness publishes. It neither merges two authorities
without an authoritative correlation id nor invents labels or active runs that a
provider did not expose.

Three authorities, one projection layer:

```
ctx.jobs                        → Jobs
ctx.subagents                   → Subagents
tool-workflow/* + workflow/*    → Workflows
```

Workflows needed a second ownership rule, and that is why they are a separate
adapter rather than more branches inside the jobs/subagents projection. Job
reads answer per caller and subagent lifecycle edges are scoped to the
delegating parent, but a raw `workflow/*` event carries `{ id, meta }` — a run's
identity and never the Session that asked for it. Subscribing to that feed alone
would show another window's orchestration inside this one.

So ownership comes from the durable side. `dsh-tool-workflow` appends
`tool-workflow/run-start` / `agent-start` / `agent-end` / `run-end` into the
parent Session of a top-level run and nowhere else; a nested run started inside
a subagent records nothing. A run whose `run-start` reached the attached
session's own log is provably this window's, and live `workflow/*` events are
accepted only for a run those records already proved — as enrichment (the
description, the current phase, the newest log line, the terminal stop reason),
never as a second member store. Four of the six `workflow/*` events are
subscribed: `workflow/start` is emitted synchronously inside
`workflowEngine.start()`, so the gate drops it every time, and
`workflow/agent-end` fires only for a call whose `agent-start` already carried
the identical meta. Reconstruction is
live-feed only: a `run-start` left behind by a process that died is not evidence
that a script is executing now, and durable workflow history belongs to the
transcript.

That ownership rule also buys the one correlation Work makes. `WorkflowAgentInfo`
publishes each member's `childId` on the subagent seam, so a workflow member and
a subagent epoch are provably the same child; the member presents that child
under its workflow instead of repeating it in the flat Subagents section, and
navigating from the member reaches the same subagent presentation. No other pair
of records is joined, and a settled member releases the join.

The animation rule follows from the same discipline. The arc spinner means
dshline holds evidence of running computation — a live in-process child Agent
Harness reports as `running`. A Job in `running` is a registry record rather
than an observation, and a provider that publishes no in-process child exposes
no intermediate activity through the generic seam, so both stay static. A
workflow animates only while one of its own members does, because the engine
publishes no execution signal of its own between `agent()` calls. `ctx.workflowEngine`
exposes `start()` and nothing else a UI could reach, so Work observes workflow
runs and offers no control over them.

The manually validated Codex provider is an acceptance proof for these generic
contracts, not a direct dshline integration. Claude Code through
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
installed catalog before any route exists. dshline ships no list of provider
names, so an adapter that adds one is presented without a code change here.

**No field-name knowledge.** Storing an API key needs to know which profile
property carries the credential *reference*, and both shipped adapters call it
`apiKeyEnv`. dshline does not: it reads the namespace's serialized schema from
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
`connect/harness.ts` rather than depended on as whole services, for the reason
`SessionQueryReads` gives — naming the calls a view makes is more legible than
depending on a whole service. Every import in that file is still type-only, so
Connect carries no Harness code at runtime; three assignments in
`connectSeams` check each narrow view against the real service on every build,
because each service package augments `Context` with its own type.

### Connect 2.0: one route can be a declaration, not only a lookup

`listConfigurableProviders()` says which routes an adapter already knows how
to activate. It says nothing about a route that does not exist yet — a
private gateway, a self-hosted server, a localhost OpenAI-compatible
endpoint — because nothing in `LlmConfigurableProvider` marks "this namespace
accepts a key it has never seen." That gap is real on current Harness: there
is no generic seam a configuration surface can ask "may I declare a brand-new
route here," and the official web Models page closes it the same way this
frontend does — by knowing, specifically, that `llm-pi-ai`'s settings profile
can describe a whole provider route.

A schema shaping a namespace's routes as a `dict` — the shape that means "one
element node describes every key, seen or not" — proves only that arbitrary
keys are structurally accepted there. It does not prove that writing one
declares a new LLM route: a future adapter could publish
`providers: dict<ProviderConfig>` while still only recognizing a fixed set of
keys, and the schema shape alone would say nothing to the contrary. `/connect`
does not let that inference cross into generic code. `connect/model.ts` keeps
`ConnectNewRouteTarget` as a plain data shape — a namespace, a parent path, a
revision — and asserts nothing about which namespaces it is safe to produce
one for; it is never derived there from schema shape alone.

That determination is made once, inside `connect/pi-ai.ts`, which is the one
module allowed to know that `llm-pi-ai` specifically is a domain whose
settings profile can describe a whole provider route.
`piAiDeclarationTarget()` filters the directory to `llm-pi-ai`'s own entries
first, then checks that they agree on where their dict sits, that the schema
there really does shape it as a `dict`, that the curated `baseURL` field is
still reachable, and that a protocol choice can still be derived — the same
schema-shape check `protocolChoices()` makes, because a namespace this module
cannot offer a protocol for is one it cannot safely declare a route into
either. Any one of those failing means the schema drifted from what this
presentation module knows how to read, and `+ Add custom provider` is offered
only when every check passes — never a row that is guaranteed to fail partway
through the wizard, which is the same "no offer known to fail" rule the rest
of Connect already follows for its ordinary actions. If another Harness domain
later published its own declaration seam, `piAiDeclarationTarget()` is the
function to replace, not `connect/model.ts`.

Knowing an address exists is not the same as knowing what to write there. A
curated editor needs field names — "base URL", "protocol", "model catalog" —
that no generic seam publishes, so presenting them at all means knowing one
namespace's shape. That knowledge is isolated in `connect/pi-ai.ts` alongside
the declaration check above, and:

- names its four curated fields (`displayName`, `baseURL`, `api`, `models`) as
  plain strings, and reads protocol *choices* from the namespace's own
  serialized schema (`z.union` of string consts) rather than a dshline
  constant, so a protocol `dsh-llm-pi-ai` adds later needs no change here;
- writes through the same `ctx.settings.mutate()` path ops every other Connect
  action uses — one `set`/`unset` per changed field, never a wholesale
  replace, so `compat`, headers, retry policy, and anything else this pass
  does not render survive an edit untouched;
- never imports `@deepseek-ai/dsh-llm-pi-ai` at runtime, registers no
  provider, parses no model output, and makes no network request. Harness
  still does every one of those.

The create wizard itself fails closed the same way its declaration check
does: if the protocol choices it derives at the moment the wizard opens turn
out empty — schema drift between the row being shown and the wizard actually
starting — it refuses immediately rather than writing a guessed `api: ''`
Harness would reject several steps later with a less useful error. And the
wizard never persists mid-flow: every field, including the model catalog, is
collected into an in-memory draft first, and only an explicit "Create
provider" on a final review — Provider ID and every other field shown back,
the API key only ever as "configured" or "not set" — triggers the first
write. Leaving the model submenu without adopting anything, in particular,
changes nothing: a route that inherits its catalog stays inherited until a
real adoption happens, never becoming a stored `models: []` merely because the
submenu was opened and closed.

`connect/model-editor.ts` and `connect/route-editor.ts` sit on top: the first
is pure draft logic for a model list (adopting a discovered candidate without
overwriting a hand-corrected capacity, telling an inherited catalog apart from
an explicit empty one), and the second sequences the same `promptSelect` /
`promptText` overlays every other Connect action already uses into two small
menu loops — editing an existing declared route, and declaring a new one —
rather than a bespoke form overlay.

Model discovery is advisory, and stays that way by construction:
`ctx.llm.discoverModels()` takes a draft (`provider` for an existing route, so
the owning adapter resolves its own stored credential without this frontend
ever reading one back; a one-shot typed key for a route that does not exist
yet) and answers candidates. A candidate whose id is already in the draft is
left untouched — an endpoint listing carries at best an id, a name, and two
capacities, never more than a row a person already corrected knows — and
nothing fetched is written until the reader explicitly saves.

The result is the shape the acceptance test is built around:

```
custom endpoint
    ↓
Harness settings  (ctx.settings.mutate through connect/pi-ai.ts's path ops)
    ↓
llm-pi-ai         (resolves the declared profile into a live provider)
    ↓
ctx.llm provider route
    ↓
dshline /model
```

never:

```
custom endpoint
    ↓
dshline client
```

dshline performs no provider HTTP request, owns no secret beyond the one-shot
value it hands to `ctx.credentials.set()` after an explicit create, and keeps
no second state store: a created route is addressable, editable, and
removable through the exact same seams every catalog route already goes
through.

## Presets: composition is Harness's, not dshline's

An agent preset is Harness's own answer to "what can this agent do" — a named
composition of tools, prompt sections, and delegation backends, resolved
through `ctx.agentPresets` and joined to an agent at the one supported point
in its lifecycle, `setup(agentCtx)`. `/plugins` is the terminal presentation
of that seam: it lists the roster, shows the rows the running agent's preset
actually composes, and carries out a change through the same authority a
change made from the official web interface would use. It keeps no plugin
registry, no capability list, and no provider-specific branch of its own —
exactly the rule every other adapter in this document follows, applied to
"which tools does this agent have" instead of "which providers can it talk
to."

**System presets are Harness's, and stay read-only here.** A preset shipped
with the deployment carries `system` trust; `/plugins` never edits that file.
Customizing one is Harness's own supported path — copy it to a new, locally
authored preset (`ctx.agentPresets.copy()`) and edit the copy — and pressing
space on a built-in preset's row is the terminal's offer to do exactly that,
never a shortcut around it. A user-authored copy has no narrower Harness
mutation API than its own composition file, so toggling one row there is the
smallest edit that touches only that field and leaves the rest of the file
alone; Harness's own health check on that preset, not a private read of it,
still decides whether the result is usable.

**Session composition is a lifecycle fact, not a setting this frontend
keeps.** A new session composes from the roster's current default. A resumed
session composes from whatever its own log recorded — the preset it was
created with, or a later switch made while it was still blank — never
whatever the default happens to be *today*; a produced session's tool set is
history, and treating it as a live setting would let it drift out from under
a conversation that already happened. `/plugins`' own picker enforces the
same boundary a running session already has: a preset can be switched live
only while the session is blank, and switching the *default* for the next
session is offered explicitly wherever switching the current one is not
Harness's to allow. That boundary is re-read at the instant it is acted on,
not carried from the reading a keystroke was decided against: an action here
holds its own awaits — two prompts a human answers, a file write, a Harness
re-resolve — and a turn beginning across them must move the answer.

Where that history cannot be placed exactly, the gap is named rather than
papered over. A session produced before dshline adopted presets recorded no
preset at all, and resumes under the shipped `standard` — the preset built to
mean the exact flat tool set every such session actually ran under. A
deployment shipping no usable `standard` has no honest equivalent, so the
resume falls back to that deployment's own default and reports the
substitution into the transcript. Refusing the resume outright would protect
a composition record by withholding the transcript it belongs to, which is
the wrong trade: the reader can see a caveat, and cannot see a session that
will not open.

This is also why dshline's own composition changed shape to adopt it. Before
presets, dshline mounted `dsh-base`'s full tool set once, for the process —
correct for a frontend with nothing to switch between, but nothing for a
composition-browsing command to browse. Every per-agent row `dsh-base` used to
mount unconditionally now moves behind whichever preset an agent actually
joins, the same "agent plane moves behind agent presets" step Harness's own
Web bundle already took for the identical reason; process-wide services with
no per-session meaning — registries, the sandbox and approval stack, the
token meter — stay exactly where they were.

## Profiles provide; presets expose

Two Harness layers answer two different questions, and conflating them is the
mistake this frontend is built to make visible.

```
profile   what the HOST can do    dsh.profile.bundles → patch layers → the composed tree
preset    what an AGENT may see   agent.cordis.yml rows → one agent's tools and prompt
```

A profile is chosen by the launcher and applied once, at boot. A preset is
chosen per session and can be recomposed while a session is still blank. So
`/profiles` and `/plugins` are not two views of one thing: they sit on either
side of a boundary, and every difference between them follows from it.

**A row being enabled proves only the second half.** The shipped `standard`
preset says so beside its own optional delegation rows — "Install the matching
Bundle in this Profile and restart the Host, then copy this preset and remove
`disabled` from the matching tool row. Host availability alone grants no tool."
The reverse is easier to hit by accident: enabling a row whose bundle was never
installed yields a preset that mounts, a tool the model can see, and a
delegation that fails on first use. `/plugins` closes that gap where it can be
*proven* — a row naming a provider a mounted Host registry does not supply is
marked, and the row's own state is left honest. Where it cannot be proven,
nothing is claimed: the check is a data table of capability modules, so a
module it does not cover, a `!!js` provider it never evaluates, and a registry
this profile does not mount all produce no verdict rather than a guess.

**Restart is part of the boundary, not a caveat about it.** `/profiles`
performs bundle changes through `dsh plugin`, Harness's own package lifecycle,
and then says what it did and did not affect: a change to the running profile
reports `restart required`, a change to any other names the command that picks
it up. Switching profiles is not offered at all, because no seam re-links a
composed Host's bundle layers and inventing one would be exactly the competing
lifecycle this document forbids.

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

The coverage is layered into three lanes, all in `.github/workflows/ci.yml`.
**Minimum** pins every `dsh-*` devDependency to a fixed floor version — the
oldest release the peer ranges still promise — and checks that the graph
still resolves, builds, and typechecks. **Released** resolves the currently
published line the same way `tools/sync-harness.mjs` and
`tools/check-peer-currency.mjs` already do (the registry's `next` dist-tag,
with cordis's own `latest` exception), pins every Harness devDependency in
both manifests to it, runs the full suite, and boots the packed plugin beside
the published launcher in a real profile. **Edge** builds
`deepseek-ai/deepseek-harness@master` in a separate checkout and links it only
in the disposable runner, exactly the way `tools/link-harness.mjs` links a
local checkout for manual development. It may remain non-blocking, and never
runs on a pull request, but its failures should prompt an explicit
compatibility decision rather than a surprise release break.

All three additionally run `tools/capability-report.mjs`, which turns a
seam's real Harness contract — a real `SessionQueryEngine`, a real
`SubagentRuntime`, a real abstract `JobRegistry` subclass, a real
`UserQuestionService`, a real abstract `WorkflowEngine` subclass over a real
`Session`, never a dshline-shaped fake — into a named pass/fail
per capability. Coverage today is initial, not exhaustive: `sessionQuery`,
`jobs`, `subagents`, `sessionProjections`, `workflows`, `userQuestions`,
`tokenMeter` (the real `TokenMeter` over a real `SessionStore`), and
`compaction` (a real `CompactionEngine` subclass), chosen because
each already has (or could cheaply gain) a test built against the real class
rather than a hand-typed fake. An upstream change to one of these reads as
`sessionQuery contract changed` rather than only a generic
`pnpm typecheck failed`; a seam not yet in the table still has
`pnpm typecheck`/`pnpm test` as its backstop. `tools/capability-probes.mjs` is
a pointer table, not a second copy of the contract: it names which existing or
purpose-built test already exercises each seam, so growing this coverage means
adding a line to that table (or a small new probe under
`packages/dshline/tests/capability/`), never teaching this module the seam's
shape itself.

`userQuestions` is this radar's first proof against a real break: Harness's
`ctx.userQuestions` registration shape moved between the installable line and
Edge, and `packages/dshline/src/questions.ts` currently bridges both with one
small runtime check rather than a package-version test. That bridge is
temporary by design — see its module comment for the deletion condition —
because dshline supports the current installable Harness line plus current
Edge, not indefinite historical compatibility.

Released also compares the currently published line against the newest
official `dsh-v*` GitHub Release (not merely a tag — a Release DeepSeek
actually published, prereleases included) — DeepSeek publishes a Release
before it necessarily reaches npm, so this is the only way to see that gap at
all. The comparison itself runs on every trigger; checking the release out and
building it is reserved for the daily schedule and manual dispatch, and stays
non-blocking, the same as Edge — an unpublished release is not yet something
any consumer can install either. When that release is the same commit Edge is
already probing on `master` — the ordinary case, since a release is usually
cut from master's tip — it borrows Edge's verdict instead of building the
identical Harness tree a second time in the same run.

A sibling job — which by construction executes no dependency code — opens an
automated sync pull request when the Released line moves, titled as a routine
bump or as a required peer compatibility decision according to what the
ranges accept. Released answers "does the current installable Harness release
belong to the set dshline claims to support", and it blocks a pull request or
push to `main` on both halves of that question: runtime compatibility (install,
build, typecheck, the full suite, capability probes, the consumer boot) and
the peer contract. A newly published prerelease tuple the peer ranges do not
yet accept fails the job even when every runtime check is green, reported as
"compatible in practice; peer compatibility decision required" — package
metadata is part of the compatibility promise, so a human is expected to
inspect and either widen the range or hold the line, deliberately, rather than
letting the published metadata silently drift out of truth. See the module
comment in `tools/sync-harness.mjs`.
