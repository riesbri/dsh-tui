---
'@dshline/dshline': minor
---

`ctrl-o` reaches truncated tool cards you have already scrolled past.

A compact card commits its elided rows straight into native scrollback, where nothing can recover them, so the inspector was their only way back — and it held exactly one card. The next tool call took the offer over, and a result you scrolled past was gone for good.

The last twelve truncated cards are now retained, newest first. `ctrl-o` still opens the newest unseen card and is still one-shot, which is what keeps the `compact → full → hidden` toggle a single keystroke away; reaching an older card is a deliberate second gesture, made with `ctrl-o` from inside the inspector. The title counts your place (`Tool output 2/6`), the hint advertises the step only while an older card exists, and stepping stops at the oldest rather than wrapping.

A newer short result or an error no longer discards the history. That discarding existed only to stop one stale offer from capturing `ctrl-o` forever, which marking an offer consumed now handles instead.

The retained history is bounded on purpose: an unbounded list of call arguments and results would be a second transcript, which is the thing this frontend refuses to keep. Older than twelve, the elision marker beside the committed rows is the honest answer.
