# Roadmap and limitations

This is version 0.1.0 — early software. This page is meant to set expectations accurately rather than favorably.

## Roadmap

Ordered by how much each would change daily use, not by how easy it is.

### Next

- **Let `enter` accept the highlighted suggestion.** Today only `tab` does, because the suggestion list must never swallow a message you meant to send. The result is that typing `/ex` and pressing enter submits `/ex`, which is then reported as an unknown command. Accepting *only while a suggestion is highlighted* is what every comparable interface does; the care needed is in the case where you meant to send.
- **History in the input line** — the up and down arrow keys moving through your previous messages, once those keys are not needed by the suggestion list.

### Later

- **Real file attachments** — turning `@path` into actual attached content, instead of a file name the model has to go and read for itself.
- **Themes** — colors already pass through a single function, so this is a matter of designing one palette layer rather than rewriting anything.

### Maybe

- **Background jobs and sub-agents** — the harness has tools for both, but a live panel for either needs a kind of layout this renderer deliberately does not do.

## Limitations

- **No themes.** One color palette.
- **`ctrl-o` affects new output only.** Output already printed lives in your terminal's own scroll history and is never rewritten, which is what keeps scrolling, selection, and copying working. The cost is that changing the level cannot reformat what is already on screen. The current level is shown in the status line.
- **`@path` inserts text, not an attachment.** Suggestions help you type a file name correctly; the model then reads the file with its own tools. Nothing is attached to the message.
- **Tool calls are not reviewed before they run, in a standard setup.** The approval prompt works, but nothing in the harness's standard plugin set asks for approval on ordinary calls. See [Usage → Permissions and the sandbox](usage.md#permissions-and-the-sandbox) for what to add if you want them reviewed.
- **`/goal <objective>` starts an automatic agent run.** That is the harness's goal driver, not this interface, and nothing here warns you *before* it begins. Once it has, the status line reports it for as long as it runs, and says when a reopened session is holding a goal it will not continue. See [Usage → Commands](usage.md#commands).
- **One session per window.** No tabs, no split panes, no second agent beside the first.
- **Developed and tested on Linux.** macOS and Windows terminals are not yet verified by the author. If you use one, a bug report is genuinely useful — see [`CONTRIBUTING.md`](../CONTRIBUTING.md).
