---
'@dshline/dshline': minor
---

`dshline` now sets itself up on a first run: with no `dshline` profile yet, it asks once and — with a yes — has Harness create and install the profile (`dsh plugin --profile dshline add @dshline/dshline`) before continuing into the launch that was asked for, so `npm install -g @deepseek-ai/dsh @dshline/dshline && dshline` is the whole install. An explicit `--profile` opts out, a profile that already exists is never repaired, and a non-interactive run says to use `dshline --setup` rather than installing packages unasked.

`dshline --version` and `dshline -V` now answer with this package's version, with no harness, profile, or terminal needed. On Windows the launcher npm installs is a `dsh.cmd` shim, which is now run through `cmd.exe` with each argument quoted for it, so a first task keeps its spaces, quotes, and `cmd` metacharacters; an argument containing a line break is refused there with an explanation, because a `cmd` command line cannot carry one.
