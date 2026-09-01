---
'@dshline/dshline': minor
---

`ctrl-r` searches what you have sent this session. Type to filter your own prompts and slash commands — a plain case-insensitive substring, newest match first — press `ctrl-r` or `↓` for the next older match and `↑` for a newer one, and `↵` puts the selected line back in the input box **without sending it**, so you can edit it before you commit to it. `esc` leaves the box exactly as it was, cursor included, because the search never writes to it in the first place.

A recalled line keeps its place in the history: `↑` from there continues to the line before it and `↓` walks forward to the half-typed draft you had before searching, and two non-adjacent submissions of the same text stay distinct, because a result is a historical position rather than a string. Long and multiline prompts are previewed around the line that matched rather than by their first line, so a result never appears to match for no visible reason. Pressing `ctrl-r` during a resume says the history is still loading rather than claiming there is none, and resolves whatever you have typed the moment the replay's own seeding lands — no extra read of the session.

Scope is deliberately narrow: this session's submitted input, the same lines `↑` already walks. No cross-session search, no history file, no fuzzy ranking; `/sessions` remains where past conversations are found. The overlay is a bounded live-region surface, so committed scrollback is never rewritten, and `ctrl-r` still belongs to whichever overlay owns input — `/connect` keeps its refresh.
