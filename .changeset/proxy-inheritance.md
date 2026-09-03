---
'@dshline/dshline': patch
---

Document how dshline behaves behind a network proxy, and pin the part of it
this frontend actually owns.

Outbound traffic is Harness's: DSH reads the standard proxy variables at launch
and routes model calls, web search, page fetches, and HTTP MCP through them, so
`dshline` configures nothing of its own and `docs/install.md` now says so and
links upstream's own guide — including the two things people lose an afternoon
to, that an operating-system "system proxy" switch is invisible to
command-line tools, and that a SOCKS URL is reported and skipped rather than
used.

The part that is this frontend's is `/profiles`, which installs and removes
bundles by running `dsh plugin` and therefore pnpm. Those children run under
Harness's environment scrub plus `childEnvironment()`'s own restore, and a
regression test now spawns a real child through the real subprocess seam to
prove `HTTPS_PROXY`, `NO_PROXY`, pnpm's `npm_config_*` spellings, and
`NODE_EXTRA_CA_CERTS` all arrive — so a `/profiles` install keeps working on a
corporate network with a TLS-intercepting proxy. The existing test that Harness's
own API key does NOT reach those children still stands beside it.

No behaviour change: this was already true, and is now proven and written down.
