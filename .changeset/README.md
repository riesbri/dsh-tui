# Changesets

Changesets record package-version changes for the next release. Add one with
`pnpm changeset`; the version workflow consumes committed changesets when it
opens the `Version Packages` pull request.

Both published packages are in a fixed group, so each changeset versions
`@dshline/dshline` and `@dshline/renderer` together.
