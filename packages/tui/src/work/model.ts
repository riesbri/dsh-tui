/**
 * Small, presentation-facing vocabulary for Harness work.
 *
 * These rows are snapshots of capability-owned records. They deliberately do
 * not expose producer output or attempt to merge jobs and subagents: those are
 * different Harness authorities and may describe the same operation.
 * @module @riesbri/dsh-tui/work/model
 */

/** A unit of active work the terminal can present. */
export interface WorkItem {
  /** Stable identity inside its owning capability. */
  readonly id: string
  /** Capability that owns this record. */
  readonly source: 'job' | 'subagent'
  /** Generic producer/provider name, when Harness exposed one. */
  readonly provider?: string
  /** Harness-provided label, when its discovery projection exposed one. */
  readonly label?: string
  /** Current lifecycle wording supplied by Harness. */
  readonly state: 'running' | 'stopping'
  /** Epoch milliseconds when the lifecycle edge was observed or record started. */
  readonly startedAt: number
  /** Whether Harness exposes a generic human-safe interrupt for this exact item. */
  readonly stoppable: boolean
}

/** The current projection of the optional jobs and subagents capabilities. */
export interface WorkSnapshot {
  /** Whether either optional work capability is available. */
  readonly available: boolean
  /** Active subagent lifecycle epochs. */
  readonly subagents: readonly WorkItem[]
  /** Current job-registry snapshots that have not settled. */
  readonly jobs: readonly WorkItem[]
}

/** The outcome of asking an owning Harness seam to stop one work item. */
export interface WorkStopResult {
  /** Whether Harness accepted, rejected, or cannot stop the request. */
  readonly kind: 'requested' | 'unsupported' | 'failed'
  /** A short, user-facing account of the request outcome. */
  readonly message: string
}

/**
 * Build the optional work summary without abbreviating its counts.
 * @param snapshot - current work projection.
 * @returns a whole-segment status label, or undefined when there is no work.
 */
export function workSummary(snapshot: WorkSnapshot): string | undefined {
  const agents = snapshot.subagents.length
  const jobs = snapshot.jobs.length
  if (agents === 0 && jobs === 0) return undefined
  const parts: string[] = []
  if (agents > 0) parts.push(`${String(agents)} ${agents === 1 ? 'agent' : 'agents'}`)
  if (jobs > 0) parts.push(`${String(jobs)} ${jobs === 1 ? 'job' : 'jobs'}`)
  return parts.join(' · ')
}

/**
 * How many work items are attached to the session.
 *
 * Counted across both capabilities without merging them: the sum answers one
 * question — is anything still running under this agent — which is what a
 * lifecycle decision such as retiring the agent needs, and it needs no
 * correlation between a job and a subagent to be true.
 * @param snapshot - current work projection.
 * @returns the number of active jobs and subagents.
 */
export function activeWorkCount(snapshot: WorkSnapshot): number {
  return snapshot.subagents.length + snapshot.jobs.length
}
