---
'@riesbri/dsh-tui': patch
---

Accept the published Harness `0.1.1-rc` line in the peer ranges.

The peers said `^0.1.0-rc.7`, which under npm's prerelease rules rejects every
`0.1.1-rc.x` package — npm ranges only match prereleases whose
major.minor.patch tuple appears inside the range itself. The harness now
publishes its moving line as `0.1.1-rc.x`, so installing this bundle next to a
current harness produced unmet-peer warnings and ERESOLVE errors even though
the bundle runs fine, which the weekly compatibility job could not see because
it only typechecks against unreleased master source.

The ranges are now `^0.1.0-rc.7 || ^0.1.1-rc.2`: both lines the full suite has
been run against, and nothing newer. Type dependencies follow the registry
again (`next` everywhere; cordis reads `latest`, whose stable 4.0.1 is what the
current line builds on), and the released-line job in the harness-compatibility
workflow plus `pnpm check-peers` keep the metadata honest from here on.
