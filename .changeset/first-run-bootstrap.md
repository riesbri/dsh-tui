---
'@dshline/dshline': minor
---

`dshline` now sets itself up on a first run: with no `dshline` profile yet, it asks once and — with a yes — has Harness create and install the profile (`dsh plugin --profile dshline add @dshline/dshline`) before continuing into the launch that was asked for, so `npm install -g @deepseek-ai/dsh @dshline/dshline && dshline` is the whole install. An explicit `--profile` opts out, a profile that already exists is never repaired, and a non-interactive run says to use `dshline --setup` rather than installing packages unasked. `dshline --version` and `dshline -V` now answer with this package's version, with no harness, profile, or terminal needed; the wrapper also runs correctly when reached through a symlink, which is how npm installs it.
