---
"@dshline/dshline": minor
---

Add `/profiles`, a terminal browser over Harness's own profile layer — the roster under `$DSH_HOME/profiles`, which profile this Host booted, and each profile's ordered `dsh.profile.bundles` layers with the installed version wherever pnpm's state already records one. It reads through Harness's own `dshHomePath` service and the Loader's base URL, and forwards every mutation to `dsh plugin --profile <name> …`, so pnpm invocation and `dsh.profile.bundles` reconciliation stay Harness's. No installer, resolver, package registry, or lockfile behavior is added here.

Restart boundaries are stated rather than implied: a bundle change alters what the *next* Host composes, so a change to the running profile reports `restart required` and a change to any other names the command that picks it up. Switching profiles is not offered at all — nothing re-links a composed Host's bundle layers, so `enter` on another profile names the command that boots it.

`/plugins` now shows capability health where it can be proven from Harness state. A profile PROVIDES capabilities and a preset EXPOSES them, so an enabled row is not evidence that its backing capability exists; a row naming a provider that a mounted Host registry does not supply is marked `⚠` and says so. The check is a data table of capability modules read against `ctx.subagents`, not a branch per provider: a module the table does not cover, a `!!js` provider that is never evaluated, and a profile mounting no such registry all produce no verdict rather than a guess.

`enter` now toggles a plugin row exactly as `space` does, outside search mode, where `enter` still means "done typing".

**Breaking for anyone who typed it:** `/profile` is now `/timing`. It only ever toggled the per-turn time breakdown, and a Harness *profile* is the composition a launcher boots — the word now belongs to `/profiles`.
