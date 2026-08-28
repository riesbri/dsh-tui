/**
 * Shared pending-tool fold for semantic activity.
 *
 * Both the main status line and the Work child observers derive "what is this
 * agent doing right now" from the same two pure surfaces: the tool's own
 * `presentCall` presentation (never its name) and the semantic vocabulary in
 * `activity.ts`. This module owns the bounded bookkeeping of calls still
 * awaiting a result so the two consumers fold identically instead of forking
 * a second copy.
 * @module dshline/tool-pending
 */

import type { FileDiff, ToolCallView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { toolActivity } from './activity.ts'
import type { ToolActivity } from './activity.ts'

/** Inputs one tool call needs to be remembered until its result arrives. */
export interface PendingCallInput {
  /** The call id its result will answer with. */
  readonly callId: string
  /** The tool name, for resolving the definition that actually ran. */
  readonly name: string
  /** The logged argument JSON, verbatim. */
  readonly arguments: string
}

/** The retained semantic facts of one pending call. */
export interface PendingToolEntry {
  /** The tool name the call was issued to. */
  readonly name: string
  /** Semantic activity resolved from the call's presentation. */
  readonly activity: ToolActivity
  /** Presentation title, when the declaring tool supplied one. */
  readonly title?: string
  /** Parsed arguments, or undefined when the model's JSON did not parse. */
  readonly args: unknown
  /** The diff the call proposed, kept only as a presentation fallback. */
  readonly diffs?: readonly FileDiff[]
  /** The resolved call presentation, when the tool declared one. */
  readonly view?: ToolCallView
}

/**
 * Run a presenter, treating a throw as "declared nothing".
 *
 * Presenters read the model's arguments, which may be any JSON at all. A frontend
 * that let one throw would take down the whole render on a malformed call, so a
 * failure degrades to the raw-content fallback the intent already documents.
 * @param present - the presenter call.
 * @returns the view, or undefined when there is none.
 */
export function present<T>(present: () => T | undefined): T | undefined {
  try {
    return present()
  } catch {
    // A presenter that cannot describe these arguments is not an error the user
    // can act on; the raw content is still shown.
    return undefined
  }
}

/**
 * Parse a call's logged argument JSON.
 *
 * The harness logs the model's arguments verbatim, malformed included, precisely
 * so a bad call stays reconstructable. Unparseable JSON therefore yields no args
 * rather than an error.
 * @param raw - the logged arguments string.
 * @returns the parsed value, or undefined.
 */
export function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // Malformed model JSON; the caller shows the raw string instead.
    return undefined
  }
}

/**
 * The bounded fold of tool calls still awaiting a result.
 *
 * Resolves the definition exactly as the calling agent sees it (a scoped tool
 * can shadow a global one), reads the call presentation, and classifies the
 * semantic activity from that presentation. The consumer supplies the lookup;
 * this class owns only the fold.
 */
export class PendingToolCalls {
  protected readonly pending = new Map<string, PendingToolEntry>()

  /**
   * @param lookup - resolves a tool definition as the calling agent sees it.
   */
  constructor(protected readonly lookup: (name: string) => ToolDefinition | undefined) {}

  /**
   * Remember one issued call and its resolved presentation.
   * @param input - the logged call identity and arguments.
   * @returns the retained entry, for consumers that also render from the view.
   */
  handleCall(input: PendingCallInput): PendingToolEntry {
    const args = parseArguments(input.arguments)
    const view = present(() => this.lookup(input.name)?.presentCall?.(args))
    const entry: PendingToolEntry = {
      name: input.name,
      activity: toolActivity(view),
      args,
      ...view === undefined ? {} : { title: view.title, view },
      ...view?.card === 'diff' ? { diffs: view.diffs } : {},
    }
    this.pending.set(input.callId, entry)
    return entry
  }

  /** Forget the call a result just answered. */
  handleResult(callId: string): void {
    this.pending.delete(callId)
  }

  /** Forget every unanswered call, for a turn that ended without its results. */
  reset(): void {
    this.pending.clear()
  }

  /**
   * Aggregate the semantic activity of every call still awaiting a result.
   * @returns the shared activity, `working` for a mixed set, or undefined when empty.
   */
  semanticActivity(): ToolActivity | undefined {
    let activity: ToolActivity | undefined
    for (const call of this.pending.values()) {
      if (activity === undefined) activity = call.activity
      else if (activity !== call.activity) return 'working'
    }
    return activity
  }

  /**
   * The newest pending call's presentation title, when its tool declared one.
   *
   * The newest entry is the only ordering a `Map` can honestly claim: the
   * harness publishes no per-call progress, and the fallback to a tool NAME is
   * deliberately absent here — a title derived from raw tool names is exactly
   * the classification this fold exists to avoid.
   * @returns the newest declared title, or undefined when none is declared.
   */
  latestTitle(): string | undefined {
    let latest: PendingToolEntry | undefined
    for (const call of this.pending.values()) latest = call
    return latest?.title
  }

  /** How many calls are still awaiting a result. */
  count(): number {
    return this.pending.size
  }
}
