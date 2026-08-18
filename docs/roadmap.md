# Roadmap and limitations

## Roadmap

Ordered by what most changes daily use, not by what is easiest.

### Next

- **`enter` accepts the highlighted completion.** Today only `tab` does, because the completion list must never swallow a submission — so typing `/ex` and pressing enter submits `/ex`, which reports an unknown command. Making `enter` accept *while a candidate is highlighted* is the gesture every comparable interface uses; the risk is the case where it steals a deliberate send.
- **Composer history** — the vertical arrows through past prompts, once they are not claimed by a completion list.

### Then

- **Attachment expansion** — turning an `@path` into real attached content rather than a name the model has to go and read.
- **Themes** — colours already pass through a single `style()` call, so this is a palette seam rather than a rewrite.

### Maybe

- **Background jobs and subagents** — the harness has `job_*` tools and a subagent registry; a live panel for either needs layout this renderer does not do.

## Limitations

- **No themes.** One palette.
- **`ctrl-o` applies to cards drawn from then on, not to ones already printed.** Finished output lives in the terminal's own scroll buffer and is never rewritten, which is what keeps scrollback, selection, and copy working; the cost is that the toggle cannot reflow history. The current level is shown in the status line.
- **An `@path` is text, not an attachment.** Completion helps you name a file accurately; the model then reads it with its own tools. Nothing is expanded into the message.
- **Ordinary tool calls never ask for approval in a default composition.** The approval prompt works and is reachable, but nothing in `@deepseek-ai/dsh-base` asks it to appear for ordinary calls. See [Usage → Approval and the sandbox](usage.md#approval-and-the-sandbox) for what to mount if you want them gated.
- **`/goal <objective>` starts an autonomous run.** That is the harness's goal-round driver, not this frontend, and nothing here warns you before it begins. See [Usage → Commands](usage.md#commands).
- **One session per process.** No tabs, no split panes, no second agent beside the first.
