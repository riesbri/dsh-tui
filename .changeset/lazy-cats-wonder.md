---
"dshline": minor
---

Say what the goal is, and what a long turn is doing.

The goal segment read `goal 0/256` — a round cap the reader never chose, against a
count that had not moved, for an objective it never named. It now leads with the
objective (`goal armed · ship the release`) and reports the count only once a round
has actually been taken. This matters because a goal is not always something the user
set: the harness publishes `create_goal` as a model-callable tool and tells the model
it may infer a long-running objective without being asked, so a session can acquire
automatic continuation authority that was never typed. The status line is where that
becomes visible, and it now says what it is.

The objective is the one part of a mode that may be surrendered on its own as the
terminal narrows — it is prose, so a shorter one is still true, where a shortened
round count would be a different number. Everything else about the drop order is
unchanged.

The working segment also names the tool the turn is waiting on
(`⠙ working 14m 26s · run_shell_command +2`). Elapsed time alone reads the same whether
a command is running or the session has hung. The harness dispatches concurrency-safe
calls in parallel, so the count says how many others are outstanding rather than
naming one of them as though it were the only one. The elapsed time stays the turn's:
nothing claims a duration for any single call, because the harness publishes none.
