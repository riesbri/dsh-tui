---
'@dshline/dshline': minor
---

`/work` becomes a live execution cockpit with three separate Harness
authorities: Workflows, Subagents, and Jobs. Harness workflow runs now appear
with their name, current `phase(...)` narration, open-member count, and started
count, and entering one shows its description, declared phases, state, newest
log line, and its published members grouped under the exact phase each was
recorded with. A member whose child is still live opens that child's own
subagent view, carrying its workflow, phase, and member label — the join is
Harness's own `childId`, never a guess, and that same authority is why the
child is presented under its workflow instead of a second time in the flat
Subagents section.

Workflow ownership comes from this session's own durable `tool-workflow/*`
records, because a raw `workflow/*` event names a run and never the Session
that asked for it; live workflow events are accepted only for a run those
records already proved, and only as enrichment. Another window's orchestration
cannot appear here, and a run's row leaves when the tool closes its durable
record after the run and its children are quiescent.

Spinner semantics are now honest: the arc spinner means dshline holds evidence
of running computation — a live in-process child Agent Harness reports as
`running`. A Job in `running` keeps a quiet `•` (a stopping Job keeps `◐`), a
subagent whose provider publishes no in-process child keeps `●`, and a workflow
animates only while one of its own members does. Settlements read `✓`, `✗`,
and `⊘`.

Detail views are real inspectable lists: `↑`/`↓` move a visible cursor through
the facts of a workflow, subagent, or job view instead of scrolling underneath
a stuck highlight, `home`/`end` jump to its ends, and the view scrolls to follow
the cursor. `↵` on a plain fact does nothing rather than inventing an action,
`esc` returns exactly one hierarchy level, and an aimed row that disappears
before a keystroke acts on nobody rather than on its successor. The subagent
view now leads with what the child is doing; the job view drops the row that
only announced an action it does not have.
