# Changesets

Changesets record package-version changes for the next release. Add one with
`pnpm changeset`; the version workflow consumes committed changesets when it
opens the `Version Packages` pull request.

Both published packages are in a fixed group, so each changeset versions
`@dshline/dshline` and `@dshline/renderer` together.

## Release channel

Changesets accumulate normally even while `main` tracks a Harness generation
newer than the one npm serves by default, and the generated `Version Packages`
pull request may sit release-channel-incoherent for as long as that lasts. That is the
design, not a problem to route around: `main` adopting a generation early is
the point, and dshline never carries compatibility code for the previous one.

Do not merge that pull request until its **Release channel · Harness latest**
check passes. It compares `HARNESS_TARGET.version` with
`@deepseek-ai/dsh@latest` by exact equality, because the documented install
resolves both packages through npm's default tag and publishing a mismatched
pair would break it. The same check runs again before the release tag and
before the first publish.

If it is red, either wait for DeepSeek to promote the adopted generation, or
migrate `HARNESS_TARGET` onto whichever generation it actually promoted — a
default channel that has moved past the adopted target fails too. Never widen a
peer range, point the check at another dist-tag, or move dshline off `latest`
to get around it.
