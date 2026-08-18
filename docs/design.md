# Design

How this interface is built, and the reason behind each decision. Every heading below is a choice where the obvious alternative turned out to be wrong.

> Changing the code? [`AGENTS.md`](../AGENTS.md) turns these decisions into short rules you can follow without reading this page.

## Contents

- [Two packages](#two-packages)
- [It prints and updates one small area](#it-prints-and-updates-one-small-area)
- [A reply is printed as it arrives](#a-reply-is-printed-as-it-arrives)
- [Reasoning is shown while it happens](#reasoning-is-shown-while-it-happens)
- [Suggestions come from what the agent really has](#suggestions-come-from-what-the-agent-really-has)
- [Tool output is drawn the way the tool asks](#tool-output-is-drawn-the-way-the-tool-asks)
- [The status line drops details instead of cutting them](#the-status-line-drops-details-instead-of-cutting-them)
- [Character widths follow the Unicode standard](#character-widths-follow-the-unicode-standard)
- [Measuring and cutting agree about escape sequences](#measuring-and-cutting-agree-about-escape-sequences)
- [Untrusted text is made safe before it is drawn](#untrusted-text-is-made-safe-before-it-is-drawn)
- [Markdown is rendered, and made safe while it is parsed](#markdown-is-rendered-and-made-safe-while-it-is-parsed)
- [Pasted text is untrusted too](#pasted-text-is-untrusted-too)
- [Keyboard input is read in both formats](#keyboard-input-is-read-in-both-formats)
- [Commands report what they did](#commands-report-what-they-did)
- [The interface is made of plugins too](#the-interface-is-made-of-plugins-too)
- [Sessions and resuming](#sessions-and-resuming)

## Two packages

The two halves are split so that the drawing code never learns about agents:

| Package | Responsible for |
| --- | --- |
| [`@riesbri/dsh-tui-renderer`](../packages/renderer) | Character widths, keyboard decoding, the input line, boxes, and the screen. Imports nothing from the harness, so it can be tested with no terminal and no model. |
| [`@riesbri/dsh-tui`](../packages/tui) | The plugin: the session loop, turning session events into transcript lines, the harness integration points, and the view registry. |

That boundary earns its keep twice. The renderer has no dependencies of its own, which is what lets this plugin add nothing to a user's setup. And because it knows nothing about agents, every rule on this page about widths, cutting, and escaping can be tested directly.

## It prints and updates one small area

A chat transcript only ever grows, so the renderer keeps no copy of the whole screen. Finished output is printed into the terminal's own scroll history and never touched again. Only the bottom area — a reply still arriving, a question, the input line — is redrawn in place.

Because of that, the scroll position is never something this code has to track, and nothing has to be re-laid-out when the window is resized.

One rule makes it correct: the live area must always be the last thing on screen, so every write goes through `Screen`.

This is also why the interface never switches to the alternate screen. Scrolling, selecting text with the mouse, and copying all keep working exactly as they do for any other command, instead of being rebuilt inside the interface.

## A reply is printed as it arrives

Each finished line is printed into the scroll history as soon as its line break arrives. Only the last, unfinished line stays in the live area.

An unfinished line that fits the live region is drawn through the same inline formatter as the committed transcript, against the same block state — so a closed `**bold**` span is styled the moment its markers arrive, a partial line inside a fence reads as code, and committing the line changes nothing about its shape. A clipped suffix is left literal: it has neither the start of the source line nor earlier delimiter context, and guessing at either would hide text. The live region is the committed path, one newline earlier, rather than a second rendering of the same text.

That has two benefits. Redrawing cost stays constant instead of growing with the length of the answer. And a reply longer than the window scrolls the terminal normally, rather than being trimmed to whatever fits.

When the complete message arrives at the end of the reply, it contributes only what streaming could not already show. That is what stops a reply being printed twice.

## Reasoning is shown while it happens

Models that reason send their thinking as a separate kind of output, sometimes for most of a turn. It is printed quietly above the answer, dimmed, so the screen shows the model working instead of showing a spinner over an empty space.

## Suggestions come from what the agent really has

Typing `/` lists the commands this agent actually registered. Typing `@` lists real entries from the folder. `tab` accepts, the arrow keys move, `esc` closes.

The suggestion list is deliberately not a modal box. A modal box takes every keystroke, and suggestions have to coexist with typing — so the list claims only its own keys, never `enter`, and it narrows as you type instead of trapping the line.

Only the text before the cursor is considered. Completing against text after the cursor would rewrite characters nobody asked about. And `/` only starts a command at the beginning of a line, because `/help` is a command while `see /etc/hosts` is a path.

An accepted suggestion is made safe exactly as pasted text is. A file name can contain any character the filesystem allows, and the input line's contents are drawn without being escaped a second time.

## Tool output is drawn the way the tool asks

Each tool describes how its calls and results should be presented, through two functions the harness documents as safe to call at any time.

So a shell command becomes a framed box, headed by the folder it ran in, with its exit code on the output frame. A file change becomes a red-and-green diff. A search groups its matches under each file. A file read keeps the file's own line numbers. A tool that describes nothing still displays correctly, because every presentation type is documented to fall back to raw text — and no special case is ever added for a particular tool's name.

File-changing tools return their diff from both functions, because in most interfaces the finished card replaces the pending one. Here, where output is never redrawn, the diff is printed once, at the end. That is also the more truthful of the two: it is what actually happened, not what was proposed.

`ctrl-o` cycles how much of each card is shown: `compact`, `full`, `hidden`. Even `hidden` still shows that the call happened and still shows a non-zero exit code, because a transcript that hid those would misrepresent what ran.

## The status line drops details instead of cutting them

Context usage is shown as a bar next to the numbers — `██████░░ 6.2k/8.0k` — but only once at least one block of the bar would be filled. A DeepSeek context window holds a million tokens, so for any realistic session a proportional bar is empty, and an always-empty bar uses space to say nothing. A non-proportional bar would fill sooner but would misrepresent how full the window is. The filled part is rounded down, because a bar that looks full at 94% overstates the one thing it exists to report.

As the terminal gets narrower, whole hints are dropped rather than cut in half — a hint reading `ctrl-d qui` looks like a bug, not like help. The model name is dropped before the context numbers are, because the model does not change during a session and the numbers do.

## Character widths follow the Unicode standard

The harness is used in more than one language, and its bundled agent presets are named in Chinese. A character that is two columns wide but measured as one shifts every following row, not only its own — so widths follow the Unicode East Asian Width property, and the redraw arithmetic counts *drawn* rows so that a wrapped or East Asian line is still counted correctly.

## Measuring and cutting agree about escape sequences

`displayWidth` ignores escape sequences, so wrapping and truncating must ignore them too. Both split text into zero-width escape sequences and visible characters, never cut in the middle of a sequence, and re-open any active color on a continuation row. A colored line that measures wider than it draws would wrap too early, and would take every framed row with it.

Cutting also closes what it opened. Discarding the reset code at the end of a shortened line left its color switched on, and the next thing drawn inherited it — a dimmed reasoning line bleeding into the input line below.

## Untrusted text is made safe before it is drawn

A terminal treats some byte sequences as commands rather than as text. Anything produced by a model, a tool, or a session log is therefore untrusted: an escape sequence in tool output could repaint the live area, and a carriage return could move the cursor.

All such text is converted to a visible form first, with control characters shown in caret notation. Adding color is a separate step, applied only to text this project composed itself.

A path that reaches the terminal without being made safe is a security bug here, not a cosmetic one.

## Markdown is rendered, and made safe while it is parsed

Replies arrive with headings, emphasis, inline and fenced code, lists, quotes, rules, and links. A deliberately small subset is supported, written by hand in `packages/renderer/src/markdown.ts`, because using a parser library would cost the no-dependencies property.

Emphasis follows the CommonMark rules about which characters may open and close it, with one deliberate difference. A marker followed by a space cannot open, and one preceded by a space cannot close, so `2 * 3 * 4` stays arithmetic. Underscores may not touch a word, so `snake_case_name` and `file_name.ts` stay intact. The difference is that `__init__` is left as written instead of being read as bold: in a reply about code, that is a Python name far more often than it is emphasis, and corrupting a name the reader may need to type costs more than losing the formatting. `__bold text__` and `_italic_` both still work.

The order of operations is the security rule: every piece of text is made safe *before* color is added, never after. The function that makes text safe also neutralizes the escape character itself, so running it over already-colored output would destroy the color — and running it over only some pieces would let a control sequence through everywhere else. A model can put one in ordinary prose, in a heading, in a link target, or inside a code fence, and all four are covered.

## Pasted text is untrusted too

People paste logs, which makes a paste the most likely source of terminal control characters in the whole interface.

Pasted text is cleaned up when it is inserted, rather than at each place it is later measured or drawn: line endings become `\n`, tab characters become spaces, and any remaining control characters become caret notation.

Tabs are expanded everywhere, not only here. A tab is a single character that moves the terminal to the next tab stop, so leaving one in place makes every width calculation disagree with the screen — a framed row is padded to the wrong width and its right border moves. Keeping one representation in the buffer means every width, cursor, and drawing calculation reads the same text the terminal receives.

Terminals can mark the beginning and end of a paste, and that is what makes a multi-line paste one message instead of a burst of `enter` presses. A paste that arrives in pieces is held until its end marker, however long that takes: a slow paste and an abandoned one look identical, and cutting a real one short would send the rest of the document as separate messages.

## Keyboard input is read in both formats

Telling `shift-enter` apart from `enter` needs the terminal's cooperation, so on startup the renderer asks for the lowest option of the kitty keyboard protocol, *disambiguate escape codes*.

That request is not additive. A terminal that supports it stops sending the old byte values for `esc`, `alt`, and **`ctrl`** combinations entirely: `ctrl-c` becomes `CSI 99 ; 5 u` and never `0x03` again.

So both formats are decoded, and the table for the new format is *derived* from the table for the old one rather than written out beside it. A `ctrl` shortcut's new code is its old byte value plus `0x60`, so adding a shortcut to one table gives it to both. A shortcut known only by its old byte value is completely dead on exactly the terminals where the new mode works — which is not a graceful fallback but a regression.

`enter`, `tab`, and `backspace` are the protocol's own exceptions and keep their old values when unmodified. The older xterm format for the same information is read as well, because which format a terminal chooses is not the user's problem. The mode is switched off when the interface exits, so the next program reads its input as it expects to.

A lone `esc` byte at the end of what was read is held rather than decided immediately, because it is the first byte of every sequence the decoder recognizes, including the paste markers. A brief pause resolves it: once the terminal has stopped sending, that byte was the Escape key.

## Commands report what they did

A command does not produce a model reply, so what it says about itself is the only evidence that anything happened. The command line is echoed, and its result is printed as a note — or with a `✗` when it failed, because a command that fails silently looks exactly like a command that is broken.

Both come from the harness's own record of the command starting and finishing, not from the moment you pressed enter. That matters for reopening a session: those two records are saved in the log, so a resumed session shows its commands exactly as the live one did. Printing directly to the screen instead would have made every command result disappear on resume.

A command may also succeed with no text at all. That is a valid result, and the commands that return it are the ones whose effect this interface cannot otherwise show — so instead of passing over it, the command is acknowledged by name. The harness also lets a result point at another event that presents the same information more richly. That hint is deliberately ignored here, because this interface does not display those events, and honoring it would leave the command invisible.

A line that is rejected as an unknown command is different: nothing ran, so the harness records nothing, and the message comes from this interface alone. It is not part of the saved conversation and does not reappear when the session is reopened.

`/exit`, `/quit`, and `/model` are answered by this interface rather than registered with the harness. The harness's command registry is shared by every interface in the process, and a web page or an automation server has no terminal to leave and no picker to open. They still appear in the `/` list next to the others, because someone typing `/` wants to see what they can type, not which registry it came from.

A line that looks like a command but names nothing is reported as unknown, using the harness's own rule for what a command line is, so the two cannot disagree.

## The interface is made of plugins too

The banner, input line, status line, and every box are separate registrations in `ctx.tuiSlots` — the terminal's equivalent of the web interface's view registry. Positions are named (`stream`, `composer`, `completion`, `status`), so a view chooses where it appears by naming one, and whichever view owns text entry reports where the cursor belongs.

```ts
ctx.tuiSlots.register('status', { render: () => ['my widget'] })
ctx.tuiSlots.pushOverlay(myPrompt)   // takes the whole area and every keystroke
```

Boxes stack, and only the top one draws and receives keys, so a question raised while an approval is waiting does not get mixed into it. `ctrl-d` is handled before the box gets the keystroke, because quitting means the same thing everywhere.

## Sessions and resuming

Sessions are saved by the harness, so a conversation survives quitting. `--resume` rebuilds the transcript from the saved log and redraws it through the *same* code that drew it live, so a reopened session looks exactly like the one you watched happen. Two separate drawing paths would have drifted apart the first time either changed.

What gets replayed is the record of what was actually said, not the version the model currently sees. Those differ: when history is summarized to save context, the model's view hides the messages that were replaced. Replaying that view would erase parts of the conversation you had already read. They are gone from the model's memory, but they still happened.

A reopened session keeps the folder it was created in. That folder is recorded in the session file and treated as authoritative, so `-C` is ignored when resuming rather than quietly moving an old conversation somewhere new.
