/**
 * Semantic roles, and the active palette that resolves them to SGR parameters.
 *
 * The indirection exists because a colour name at a call site is not a decision
 * anyone can revisit later. `style(text, 'red')` is written identically for a
 * failed tool and for a removed line of a diff, so no palette could ever move
 * one without moving the other; four unrelated meanings — a warning, the
 * spinner, context pressure, and every overlay border — currently share yellow
 * the same way. A ROLE says what a piece of text is; a PALETTE says what that
 * looks like. Only the second is a theme's to choose.
 *
 * This module holds process-global state, for the reason `./terminal.ts` does:
 * there is one terminal, so there is one palette, and threading a painter
 * through every view constructor would double those signatures to carry a fact
 * that cannot vary between them. It follows the same rule raw mode does —
 * installing one returns the disposer that puts the previous one back, and
 * calling that disposer twice is safe.
 * @module @dshline/renderer/theme
 */

import { sgr } from './text.ts'

/**
 * One semantic role.
 *
 * Derived from the call sites rather than invented: every member below replaces
 * at least one `style(...)` argument list somewhere in the frontend. Roles that
 * happen to share an appearance today are still separate where they mean
 * different things, because welding two of them together is a one-way door — a
 * palette can always give two roles the same value, but nothing can split a
 * role back apart once the call sites have forgotten which one they meant.
 *
 * {@link Role} members `muted` and `subdued` are the deliberate escape hatches
 * that stop this union needing a member per sentence. A role is promoted out of
 * them only when a palette needs to move it on its own.
 */
export type Role =
  // Who produced a line.
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'reasoning-mark'
  // Markdown structure.
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'strong'
  | 'emphasis'
  | 'strike'
  | 'code'
  | 'link'
  | 'link-target'
  | 'quote'
  | 'quote-bar'
  | 'bullet'
  | 'rule'
  // Tool cards and diffs.
  | 'section-heading'
  | 'tool-icon'
  | 'tool-name'
  | 'path'
  | 'diff-add'
  | 'diff-remove'
  // The banner and the status line.
  | 'banner'
  | 'busy'
  | 'ready'
  | 'mode'
  | 'mode-alert'
  | 'pressure-nominal'
  | 'pressure-warn'
  | 'pressure-alarm'
  // Outcomes.
  | 'error'
  | 'warning'
  | 'success'
  // Chrome and interaction.
  | 'chrome'
  | 'composer-title'
  | 'overlay-border'
  | 'overlay-title'
  | 'overlay-headline'
  | 'panel-title'
  | 'selection'
  | 'selection-mark'
  | 'timing-active'
  | 'prompt-mark'
  // De-emphasis, held apart on purpose. `muted` is an absolute colour and
  // `subdued` is an attribute that composes with whatever foreground is already
  // active, so a palette written for a light terminal has to move the first and
  // leave the second alone. They are also different bytes today, which is what
  // lets the shipped palette be a refactor rather than a redesign.
  | 'muted'
  | 'subdued'

/**
 * The SGR parameters for one appearance: what goes between `CSI` and `m`.
 *
 * An array rather than a single number because a role is a whole appearance —
 * bold cyan is `[1, 36]` — and because the deeper colour spaces are themselves
 * multi-parameter: `[38, 5, 208]` and `[38, 2, 255, 128, 0]`. Emitting is a
 * join, so widening a palette past sixteen colours needs no new syntax here and
 * none in the width arithmetic, which treats a whole sequence as one token.
 *
 * **Order is significant and is asserted.** `[1, 36]` and `[36, 1]` render
 * identically and are different bytes, and tests in both packages match those
 * bytes literally.
 */
export type Sgr = readonly number[]

/** How much colour a terminal has been determined to support. */
export type ColorDepth =
  /** None: {@link paint} returns its input untouched, attributes included. */
  | 0
  /** The basic sixteen — what this project emitted before palettes existed. */
  | 4
  /** The 256-colour cube. */
  | 8
  /** Twenty-four bit. */
  | 24

/**
 * One role's appearance, authored once per colour space worth authoring.
 *
 * {@link RoleColor.ansi} is required, and that is the whole contract keeping
 * "no silent degradation" true for palettes: every theme states what it looks
 * like on a sixteen-colour terminal as a reviewed decision, rather than being
 * put through a nearest-colour approximation nobody looked at.
 */
export interface RoleColor {
  /** Twenty-four bit form, used when the terminal reaches it. */
  readonly truecolor?: Sgr
  /** 256-colour form, used when the terminal reaches that and no further. */
  readonly ansi256?: Sgr
  /** The sixteen-colour floor. Required: every terminal gets an answer. */
  readonly ansi: Sgr
}

/** A complete role table, before it is folded down to one terminal's depth. */
export interface Palette {
  /** Stable identifier; what a user types and what diagnostics report. */
  readonly id: string
  /** Display name for a picker row. */
  readonly name: string
  /** One line explaining what this palette is for. */
  readonly description: string
  /** The deepest colour space its entries are authored at. */
  readonly depth: ColorDepth
  /**
   * Every role. Total on purpose: a role added to {@link Role} without a value
   * here is a compile error rather than a blank row discovered on screen.
   */
  readonly roles: { readonly [K in Role]: RoleColor }
}

