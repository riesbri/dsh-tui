---
'@dshline/dshline': patch
---

Accept the published Harness `0.1.1-rc` line in the peer ranges, and pin
development dependencies to the exact currently published Harness versions.

The peers said `^0.1.0-rc.7`, which under npm's prerelease rules rejects every
`0.1.1-rc.x` package — npm ranges only match prereleases whose
major.minor.patch tuple appears inside the range itself. The harness now
publishes its moving line as `0.1.1-rc.x`, so installing this bundle next to a
current harness produced unmet-peer warnings and ERESOLVE errors even though
the bundle runs fine, which the compatibility workflow could not see because it
only typechecked against unreleased master source.

The ranges are now `^0.1.0-rc.7 || ^0.1.1-rc.2`: both lines the full suite has
been run against, and nothing newer. Development dependencies are pinned to
the exact authoritative published versions — the harness line under its `next`
tag, cordis under `latest`, whose stable 4.0.1 is what the whole current line
builds on — and a daily job re-pins them (`pnpm run sync-harness`), re-verifies
the peer ranges (`pnpm run check-peers`), and boots the packed plugin beside
the published launcher, so metadata can no longer drift from reality silently.
