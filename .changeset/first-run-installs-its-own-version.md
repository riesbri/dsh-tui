---
'@dshline/dshline': patch
---

A first run now installs the version of dshline that asked for it. The wrapper
names its own exact version to `dsh plugin add` and passes dshline's release-age
window to the harness's pnpm on the command line, instead of asking for the bare
package name and letting pnpm choose.

The bare name was silently choosing wrong. pnpm 11 carries a built-in
release-age default, so hours after `0.16.0` reached npm's `latest`, a fresh
profile still resolved `@dshline/dshline` to `^0.15.0` — and a `0.16.0` wrapper
booted a frontend one release behind itself against a Harness generation that
release had never seen. Naming the version fixes which release is installed;
stating the window is what makes pnpm treat a version that is still too young as
something to decide about rather than something to quietly exclude from the
policy: on a terminal it asks before it would proceed, and where there is nobody
to ask it refuses. Both stop the setup and start nothing, which is the outcome
the silent downgrade was hiding.

The window itself moves from three hours to two, in `pnpm-workspace.yaml` and in
the wrapper, which are now checked against each other. `dshline --setup <source>`
is unchanged: a caller who named a checkout has already chosen what to install.
