---
"@riesbri/dsh-tui": minor
"@riesbri/dsh-tui-renderer": minor
---

Bound the shared picker to the terminal, and let it be searched when it is long.

`/model` over a gateway route offers whatever the provider advertises, which for
OpenRouter or opencode is hundreds of models. The picker drew a row per choice,
so it handed `Screen` a live region taller than the screen — and rows that have
scrolled off cannot be reached or erased, which left duplicates in real
scrollback and could clear output the picker never owned. The list is now a
viewport over its rows, exactly as Work, Sessions, and Connect are.

Past twelve choices it also grows a query box and filters as you type, with a
counter that reports what the query left and what was offered separately. Below
that nothing changes: a three-choice approval spends no row on a search box and
typed characters stay meaningless there. A terminal too small to hold the frame
now falls back to the selected choice and its keys rather than an unanswerable
list, because an approval can arrive in any geometry.

`/model`'s rows are now spelled `provider/model` — the argument the command
accepts — with the provider's own display name under the selection when it adds
something beyond the id. Filtering matches the label, so what you type is what
you can see.
