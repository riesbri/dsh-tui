---
'@dshline/dshline': minor
---

`/connect` now curates a pi-ai route's request headers, so a gateway that
authenticates with anything other than the field carrying the `credential-ref`
role can be declared and repaired from the terminal instead of by hand in
`settings.yaml`. `Request headers` appears on both the route editor and the
`+ Add custom provider` review, adds and removes entries, and writes one
`set`/`unset` op at the route's own `headers` path — every sibling field this
pass does not render (`compat`, retry policy, per-model reasoning) survives an
edit untouched, the same way the other curated fields already behaved.

The field name is knowledge this presentation module is allowed to hold; its
SHAPE is not. `headersCurated()` offers the editor only while the namespace's
own serialized schema still describes `headers` as a dict of strings — the same
fail-closed check that makes an unreadable `api` union produce no protocol
choices rather than a stale list — so a namespace that reshapes the field gets
no header editor instead of a write `settings.mutate` would refuse. A candidate
name or value is checked by handing it to the platform `Headers` constructor,
which is the standard `PiAiProviderProfile.headers` is documented as validated
against; Harness stays the authority, and a refusal from `settings.mutate` is
still what a reader is shown.

A header value can be an `Authorization` bearer or a signed gateway token, and
nothing in the settings seam marks it as one: `headers` carries no
`credential-ref` role, so `redactSecrets` does not strip it and it is stored in
`settings.yaml` as ordinary configuration. That places the field outside
Harness's redaction contract; it does not make what it holds harmless, and this
frontend cannot tell a token from a tenant tag. So every value is treated as
sensitive on screen — the route menu lists names alone, and a value appears
only once a reader has opened `Request headers` and moved onto that header's
row, which is the one place they asked to see it. The route's own action is now
called `Edit route` rather than `Edit endpoint and models`, since endpoint and
models are no longer all it edits; its id and its behaviour are unchanged.

Model discovery is unchanged and still goes through `ctx.llm.discoverModels()`
alone. `LlmModelDiscoveryRequest` names a provider, an endpoint, a protocol and
a one-shot key and nothing else, so headers reach an endpoint only through the
owning adapter's own resolution of the STORED profile. Both places that is
visible now say so rather than letting a fetch look like an endpoint refusal:
an unsaved header edit is not sent with a fetch on an existing route, and a
route still being declared has no stored profile to resolve from at all.

`docs/usage.md` gained the route declaring/editing section it had been missing
since Connect 2.0 — it still described `/connect` as covering credentials and
activation only, and pointed at `settings.yaml` for work the terminal has done
since.
