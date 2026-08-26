---
"@dshline/dshline": patch
---

Run `/profiles` launcher processes through the Harness subprocess capability while keeping their authentication semantics: the child environment restores every variable set in the package managers' own namespaces (`NPM_*`, `PNPM_*`, `COREPACK_*`, `NODE_AUTH_TOKEN`) plus the Host-resolved `DSH_HOME` after the seam's credential scrubbing, so private registries authenticating through `${NPM_TOKEN}`-style `.npmrc` references keep working. A relative `$DSH_BIN` is pinned to an absolute path before the seam verifies the launcher.
