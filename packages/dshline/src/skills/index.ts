/**
 * The `/skills` browser: what it needs, and how it is opened.
 *
 * The catalog itself is NOT here. `./catalog.ts` is imported by the
 * attachment directly, because the slash menu and the submit adjudication
 * need it whether or not this browser is ever opened; this module is the
 * heavy half, loaded on demand exactly as `/plugins` and `/profiles` are.
 * @module dshline/skills
 */

import type { Context } from '@deepseek-ai/cordis'
import { createSkillsOverlay } from './overlay.ts'
import type { SkillCatalog } from './catalog.ts'

export type { SkillCatalogReading, SkillCatalogSpec, SkillVerdict } from './catalog.ts'
export { SkillCatalog } from './catalog.ts'
export type { SkillRow, SkillView, SlashCandidate } from './model.ts'
export {
  filterSkillRows,
  invocationLabel,
  skillNote,
  skillRows,
  slashCandidates,
  sourceLabel,
} from './model.ts'
export type { SkillsOverlaySpec } from './overlay.ts'
export { createSkillsOverlay } from './overlay.ts'

/** What opening the browser needs from the attachment it opens over. */
export interface SkillsSpec {
  /** Context carrying the slot registry. */
  readonly ctx: Context
  /** The session's live catalog. */
  readonly catalog: SkillCatalog
  /** Names the command registries already claim, for the shadowing rule. */
  readonly commandNames: () => Iterable<string>
}

/**
 * Show the Skills browser and stay until the reader closes it.
 * @param spec - the context, the catalog, and the claimed command names.
 * @returns the skill whose literal `/name ` the Composer should receive, or
 *   nothing when the reader closed the browser without choosing one.
 */
export async function openSkills(spec: SkillsSpec): Promise<string | undefined> {
  const { ctx, catalog } = spec
  return new Promise<string | undefined>(resolve => {
    let dismiss = (): void => {}
    let settled = false
    let picked: string | undefined
    const settle = (): void => {
      // Once-only, for the reason every overlay here settles once: the slot
      // registry can deliver one more keystroke between the decision and the
      // unmount.
      if (settled) return
      settled = true
      dismiss()
      resolve(picked)
    }
    const overlay = createSkillsOverlay({
      reading: () => catalog.reading(),
      commandNames: spec.commandNames,
      insert: name => { picked = name },
      close: settle,
      invalidate: () => { ctx.tuiSlots.invalidate() },
    })
    dismiss = ctx.tuiSlots.pushOverlay(overlay)
  })
}
