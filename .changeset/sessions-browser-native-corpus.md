---
"@riesbri/dsh-tui": minor
---

Add a Harness-native Sessions browser. `/sessions` and `--resume` now open the
same bounded overlay: it lists the `ctx.sessionQuery` corpus newest first with
batched folded titles, filters as you type over titles, workspaces, and ids, and
hands the same words to the engine's full-text surface on `tab` to search what
sessions said — degrading to filtering when a deployment's backend implements no
content search. The selected row shows its workspace, event count, last activity,
lineage, and id, and short badges mark the open session, a live one, a delegated
child, and a fork.

Reopening now works from inside a running window. It retires the current agent
through the owned `AgentHandle` disposer and resumes the chosen session with
`ctx.agents.resume`, appending the replayed transcript into native scrollback
without rewriting anything already committed. It refuses, naming the reason, when
a turn is running, when jobs or subagents are still attached to the session being
left, when the target is already live, or when it has no persisted log. A resume
that fails anyway reports Harness's reason and reopens the browser rather than
ending the process or substituting a session nobody asked for.
