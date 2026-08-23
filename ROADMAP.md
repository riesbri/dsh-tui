# Roadmap

This is product direction, not a dated feature checklist. dshline is a
**terminal-native frontend for DeepSeek Harness that understands Harness
capabilities instead of reimplementing them.** Its architectural rule is:

> **Harness owns capabilities; dshline owns terminal presentation.**

The proof is simple: install a new Harness provider or plugin; it publishes an
existing standard capability surface; dshline already knows how to present that
surface. A real Codex provider has now passed that acceptance through
`ctx.subagents` and `ctx.jobs` into generic Work, without Codex-specific
dshline integration. Provider CONFIGURATION follows the same rule:
`/connect` presents whatever `ctx.llm`'s configurable-provider directory,
`ctx.settings`, `ctx.credentials`, and `ctx.authorization` publish, with no
provider registry and no login protocol of its own. [Provider acceptance](docs/provider-acceptance.md)
records the evidence, configuration boundary, and the next target. Native
terminal scrollback is the other differentiator. This does not claim that other
TUIs cannot be extensible; it describes the architecture this frontend is
choosing.

## Product principles

- **Native terminal scrollback is an invariant.** Finished transcript rows are
  committed to the user's real terminal and are never virtualized, rewritten,
  or moved to an alternate screen. Only the bounded live region is redrawn, so
  normal terminal selection, copying, and scrollback remain available.
- **The renderer stays Harness-independent and dependency-free.** It knows
  terminal text, widths, keys, boxes, and the append-plus-live-region screen;
  Harness wiring belongs above it.
- **Use standard Harness authority before a product integration.** Prefer
  `ctx.subagents`, `ctx.jobs`, `ctx.llm`, `ctx.commands`, `ctx.tools`,
  `ctx.sessionQuery`, `ctx.attachments`, and `ctx.sessionProjections` over a
  provider connection, parsed output, or duplicated database.
- **Capabilities remain optional.** A profile without a service still starts;
  its related view is unavailable rather than becoming a boot failure.
- **Observation and control are separate contracts.** A callable mutation is
  not automatically a safe human action. Human UI needs explicit lifecycle,
  authorization, scheduling, and model-notification semantics from its owner.
- **No silent degradation.** Show the structured fact Harness exposes; when a
  surface cannot answer a question, say less rather than guess from text.
- **Future abstractions still produce bounded rows.** Declarative view code is
  welcome only when it ultimately serves the existing `Screen` / `TuiSlots`
  terminal model, not a full-screen replacement.

## Capability direction

Areas may progress independently, but the intended order is below.

### 1. Harness Work — merged

The first generic capability adapter presents background jobs from `ctx.jobs`
and delegated activity from `ctx.subagents` through bounded Work UI.

- observe jobs without consuming their output cursor
- observe subagents and preserve Harness's provider-neutral lifecycle facts
- treat real-provider support as an upstream-contract acceptance test, not a
  provider-specific dshline integration
- record the completed Codex acceptance separately from the unvalidated Claude
  Code target; neither requires provider-specific dshline production code

Jobs and subagents remain separate until Harness publishes an authoritative
correlation. The Codex acceptance is complete; Claude Code through
`@deepseek-ai/dsh-subagent-claude-code`, `ctx.subagents`, and `ctx.jobs` is the
next acceptance target, not a manually validated integration. See [Provider
acceptance](docs/provider-acceptance.md). Work also establishes the broader
control rule: it does not expose `ctx.jobs.kill()` because that method has
model-facing reported-delivery semantics; a continuable subagent can expose a
user-authorized interrupt only where `ctx.subagents` explicitly models it.

### 2. Session projections and agent state

`ctx.sessionProjections` is the second proven architecture pattern. Domain plugins
register projection units; Harness owns their log drive, caching, snapshot, and
change feed; dshline consumes the snapshot and changes as presentation input.
Its internal shared observer feeds native adapters instead of making every
feature replay the same session log.

