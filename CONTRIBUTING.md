# Contributing

Thank you for looking. This is a young project — version 0.2.0, written by one person — so contributions are genuinely useful, and so is a plain bug report.

Please read this page before opening a pull request. It is short.

## What is most useful right now

**Bug reports from terminals I cannot test.** This is the single most valuable contribution. The interface asks your terminal for an extended keyboard mode, and terminals disagree about what they send back. A shortcut that is dead in your terminal is a real bug, even if it works everywhere else.

**Reports of unreadable output.** Wrong character widths, misplaced box borders, text in the wrong color, or a line that wraps too early. Include your terminal, its width in columns, and a screenshot if you can.

**Missing feedback.** If something happened and the interface did not say so, that is a bug. So is the opposite: a message that appears twice.

**Documentation that did not match reality**, or that you had to read twice to understand. English is not the first language of most people reading it, so unclear writing is a defect, not a matter of taste.

## Reporting a bug

Open an [issue](https://github.com/riesbri/dsh-tui/issues) with:

- What you did, what you expected, and what happened instead.
- Your terminal program and version, your operating system, and the output of `node --version`.
- The output of `dsh --profile tui --dump-config`, if the problem is about installing or about which plugins loaded.

**For a key that does nothing,** the most useful thing you can send is what your terminal actually sends. This prints it:

```sh
pnpm build && node tools/keyprobe.mjs
```

Press the key that misbehaves. Each line shows the raw bytes and the key this project decodes them into. An empty `[]` means the key was not recognised — copy those lines into the issue, along with your terminal's name.

**Do not report security vulnerabilities in a public issue.** See [`SECURITY.md`](SECURITY.md) for the private route.

## Sending a change

1. **Open an issue first for anything larger than a fix**, so you do not spend time on something that does not fit the design. Small fixes can go straight to a pull request.
2. **Read [`AGENTS.md`](AGENTS.md).** It lists the rules that are easy to break by accident, because breaking one causes a failure somewhere unrelated. It also explains a build step that, if you skip it, makes your change appear to do nothing.
3. **Add a test that fails without your change.** Then break your own fix on purpose and confirm the test notices. A test that also passes against the broken version does not protect anything.
4. **For a user-visible package change, run `pnpm changeset` and commit its Markdown file.** It is the release record the version workflow consumes; documentation, CI, and internal-only changes do not need one. [`AGENTS.md`](AGENTS.md#preparing-a-release) explains the version PR and tag flow.
5. **Do not add dependencies.** The drawing package has none, and that is a deliberate feature — see [why](docs/comparison.md#it-adds-no-third-party-packages). A change that needs a new package needs a discussion first.
6. **Explain the reason in the commit message.** Say what a user saw, why the obvious fix is wrong, and how you checked yours. Long commit messages are normal here.

```sh
pnpm install
pnpm build        # also required before testing by hand; see AGENTS.md
pnpm test         # the full suite, no terminal and no model needed
pnpm typecheck
pnpm security     # the dependency and workflow checks that CI runs
```

All of these must pass. CI runs them on Node 22 and 24, and every check is required before a merge.

## What may be declined

Being honest about this saves your time:

- **A new dependency**, unless it replaces something clearly worse.
- **A rewrite onto a UI framework.** Drawing by hand is the point of this project. If you would rather use a framework, the other interfaces in the [comparison](docs/comparison.md) already do.
- **Themes and color settings, for now.** They are wanted, but the color layer should be designed once rather than patched in several places. See the [roadmap](docs/roadmap.md).
- **Features that need a full-screen layout**, such as split panes or side panels. This interface prints into your terminal's scroll history, which deliberately rules those out.

## What to expect

This is not a funded project, and reviews may take a few days. A pull request sitting without a reply has not been rejected — please comment on it again.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE), like the rest of the project.
