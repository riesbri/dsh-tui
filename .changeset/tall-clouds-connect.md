---
"@riesbri/dsh-tui": minor
"@riesbri/dsh-tui-renderer": minor
---

Add `/connect`, a Harness-native provider configuration browser.

`/model` chooses among models that already exist; `/connect` is how a model comes
to exist. It joins four Harness surfaces — the configurable-provider directory
and registered routes from `ctx.llm`, the user-settings document through
`ctx.settings`, credential presence through `ctx.credentials`, and the login
flows on `ctx.authorization` — into one bounded overlay, and configures them
through the seam that owns each.

There is no provider list and no login protocol in this frontend. A route is
offered because a mounted adapter declared it configurable, a profile's
credential field is found by its schemastery `credential-ref` role rather than
by a field name, and an authorization flow is rendered from the seam's neutral
notice and prompt vocabulary, so a surface that renders one flow renders all of
them. A sign-in page and device code are committed to native scrollback, where
they can be selected and copied.

Because both write the same settings namespace and the same credential
reference, a change made here is visible on the official web Models page and the
other way round, and `/model` sees a newly activated route's models with no
further step.

The renderer gains `ctrl-r` in its key tables, which the browser uses to ask
Harness again.
