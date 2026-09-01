---
'@dshline/dshline': minor
---

Add Harness-native skills: `/skills`, skills in the `/` menu, and a leading `/name` line that actually reaches the agent.

A message beginning with a skill's name after a slash used to be swallowed by the unknown-command guard, so Harness's own human invocation gesture never reached the model. A leading `/name` is now adjudicated in one order — this frontend's commands, the harness's registered commands, then the skills the running agent can see — and a user-invocable skill's line is sent verbatim for `dsh-tool-skill` to interpret. Commands still win a shared name.

`/skills` browses every skill the agent can see, with its description, who may invoke it, its source, and any "when to use" guidance; `enter` puts `/name ` in the prompt without sending it. User-invocable skills also appear in the `/` suggestion list beside the commands. dshline never discovers, loads, injects, or caches a skill body: it observes `ctx.skills.snapshot({ cwd, scope: agent })`, keeps the last complete catalog through a transient provider failure, and refetches on `skills/change` and after a preset recompose. Skills stay an optional capability — a profile that composes no registry says so.
