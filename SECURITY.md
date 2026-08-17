# Security

## Reporting a vulnerability

Report privately through GitHub's [private vulnerability reporting](https://github.com/riesbri/dsh-tui/security/advisories/new). It goes to the maintainer without becoming public, and it is the only channel — please do not open a public issue for something exploitable.

Expect an acknowledgement within a week. This is a personal project rather than a funded one, so that is a realistic commitment rather than a target with a team behind it. If a report is confirmed, the fix and an advisory land together, and you are credited unless you ask otherwise.

Vulnerabilities in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) itself belong upstream, not here. If you are unsure which side a problem is on, report it here and it will be routed.

## Scope

`@riesbri/dsh-tui` draws a terminal interface for an agent. Its exposure follows from that, and these are the things worth looking hardest at.

**Terminal escape injection.** Every string this project draws came from a model, a tool, a file, or a paste, and none of it is trusted. A terminal treats bytes as commands: an escape sequence in a model's reply can reposition the cursor, rewrite lines the user already read, retitle the window, or on some emulators put text into the input buffer. Everything reaching the screen therefore passes through `escapeControls` first and is shown in caret notation, and styling is applied only to text already made safe — never the reverse, because escaping styled output would destroy the styling and escaping only some spans would let a sequence through anywhere else. A path that reaches the terminal without escaping is a vulnerability in this project, not a rendering bug. The renderer's test suite asserts it for prose, code spans, fenced blocks, headings, bullets, links, tool output, pasted text, and the live streaming region.

**Truncation and width.** `displayWidth` ignores escape sequences, so `wrapToWidth` and `truncateToWidth` must too. A cut that lands inside a sequence emits a partial escape, which the terminal then completes with whatever follows — so a width bug is an injection bug with extra steps.

**Bracketed paste.** Paste is sanitised at the point it enters the composer, not at the point it is drawn. Without that, a document containing escape sequences becomes a way to reach the terminal through a user who only meant to paste text.

**What is out of scope here.** What the agent is permitted to do — which tools exist, which calls need approval, what the sandbox allows — is decided by the profile that mounts this bundle, not by this bundle. That is deliberate: the harness puts policy in composition, and a frontend that decided it for you would be the wrong place to look for it. Reports about a tool executing something it should not belong upstream or with the composition, unless this frontend answered an approval request it should have refused.

## How this repository defends itself

Not a promise of safety, just what is actually wired up and where to look.

| Control | Where |
| --- | --- |
| Advisory scan on every push and weekly | `.github/workflows/security.yml` |
| New-dependency and licence review on every pull request | `.github/workflows/security.yml` |
| Full-history secret scan | `.github/workflows/security.yml` |
| Workflow hardening lint (`zizmor`, pedantic) | `.github/workflows/security.yml` |
| Static analysis (`CodeQL`, `security-extended`) | `.github/workflows/codeql.yml` |
| Supply-chain posture grade (`OpenSSF Scorecard`) | `.github/workflows/scorecard.yml` |
| Actions pinned to commits, not tags | every workflow |
| Install scripts never run in CI | `--ignore-scripts` |
| Lockfile verified rather than trusted | never `--trust-lockfile` |
| No version younger than 24 hours is installed | `minimumReleaseAge`, `pnpm-workspace.yaml` |
| A weakening of a package's trust evidence fails the install | `trustPolicy: no-downgrade`, `pnpm-workspace.yaml` |
| Dependency and action bumps proposed for human review | `.github/dependabot.yml` |

The published packages declare no runtime dependencies beyond each other, which is the largest single reason the surface is small: `@riesbri/dsh-tui-renderer` has none at all, and everything the harness provides is a peer the host already has.
