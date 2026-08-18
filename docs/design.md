# Design

How the frontend is built, and why each part is built that way. Every heading below is a decision with a wrong answer that looked reasonable.

> Working on the code? [`AGENTS.md`](../AGENTS.md) turns the invariants below into rules you can follow without reading this page.

## Contents

- [Two packages](#two-packages)
- [The screen appends and redraws one region](#the-screen-appends-and-redraws-one-region)
- [A reply is written as it finishes, not when it ends](#a-reply-is-written-as-it-finishes-not-when-it-ends)
- [Reasoning is shown while it happens](#reasoning-is-shown-while-it-happens)
- [Typing is completed from what the harness actually has](#typing-is-completed-from-what-the-harness-actually-has)
- [Tool output is drawn the way the tool asked](#tool-output-is-drawn-the-way-the-tool-asked)
- [The status line degrades instead of truncating](#the-status-line-degrades-instead-of-truncating)
- [Widths follow Unicode East Asian Width](#widths-follow-unicode-east-asian-width)
- [Measuring and cutting agree about escape sequences](#measuring-and-cutting-agree-about-escape-sequences)
- [Untrusted text is escaped before it reaches the terminal](#untrusted-text-is-escaped-before-it-reaches-the-terminal)
- [Markdown is rendered, and escaped as it is parsed](#markdown-is-rendered-and-escaped-as-it-is-parsed)
- [Pasted input is untrusted too](#pasted-input-is-untrusted-too)
- [Keys are decoded in both encodings](#keys-are-decoded-in-both-encodings)
- [Commands report what they did](#commands-report-what-they-did)
- [The chrome is plugins too](#the-chrome-is-plugins-too)

## Two packages

Split so the drawing half never learns about agents:

| Package | Owns |
| --- | --- |
| [`@riesbri/dsh-tui-renderer`](../packages/renderer) | Display width, key decoding, the input buffer, box drawing, and the screen. Imports nothing from the harness, so it is testable with no terminal and no model. |
| [`@riesbri/dsh-tui`](../packages/tui) | The bundle: the session loop, the transcript projection, the interaction seams, and the slot registry. |

The boundary is load-bearing rather than tidy. The renderer has no dependencies and no peers, which is what lets the bundle add nothing to a profile's dependency tree, and it is why every rule on this page about width, cutting, or escaping can be tested without a harness.

## The screen appends and redraws one region

A chat transcript only grows, so the renderer owns no full-screen buffer. Finished output is written into the terminal's scroll buffer and never touched again; only the bottom live region — a streaming reply, a prompt, the composer — is redrawn in place. Scroll position is therefore never modelled and never reflowed on resize.

The invariant that makes it correct: the live region is the last thing on screen, so every write goes through `Screen`.

This is also why the alternate screen is never taken. Scrollback, mouse selection, and copy behave exactly as in any other command rather than being reimplemented inside the interface.

## A reply is written as it finishes, not when it ends

Each completed line goes into scrollback the moment its newline arrives, and only the unfinished trailing line stays in the live region.

That is a performance property and a behavioural one: the region does not grow with the reply, so redraw cost stays flat instead of quadratic in the answer's length, and a reply longer than the window scrolls the terminal normally rather than being clipped to a fixed tail. The assembled message then contributes only what streaming could not have shown, which is what keeps a reply from printing twice.

## Reasoning is shown while it happens

Reasoning models emit `reasoning-delta` chunks for as long as they think, which can be most of a turn. Those are rendered quietly above the answer, dimmed and italic, so the screen shows the model working rather than a spinner over an empty region.

## Typing is completed from what the harness actually has

`/` lists the commands this agent really registered, from `ctx.commands.list`; `@` lists real directory entries through `ctx.fs`. `tab` accepts, the arrows move, `esc` dismisses.

It is not an overlay — an overlay owns the keyboard, and completion has to coexist with typing — so it claims only its own gestures and never `enter`, and the list narrows as you type rather than trapping the line. A slash completes only at the start of a line, because `/help` is a command and `see /etc/hosts` is a path. Only the text behind the cursor is considered: completing against what is ahead of it would rewrite characters nobody asked about.

An accepted candidate is sanitized exactly as a paste is. A file name can contain anything a filesystem permits, and the composer's lines reach the screen without being escaped again.

## Tool output is drawn the way the tool asked

A tool declares its render intent through `presentCall` and `presentResult`, and those are pure functions of the call's arguments, so a frontend may call them freely.

A shell command becomes a framed card headed by its working directory with its exit status on the output frame; a mutation becomes a diff in red and green; a search groups its matches under each file; a read keeps the file's own line numbers. A tool that declares nothing still renders — every intent is documented to degrade to raw content — and no card is ever invented for a tool by name.

A mutation tool returns its diff from *both* presenters, because a completed card is meant to replace the pending one. On an appending screen it is drawn once, at result time, which is also the more truthful of the two: it is what landed.

`ctrl-o` cycles how much of a card is drawn: `compact`, `full`, `hidden`. `hidden` still draws the call, and still shows a non-zero exit, because a transcript that omitted them would lie about what ran.

## The status line degrades instead of truncating

Context pressure shows as a bar beside the reading — `██████░░ 6.2k/8.0k` — but only once a cell would actually fill. A DeepSeek window is a million tokens, so a linear bar reads as empty for every session anyone really has, and an always-empty bar spends columns to say nothing; a non-linear one would fill sooner and lie about proportion. The fill is floored, because a bar showing full at 94% overstates the one thing it exists to report.

As the terminal narrows, hints drop whole rather than being cut in half — `ctrl-d qui` reads as a rendering fault, not as a hint — and the model name goes before the pressure reading does, because the model does not change during a session and the reading does.

## Widths follow Unicode East Asian Width

The harness is bilingual; its shipped agent presets are named in Chinese. A CJK ideograph measured as one column corrupts every row in the buffer, not only the row holding it, so the redraw arithmetic counts *rendered* rows and a wrapped or CJK line is climbed correctly.

## Measuring and cutting agree about escape sequences

`displayWidth` ignores them, so `wrapToWidth` and `truncateToWidth` do too: they tokenize into zero-width escapes and visible characters, never cut inside a sequence, and reopen styling on a continuation row. A styled line that measured wider than it drew would wrap early, taking every framed row with it.

A cut also closes what it opened. Discarding the reset at the end of a truncated span left its colour open, and the next thing drawn inherited it — a dim italic reasoning row bleeding into the composer below.

## Untrusted text is escaped before it reaches the terminal

Everything a model, a tool, or a session log produces is untrusted for terminal purposes: an escape sequence in tool output could repaint the live region, and a carriage return could reposition the cursor. Such text passes through `escapeControls` and is shown in caret notation. Styling is a separate function, applied only to strings this frontend composes itself.

A path that reaches the terminal unescaped is a vulnerability here, not a rendering bug.

## Markdown is rendered, and escaped as it is parsed

Replies come back as headings, emphasis, inline and fenced code, lists, quotes, rules, and links — a deliberately small subset, hand-rolled in `packages/renderer/src/markdown.ts`, because a parser dependency would cost the zero-dependency property.

Emphasis follows CommonMark's flanking rules, with one deliberate deviation. A delimiter followed by whitespace cannot open and one preceded by whitespace cannot close, so `2 * 3 * 4` stays arithmetic; underscores may not touch a word, so `snake_case_name` and `file_name.ts` stay intact. The deviation is that `__init__` is left literal rather than read as emphasis: in a reply about code that is a dunder far more often, and corrupting a name the reader may need to type costs more than losing emphasis. Multi-word `__bold text__` and single `_italic_` both still work.

The ordering is the security rule: every span is escaped *before* styling is applied, never after. `escapeControls` neutralises the escape character itself, so running it over already-styled output would destroy the styling, and running it over only some spans would let a control sequence through everywhere else. A model can emit one in prose, in a heading, in a link target, or inside a fence, and each is covered.

## Pasted input is untrusted too

People paste logs, so a paste is the most likely source of terminal controls in the whole interface. Pasted content is sanitized at the point of insertion rather than at each place it is later measured or drawn: line endings normalize to `\n`, tabs expand to spaces, and remaining controls become caret notation.

Tabs are expanded everywhere, not only here: a tab is one character the terminal advances to the next stop, so leaving one in place makes every width helper disagree with the screen — a framed row pads to the wrong width and its right border shifts. One representation in the buffer means every width, cursor, and draw calculation reads the same text the terminal receives.

Bracketed paste is what makes a multi-line paste one message instead of a burst of Enter keys. A paste arriving in chunks is held until its terminator, however long that takes: a slow paste and a dead one are indistinguishable, and cutting a real one turns the rest of the document into submitted fragments.

## Keys are decoded in both encodings

Telling `shift-enter` from `enter` requires the terminal's cooperation, so on launch the renderer asks for the kitty keyboard protocol's lowest flag, `disambiguate escape codes`.

That request is not additive. A terminal that implements it stops sending the legacy encodings for `esc`, `alt`, and **`ctrl`** combinations entirely: `ctrl-c` becomes `CSI 99 ; 5 u` and never `0x03` again. So both encodings are decoded, and the enhanced table is *derived* from the legacy one rather than written out beside it — a gesture is its control byte plus `0x60`, so a key added to one encoding is recognised in the other without a second edit. A gesture known only by its control byte is dead on precisely the terminals where the mode works, which is not a fallback but a regression.

`enter`, `tab`, and `backspace` are the protocol's own exceptions and keep their bytes when unmodified. xterm's `modifyOtherKeys` form is read as well, because which encoding arrives is not the user's problem. The mode is popped on exit, so the next program reads its input as it expects to.

A lone trailing `ESC` is held rather than decided, because it is the first byte of every sequence the decoder recognises, the paste delimiters included. A short idle resolves it: by then the terminal has stopped writing, so the byte was the Escape key.

## Commands report what they did

A command runs without a model turn, so its own result is the only thing that says it happened — there is no reply to read and no card to look at. Results are committed to the transcript as a note, or as `✗` on failure, because a command that fails silently is indistinguishable from one that is broken.

`sourceEventSeq` marks a result whose domain event carries a richer presentation, and is deliberately not honoured as a reason to stay quiet: this frontend projects no domain events, so deferring to one would keep the command invisible.

`/exit`, `/quit`, and `/model` are answered by the frontend rather than registered with `ctx.commands`. That registry is shared by every surface in the process, and a web client or the automation server has no terminal to leave and no picker to open. They appear in the `/` menu beside the registered commands anyway, because someone typing `/` wants to see what they can type, not which registry it came from.

A line that parses as a command but names nothing registered is reported as unknown rather than sent to the model, using the registry's own parser so the two cannot disagree about what a command line is.

## The chrome is plugins too

The banner, composer, status line, and every overlay are independent registrations into `ctx.tuiSlots` — the terminal's equivalent of the web client's `ctx.slots`. Slots are positional (`stream`, `composer`, `completion`, `status`), so a view chooses where it sits by naming one, and whichever view owns text entry reports where the cursor belongs.

```ts
ctx.tuiSlots.register('status', { render: () => ['my widget'] })
ctx.tuiSlots.pushOverlay(myPrompt)   // takes the whole region and every key
```

Overlays stack, and only the topmost one renders and receives keys, so a question raised while an approval is pending does not interleave with it. `ctrl-d` is read before the overlay, because leaving means the same thing everywhere.

## Sessions and resume

Sessions are written to the harness's own session store, so a transcript survives exit. `--resume` rebuilds it from the raw log and replays it through the *same* projection the live view uses, so a reopened session reads exactly like the one you watched happen — reasoning, diff cards, tool output and all. Two projections would have drifted the first time either changed.

What it replays is append-origin events, deliberately **not** the model-visible surface: that surface shadows ranges a compaction replaced, so folding it would erase conversation you had already read. The reply is gone from the model's history, but it was still said.

A resumed session keeps the workspace it was created in. The persisted header is the authority, so `-C` is ignored on resume rather than silently re-rooting the conversation.