/**
 * The palette this project shipped before it had palettes.
 *
 * Every entry reproduces the exact `style(...)` arguments of the call sites it
 * replaces, **in their original order**, so `paint(text, role)` emits the same
 * bytes the same row emitted before. That property is what makes migrating
 * every call site a refactor with a mechanical proof instead of a judgement
 * call, and `theme.spec.ts` locks it. Changing a colour here is a visual change
 * and belongs in its own commit, against a failing test.
 *
 * It is authored at depth 4 and carries no deeper forms, which is also what a
 * terminal that reports nothing about itself receives.
 */
export const DEFAULT_PALETTE: Palette = {
  id: 'default',
  name: 'Default',
  description: 'The palette dshline has always shipped',
  depth: 4,
  roles: {
    // transcript.ts: the gutter mark and the row it introduces.
    user: { ansi: [36, 1] },
    // stream.ts: the mark on the reply channel.
    assistant: { ansi: [32] },
    // stream.ts: the model's working notes, shown as written.
    reasoning: { ansi: [2, 3] },
    // stream.ts: the mark that introduces them.
    'reasoning-mark': { ansi: [90] },
    // markdown.ts HEADING_STYLES; deeper headings are quieter.
    'heading-1': { ansi: [1, 36] },
    'heading-2': { ansi: [1] },
    'heading-3': { ansi: [1, 2] },
    strong: { ansi: [1] },
    emphasis: { ansi: [3] },
    strike: { ansi: [2] },
    // markdown.ts: inline spans and fenced bodies alike; never syntax-parsed.
    code: { ansi: [36] },
    link: { ansi: [36] },
    'link-target': { ansi: [90] },
    quote: { ansi: [2] },
    'quote-bar': { ansi: [90] },
    bullet: { ansi: [90] },
    rule: { ansi: [90] },
    // A heading over a group of rows inside a view: `Subagents`, `Jobs`, a
    // Connect section. Not `strong`, which is markdown emphasis a model
    // wrote, and not `tool-name`, which names one call.
    'section-heading': { ansi: [1] },
    // cards.ts: the call mark and the per-kind glyphs beside it.
    'tool-icon': { ansi: [34] },
    'tool-name': { ansi: [1] },
    path: { ansi: [36] },
    'diff-add': { ansi: [32] },
    'diff-remove': { ansi: [31] },
    // views.ts: the product name in the startup banner.
    banner: { ansi: [1, 36] },
    busy: { ansi: [33] },
    ready: { ansi: [32] },
    // views.ts: the plan, todo, and work segments of the status line.
    mode: { ansi: [36] },
    // A mode worth looking at rather than merely worth reporting: a tool
    // detail level the reader overrode, and a goal that is still driving
    // itself. Separate from `mode` because it is a different colour today,
    // and separate from `warning` because neither is a problem.
    'mode-alert': { ansi: [33] },
    'pressure-nominal': { ansi: [2] },
    'pressure-warn': { ansi: [33] },
    'pressure-alarm': { ansi: [31] },
    error: { ansi: [31] },
    warning: { ansi: [33] },
    success: { ansi: [32] },
    // Borders, gutter marks, rules, hints — structure the eye skips over.
    chrome: { ansi: [90] },
    // The title on the composer frame, which names the workspace. Not the
    // `path` role: a theme has to be able to restyle the input box without
    // recolouring every file path a tool card prints.
    'composer-title': { ansi: [36] },
    'overlay-border': { ansi: [33] },
    // The title inside a framed overlay.
    'overlay-title': { ansi: [1, 33] },
    // The bare headline an overlay falls back to when the terminal is too
    // narrow to frame anything. A separate role from the framed title because
    // it is a separate thing, and because the two are different bytes today.
    'overlay-headline': { ansi: [33, 1] },
    // timing.ts: the heading of a persistent live panel, which is neither an
    // overlay title nor a markdown heading.
    'panel-title': { ansi: [36, 1] },
    selection: { ansi: [36, 1] },
    // The pointer glyph where it is styled apart from the row it points at,
    // as the completion list does; `selection` covers the row itself.
    'selection-mark': { ansi: [36] },
    // A span still running, and the filled part of its bar.
    'timing-active': { ansi: [36] },
    'prompt-mark': { ansi: [33] },
    muted: { ansi: [90] },
    subdued: { ansi: [2] },
  },
}

/** A palette already folded to one depth: role to parameters. */
interface ActivePalette {
  /** Which palette this came from, for reporting it back. */
  readonly id: string
  /** The depth it was folded to; 0 means {@link paint} does nothing. */
  readonly depth: ColorDepth
  /** The resolved parameters for every role. */
  readonly roles: Readonly<Record<Role, Sgr>>
}

