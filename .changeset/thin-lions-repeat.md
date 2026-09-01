---
'@dshline/dshline': patch
---

Narrow the Harness peer ranges to the one adopted Harness generation.

dshline now targets a single Harness architecture at a time, recorded as one
upstream commit and one npm version in `HARNESS_TARGET`. The `dsh-*` peer
ranges carried a second `|| ^0.1.2-alpha.2` arm left over from maintaining
several published Harness lines at once, and that arm promised a generation
this bundle no longer compiles against — `0.1.2-alpha.4` removes `Session.events`,
which `packages/dshline/src/questions.ts`, `src/context/model.ts`, and the
window and activity paths all read. Package metadata is part of the
compatibility promise, so the range now claims only what CI actually proves.

No runtime behaviour changes. Installing beside a `0.1.1-rc.2` Harness is
unaffected; installing beside a `0.1.2-alpha.*` Harness now reports a peer
warning instead of silently claiming support.