1. **Todos — implemented.** `/todos` and a compact status reading consume the
   `todos` projection provided by `@deepseek-ai/dsh-tool-todo` through one
   internal session-scoped observer. The whole-list `todo/write` state,
   lifecycle, and persistence remain Harness-owned; dshline parses neither
   calls, cards, nor tool output and owns no Todo state machine.
2. **Next, refine Goal.** Use the durable `goal` projection for log-derived
   state and `ctx.goals` where live, process-local continuation authority is
   required.
3. **Plan remains Harness-governed.** Its presentation continues to follow the
   authority documented by the plan capability rather than a TUI-owned mirror.

No generic public `ProjectionAdapter` interface is being promised.

### 3. Sessions — merged

The third generic capability adapter presents the Harness session corpus through
`ctx.sessionQuery` alone. `/sessions` and `--resume` open the same bounded
browser: it lists live-preferred records with batched folded titles, filters them
as you type, hands the same words to the engine's full-text surface on `tab`, and
reopens one session in place.

- read the corpus with `listSessions()`, `readTitleSnapshots()`, and
  `listEvents()`; never scan a sessions directory or keep a second index
- treat `searchSessions()` as optional: it is the engine's only abstract
  surface, and a backend reporting `SESSION_QUERY_SEARCH_DISABLED` degrades to
  filtering instead of failing
- reopen through the owned `AgentHandle` disposer and `ctx.agents.resume`, and
  refuse in the states Harness does not define a lifecycle for
- keep the transcript in native scrollback: reopening appends, never rewrites

It also introduced the window/attachment split — a window owns the terminal, key
routing, the model route, and reader preferences, while an attachment owns one
Agent and everything projected from its log. That split is the reusable part; any
future capability that replaces domain state for a whole session needs it.

Still ahead for Sessions:

- rename through `ctx.sessionTitle`, whose `user` source is explicit human
  authority, once the browser has a text-entry mode
- corpus filters (`filterSessions`) for workspace, delegated origin, and age
- lineage navigation from `traceSession`, and within-session `searchEvents`
- paging a ranked result set, which needs the backend's own cursor generations

### 4. Connect — merged

The fourth generic capability adapter presents provider CONFIGURATION, which is
four Harness surfaces rather than one. `/connect` joins the
configurable-provider directory and registered routes from `ctx.llm`, the
user-settings document through `ctx.settings`, credential presence through
`ctx.credentials`, and the login flows registered on `ctx.authorization`, and
presents them as one bounded browser.

- read the directory with `listConfigurableProviders()`, so a bare-mounted
  adapter's whole installed catalog is offered before any route exists; never
  ship a provider list
- find a profile's credential field by its schemastery `credential-ref` role
  from `describe()`, never by a field name this frontend knows
- write a secret only through `ctx.credentials`, and settings only as a path op
  carrying the revision the row was read at
- render `ctx.authorization`'s neutral notice and prompt vocabulary generically,
  implementing no provider's login; a notice goes to native scrollback because a
  sign-in URL and a device code are made to be copied
- keep the provider and sign-in sections separate, because Harness publishes no
  correlation between a credential record and a provider route — the same
  refusal Work makes for jobs and subagents

Because both surfaces write the same namespace and the same reference, a change
made in the terminal is visible on the official web Models page and the other
way round, and `/model` sees a newly activated route's models with no further
step. `/model` stays what it was: choosing among models that already exist.

Still ahead for Connect:

- declaring a route the owning adapter ships nothing about — a gateway, a
  self-hosted server — which needs an endpoint, a protocol, and a model list
- endpoint interrogation through `ctx.llm.discoverModels()`, which only becomes
  useful once a hand-declared route can be created here
- editing a live route's model list and transport fields
- converging on external settings and credential changes without the manual
  refresh, once those seams' events are type-visible to this package

### 5. Attachments

Evolve terminal gestures into actual Harness attachments when the capability
supports them:

- image and file attachment UI through Harness attachment infrastructure
- durable, authorized references rather than base64 or TUI-specific persistence
- let `@path` evolve into an attachment gesture only where that is the right
  Harness-backed meaning, rather than pretending text completion attached data

### 6. Permissions and approvals

