---
'@dshline/dshline': minor
'@dshline/renderer': minor
---

Expose Harness's Queue and Steer delivery as a reader's choice, and teach the empty composer to say which one is in force.

Pressing `enter` while a turn runs used to call whichever Agent verb the agent's status made available, which was always `steer` — so every busy submission joined the reasoning already under way and a follow-up turn could not be asked for. It is now a preference. `/enter queue` and `/enter steer` set it, bare `/enter` asks, and the default is `queue`, matching the adopted Harness generation's own Web client. `ctrl-enter` sends the other way for one message where the terminal's enhanced keyboard encoding can distinguish it, and does exactly what `enter` does where it cannot — so nothing is lost or duplicated, and the composer never advertises the key. The choice is stored in the `dshline` settings namespace beside the theme, so it survives reopening a session; a profile with no settings provider keeps it for the process and says it could not be stored.

The empty composer now reads `ask anything · / menu` when idle and `type to queue` or `type to steer` while a turn runs, shedding whole segments as the terminal narrows. That also fixes a latent overflow: the hint used to be fitted with a wrapping helper, so below nineteen columns the empty composer drew an extra row it had not budgeted for, which on a short terminal pushed the live region past the screen.

The status line's pending-input segment now names which of Harness's two boundary lists is waiting — `1 queued`, `1 steering`, or `2 pending` for a mixture — read live from the agent's inbox rather than counted from submissions. `ctrl-c` still discards pending input along with the turn, and now says how many prompts went with it.
