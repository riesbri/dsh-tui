# dshline

**The terminal-native frontend for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin ecosystem.**

It is an in-process Harness presentation adapter, not a separate client or agent runtime:

`Harness plugin → standard capability → dshline presentation adapter → native terminal UI`

Harness owns capabilities, state, runtime, and policy; dshline presents supported Harness capabilities natively in the terminal. It prefers generic capability contracts over provider-specific integrations, so a provider that participates in a supported Harness seam can share the same terminal presentation.

```sh
dsh plugin --profile dshline add dshline
dsh --profile dshline
```

Finished output stays in the terminal's native scrollback while only a bounded live region is redrawn. The presentation core is small and dependency-light; its renderer has no runtime dependencies and knows nothing about agents or providers.

For installation requirements, usage, architecture, security guidance, and the canonical roadmap, see the [dshline repository](https://github.com/riesbri/dshline).

## License

MIT