/**
 * Choose the deepest authored form a terminal can actually show.
 * @param color - the role's authored appearances.
 * @param depth - what the terminal supports.
 * @returns the parameters to emit for that role.
 */
function fold(color: RoleColor, depth: ColorDepth): Sgr {
  if (depth >= 24 && color.truecolor !== undefined) return color.truecolor
  if (depth >= 8 && color.ansi256 !== undefined) return color.ansi256
  return color.ansi
}

/**
 * Fold a whole palette once, at install time.
 *
 * Folding here rather than inside {@link paint} is a deliberate trade: `paint`
 * runs once per styled token per frame, so it has to stay a lookup and a join.
 * @param palette - the palette to install.
 * @param depth - what the terminal supports.
 * @returns the resolved table.
 */
function resolve(palette: Palette, depth: ColorDepth): ActivePalette {
  const roles = {} as Record<Role, Sgr>
  for (const [role, color] of Object.entries(palette.roles) as [Role, RoleColor][]) {
    roles[role] = fold(color, depth)
  }
  return { id: palette.id, depth, roles }
}

/** The palette in force. Module-level for the reason given in the module docs. */
let active: ActivePalette = resolve(DEFAULT_PALETTE, DEFAULT_PALETTE.depth)

/**
 * Style `text` for the roles given, resetting afterwards.
 *
 * For frontend-authored strings only, under the same rule as `style`: untrusted
 * text is made safe by `escapeControls` FIRST, because escaping neutralizes the
 * escape character itself and would destroy styling applied before it. Apply it
 * to one row at a time, after any gutter mark — the reset lands at the end of
 * whatever is wrapped, so a multi-line string is left with styling still
 * switched on for every row but the last.
 *
 * Do not nest calls. `paint(paint(x, 'code'), 'quote')` has the inner reset
 * close the outer styling, which is the same hazard `style` has always had; the
 * role names make nesting read as though it were safe, and it is not.
 * @param text - frontend-authored text that has already been made safe.
 * @param roles - roles to apply together, in order.
 * @returns the styled text; `text` unchanged with no roles, or at depth 0.
 */
export function paint(text: string, ...roles: readonly Role[]): string {
  if (active.depth === 0 || roles.length === 0) return text
  return sgr(text, roles.flatMap(role => active.roles[role]))
}

/**
 * Install `palette`, folded down to what the terminal can show.
 * @param palette - the palette to make active.
 * @param depth - the terminal's resolved colour depth.
 * @returns a disposer restoring the palette that was active before. Safe to
 *   call more than once, as `acquireTerminal`'s disposer is.
 */
export function setPalette(palette: Palette, depth: ColorDepth): () => void {
  const previous = active
  active = resolve(palette, depth)
  let restored = false
  return () => {
    if (restored) return
    restored = true
    active = previous
  }
}

/**
 * The palette currently in force.
 * @returns its identifier, and the depth it was folded to.
 */
export function activePalette(): { readonly id: string; readonly depth: ColorDepth } {
  return { id: active.id, depth: active.depth }
}

/**
 * What the depth resolver needs, so the renderer itself reads no ambient state.
 *
 * The renderer touches `process` nowhere — `acquireTerminal` takes its streams
 * as an argument for the same reason — so the values below are supplied by the
 * caller that legitimately owns the environment.
 */
export interface ColorEnvironment {
  /** `NO_COLOR`. Any non-empty value disables colour, whatever it says. */
  readonly noColor?: string | undefined
  /** `FORCE_COLOR`. Overrides both `NO_COLOR` and a non-terminal stream. */
  readonly forceColor?: string | undefined
  /** `COLORTERM`. `truecolor` or `24bit` means twenty-four bit. */
  readonly colorterm?: string | undefined
  /** `TERM`. `dumb` means none; a `256color` suffix means the cube. */
  readonly term?: string | undefined
  /** Whether output is a terminal. A pipe gets no colour. */
  readonly isTty: boolean
}

/**
 * Decide how much colour a terminal can show. Pure: reads nothing ambient.
 *
 * `FORCE_COLOR` is checked before `NO_COLOR` because it exists precisely to
 * overrule a refusal — a caller that sets both has asked for colour last. The
 * `NO_COLOR` rule is the published one: any non-empty value disables colour
 * regardless of what the value is, so `NO_COLOR=0` still means no colour.
 * @param env - the environment, supplied by whoever owns `process`.
 * @returns the depth a palette should be installed at.
 */
export function resolveColorDepth(env: ColorEnvironment): ColorDepth {
  if (env.term === 'dumb') return 0
  const forced = env.forceColor
  if (forced !== undefined) {
    if (forced === '0' || forced === 'false') return 0
    if (forced === '2') return 8
    if (forced === '3') return 24
    return 4
  }
  if (env.noColor !== undefined && env.noColor !== '') return 0
  if (!env.isTty) return 0
  if (env.colorterm === 'truecolor' || env.colorterm === '24bit') return 24
  if (env.term !== undefined && env.term.includes('256color')) return 8
  return 4
}
