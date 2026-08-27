/**
 * Semantic activity derived from Harness-native model and tool presentation.
 * @module dshline/activity
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'

/** The model-side phase visible while no foreground tool outranks it. */
export type ModelPhase = 'waiting' | 'thinking' | 'responding'

/** The conservative activity vocabulary derived from a pending tool's view. */
export type ToolActivity = 'reading' | 'searching' | 'fetching' | 'editing' | 'running' | 'working'

/** One presentation word for the status line's current activity. */
export type ActivityWord = ModelPhase | ToolActivity

/**
 * Fold one live session event into the model's current semantic phase.
 * @param phase - the phase before this event.
 * @param event - one event from the live session feed.
 * @returns the phase after the event, preserving it for unknown future events.
 */
export function modelPhaseAfter(phase: ModelPhase, event: SessionEvent): ModelPhase {
  switch (event.type) {
    case 'turn/start':
    case 'step/start':
    case 'step/end':
    case 'assistant/message':
    // A closed turn is no longer producing anything: `turn/end` may arrive
    // while the agent still drains, and the finished phase would be stale
    // for that stretch. The next turn opens at `waiting` anyway.
    case 'turn/end':
      return 'waiting'
    case 'assistant/chunk':
      if (event.data.chunk.type === 'reasoning-delta' && event.data.chunk.text !== '') return 'thinking'
      if (event.data.chunk.type === 'text-delta' && event.data.chunk.text !== '') return 'responding'
      return phase
    default:
      return phase
  }
}

/**
 * Classify one resolved call presentation without interpreting its tool name or text.
 * @param view - the call view returned by the definition that actually ran.
 * @returns the semantic tool activity, conservatively falling back to `working`.
 */
export function toolActivity(view: ToolCallView | undefined): ToolActivity {
  if (view === undefined) return 'working'
  if (view.card === 'terminal') return 'running'
  if (view.card === 'diff') return 'editing'
  if (view.card !== 'generic') return 'working'
  switch (view.kind) {
    case 'read':
      return 'reading'
    case 'search':
      return 'searching'
    case 'fetch':
      return 'fetching'
    case 'edit':
    case 'delete':
    case 'move':
      return 'editing'
    case 'execute':
      return 'running'
    case 'other':
    case undefined:
    default:
      return 'working'
  }
}

/**
 * Choose the status word, letting an outstanding foreground tool outrank the model.
 * @param phase - the latest model-side phase.
 * @param pending - the aggregate activity of pending foreground calls.
 * @returns the tool activity when present, otherwise the model phase.
 */
export function primaryActivity(phase: ModelPhase, pending: ToolActivity | undefined): ActivityWord {
  return pending === undefined ? phase : pending
}
