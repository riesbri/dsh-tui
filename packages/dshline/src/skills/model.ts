/**
 * What dshline knows about a Harness skill, and nothing more.
 *
 * Every fact here is copied out of one `SkillSummary` the registry already
 * resolved. Harness owns discovery, duplicate providers, scope precedence,
 * invocation policy, and loading; this module owns only how those resolved
 * facts read on a terminal.
 *
 * Deliberately free of `@deepseek-ai/*` types: the presentation rules below
 * are the ones a spec should be able to exercise without a registry, and the
 * one place that touches the real service is `./catalog.ts`.
 * @module dshline/skills/model
 */

/** One effective skill, as this frontend reads it. */
export interface SkillView {
  /** Kebab-case identifier, exactly as Harness resolved it. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance, shown only in the selected detail. */
  readonly whenToUse?: string
  /** Whether a human `/name` gesture may invoke it. */
  readonly userInvocable: boolean
  /** Whether the model's own catalog and loader may see it. */
  readonly modelInvocable: boolean
  /** Raw discovery source; {@link sourceLabel} turns it into a word. */
  readonly source: string
}

/**
 * Harness's discovery buckets, in the words a reader recognizes.
 *
 * `project-dsh` and `project-agents` collapse to one word on purpose: which of
 * `.dsh/skills` and `.agents/skills` a file came from is a discovery rule this
 * frontend has no business teaching, and the registry already resolved which
 * one won.
 */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  'project-dsh': 'project',
  'project-agents': 'project',
  'user-dsh': 'user',
  'user-agents': 'user',
  bundled: 'bundled',
  runtime: 'runtime',
  custom: 'custom',
}

/**
 * Present one discovery source.
 *
 * An unknown value is passed through rather than bucketed or dropped: the
 * source type is deliberately open (`| (string & {})`), so a provider Harness
 * gains tomorrow must read as itself instead of as `custom`.
 * @param source - the summary's raw source value.
 * @returns the word to show.
 */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source
}

/**
 * Who may invoke one skill, as one phrase.
 * @param skill - the skill being described.
 * @returns the phrase for the detail panel.
 */
export function invocationLabel(skill: SkillView): string {
  if (skill.userInvocable && skill.modelInvocable) return 'you + model'
  if (skill.userInvocable) return 'you only'
  if (skill.modelInvocable) return 'model only'
  // Harness keeps this combination rather than dropping the skill: it stays
  // loadable by trusted `ctx.skills.get()` callers, and dshline is not one.
  return 'neither'
}

/** One row of the slash menu, in the shape the completion engine consumes. */
export interface SlashCandidate {
  /** Name without its leading slash. */
  readonly name: string
  /** The dimmed note beside the name. */
  readonly description: string
}

/**
 * The `/` menu: commands, then the skills a leading `/name` can actually reach.
 *
 * Commands win a shared name outright, and the loser is dropped rather than
 * listed twice — offering both would promise a gesture only one of them
 * receives, since dshline resolves the line against the command registry
 * before it can ever become a prompt.
 * @param commands - local and registered commands, already merged by the caller.
 * @param skills - the effective catalog; only user-invocable entries are offered.
 * @returns one row per offered name, sorted by name.
 */
export function slashCandidates(
  commands: readonly SlashCandidate[],
  skills: readonly SkillView[],
): readonly SlashCandidate[] {
  const claimed = new Set(commands.map(command => command.name))
  const rows = [...commands]
  for (const skill of skills) {
    if (!skill.userInvocable || claimed.has(skill.name)) continue
    rows.push({ name: skill.name, description: skillNote(skill) })
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * The note a skill row carries in the slash menu.
 *
 * `skill ·` leads, so the kind is readable before the description is; the
 * user-only marker rides the same note rather than a badge column, which is
 * what Harness's own Web menu does with the one line of secondary text it has.
 * @param skill - the offered skill.
 * @returns the note text, unescaped and unstyled.
 */
export function skillNote(skill: SkillView): string {
  const parts = ['skill']
  if (!skill.modelInvocable) parts.push('user only')
  if (skill.description !== '') parts.push(skill.description)
  return parts.join(' · ')
}

/** One row of the `/skills` inspector. */
export interface SkillRow {
  /** The skill this row describes. */
  readonly skill: SkillView
  /**
   * Whether typing this row's name after a slash actually reaches the skill.
   *
   * False for a model-only skill and for one whose name a command already
   * claims — in both cases a `/name` prefix would be a promise the submit path
   * does not keep.
   */
  readonly launchable: boolean
  /** Whether a command of the same name already claims the leading-slash gesture. */
  readonly shadowed: boolean
}

/**
 * Turn the effective catalog into inspector rows.
 * @param skills - every effective skill, including model-only ones.
 * @param commandNames - every name the command registries already claim.
 * @returns one row per skill, in the registry's own sorted order.
 */
export function skillRows(
  skills: readonly SkillView[],
  commandNames: Iterable<string>,
): readonly SkillRow[] {
  const claimed = new Set(commandNames)
  return skills.map(skill => {
    const shadowed = claimed.has(skill.name)
    return { skill, shadowed, launchable: skill.userInvocable && !shadowed }
  })
}

/**
 * Rows matching a typed filter.
 *
 * Name and description are matched because both are on screen. `whenToUse` is
 * matched as well because it is shown for the selected row and costs one more
 * `includes` — but nothing hidden from every surface is ever matchable.
 * @param rows - the rows to filter.
 * @param query - raw filter text.
 * @returns the matching rows, in their original order.
 */
export function filterSkillRows(rows: readonly SkillRow[], query: string): readonly SkillRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return rows
  return rows.filter(row =>
    row.skill.name.toLowerCase().includes(needle) ||
    row.skill.description.toLowerCase().includes(needle) ||
    (row.skill.whenToUse ?? '').toLowerCase().includes(needle))
}
