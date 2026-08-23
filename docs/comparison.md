# Why choose dshline?

`dshline` is for people who want a **terminal-native frontend for the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
ecosystem**, rather than a separate terminal client or agent runtime.

Its central boundary is deliberately narrow:

`Harness plugin → standard capability → dshline presentation adapter → native terminal UI`

**Harness owns capabilities; dshline owns terminal presentation.** That boundary
is the reason to choose it.

## Harness-native capability presentation

dshline runs in the Harness process and consumes the same authoritative
capability contracts that the active profile uses. Harness remains responsible
for provider selection, state, persistence, lifecycle, authorization, and
policy; the terminal UI turns those structured facts into terminal
presentation.

This lets dshline present a supported standard surface generically. Current
presentations and future work—from Work and session projections to planned
attachments—follow the same boundary rather than adding a provider-specific
runtime. It avoids the fragile alternatives: parsing rendered text, copying a
provider connection, or keeping a second state store.

See [Architecture](architecture.md) for the contract and authority rules.

## A terminal UI that keeps terminal behavior

Finished transcript rows enter the terminal's real scrollback. They are not
moved into an alternate screen or a virtual transcript. Normal terminal
scrolling, selection, and copying therefore keep working, while dshline redraws
only a bounded live region for active interaction.

This model intentionally trades full-screen layouts and persistent split panes
for normal shell and terminal behavior. [Design](design.md) explains the
terminal invariants behind that choice.

## Small surface, strong terminal correctness

The renderer is Harness-independent and has no runtime dependencies. The TUI
adds a small, auditable presentation layer instead of another agent, provider,
or policy engine. Its correctness work is explicit: display-column width,
Unicode and CJK handling, safe control-sequence escaping, keyboard decoding,
and bounded redraw behavior are tested without requiring a live model or
terminal session.

A smaller boundary makes security review clearer, too: questions and approvals
are presented where Harness defines them, while tool permissions and sandbox
policy remain with the active Harness profile. [Security](../SECURITY.md)
covers that responsibility split.

## Choosing among frontends

Other Harness frontends make different trade-offs, including fuller-screen
layouts, different rendering stacks, or client/server boundaries. Compare their
current documentation when those trade-offs matter. Choose dshline when the
important properties are Harness-native, provider-neutral capability
integration, native scrollback, and a small terminal-focused presentation
architecture.

For planned capability adapters and known limitations, see the canonical
[Roadmap](../ROADMAP.md).
