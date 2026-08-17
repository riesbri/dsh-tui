# @riesbri/dsh-tui

A terminal interface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), built as an in-process Cordis bundle rather than a client.

```sh
dsh plugin --profile tui add @riesbri/dsh-tui
dsh --profile tui
```

Because it runs inside the agent's process it can register `ctx.userQuestions`, needs no server and no wire format, and adds no third-party packages: the renderer it draws with declares no dependencies, and everything else is a peer the harness already ships.

It never takes the alternate screen — finished output goes to your terminal's own scroll buffer and only a small region at the bottom is redrawn, so scrollback, selection, and copy keep working.

Full documentation, comparison with the other harness frontends, roadmap, and limitations: **https://github.com/riesbri/dsh-tui**

## License

MIT