Expose the authority Harness defines; do not invent a frontend policy. A useful
human control needs the owning capability's lifecycle, authorization,
scheduling, and model-awareness contract — the same rule demonstrated by Work.

### 7. More asynchronous capabilities

After the relevant upstream contracts are ready, present more Harness-owned
asynchronous work:

- persistent terminals
- workflows
- later, Agent Teams when their upstream contract is mature enough

### 8. TUI extensibility

Only after several internal capability adapters have proven the vocabulary for
lifecycle, authority, and layout should dshline consider a public contribution
API. A possible small `dshline-api` is a future option, not a current
commitment. `TuiSlots` and overlays remain experimental pre-1.0, and persistent
third-party rows need a global live-region layout budget first.

## Robustness is capability work

Feature count is not worth breaking the terminal model. Ongoing priorities are:

- macOS and Windows real-terminal verification
- Linux PTY coverage
- resize torture tests and narrow-terminal behavior
- resume lifecycle correctness
- teardown and terminal restoration
- Unicode, CJK, and wide-character correctness
- compatibility with rapidly moving Harness releases

## Upstream compatibility strategy

Harness compatibility is an engineering responsibility, not a release-day
surprise. The repository already has a weekly typecheck probe against the
upstream default branch. The direction is to maintain a layered compatibility
matrix:

1. a supported Harness peer floor;
2. the current released Harness; and
3. a Harness `main`/`master` probe for early warning when surfaces such as jobs,
   subagents, commands, session projections, attachments, or session query
   change.

The bleeding-edge probe can be non-blocking while it depends on an external
moving branch, but it should make incompatibility visible quickly and lead to a
conscious update or support decision.

## Current limitations

- **No themes.** One color palette is currently shipped.
- **`ctrl-o` affects new output only.** Committed native scrollback is never
  reformatted; the newest truncated tool card can instead open a bounded
  inspector, at any detail level and with a far larger row budget than the card
  itself had. Only the newest one: an older truncated card scrolled past is not
  reachable.
- **`/connect` cannot declare an unknown route.** It configures and activates
  what a mounted adapter already declares configurable; a private gateway or
  self-hosted server still needs a `settings.yaml` profile naming its endpoint,
  protocol, and models.
- **`/connect` converges on route changes, not on every external edit.** It
  re-reads on `llm/adapters-updated` and after its own writes; a `settings.yaml`
  edited by hand or a key stored from the web interface needs `ctrl-r`.
- **Forgetting a sign-in is local.** Harness has no place for a provider to
  declare a server-side revoke, so deleting the credential record does not tell
  the issuer.
- **`@path` inserts text, not an attachment.** Completion names a path for the
  model to read; it does not attach its content.
- **Tool calls are not reviewed by default.** The Harness deployment decides
  sandbox and approval policy; see [Usage → Permissions and the sandbox](docs/usage.md#permissions-and-the-sandbox).
- **A goal can start without a `/goal` command.** `/goal <objective>` starts a
  Harness goal-driver run, and the harness also publishes `create_goal` as a
  model-callable tool that may infer the intent from an ordinary request. Either
  way the status line names the objective for as long as one is live; inspect or
  pause a goal before leaving one running.
- **One session at a time per window.** `/sessions` reopens a session in place
  rather than beside the current one; there are no tabs, split panes, or
  side-by-side agents.
- **Reopening waits for quiet.** A window refuses to reopen a session while a
  turn is running or while jobs or subagents are attached to the one being left,
  because no generic seam defines what happens to work whose owner is retired.
- **Content search depends on the deployment.** Full-text session search is the
  session-query engine's abstract surface; a backend that implements none leaves
  `tab` reporting that, and filtering still works.
- **Linux is the verified platform.** macOS and Windows terminal behavior still
  need broader real-terminal evidence.

## Explicit non-goals

- another agent runtime
- another job runtime
- provider-specific subagent engines
- parsing rendered tool output for structured state
- replacing Harness persistence or session search
- replacing native terminal scrollback
- cloning Claude Code or Codex feature-by-feature
- a stable public TUI SDK before internal adapters prove one
