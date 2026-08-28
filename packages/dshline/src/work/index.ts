/**
 * Optional adapters for the Harness jobs and subagents seams.
 *
 * The class retains only lifecycle edges that Harness publishes and re-reads
 * snapshots/discovery from the services. It is intentionally not a second job
 * or subagent runtime.
 * @module dshline/work
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobRegistry, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type {
  SubagentListEntry,
  SubagentRunEndInfo,
  SubagentRunInfo,
  SubagentRuntime,
} from '@deepseek-ai/dsh-subagent'
import type {
  JobWorkItem,
  SubagentWorkItem,
  WorkInterruptResult,
  WorkSnapshot,
} from './model.ts'

/** Discovery facts retained only when the direct-child projection served them. */
interface DiscoveredSubagent {
  readonly mode?: 'one-shot' | 'continuable'
  readonly label?: string
  readonly residency?: 'resident' | 'stored'
  readonly hasChildren?: boolean
}

/**
 * One open lifecycle epoch. Keyed by the harness `runId` so a continuable
 * child that cold-resumes acquires a new epoch under the same durable session
 * id without collapsing two different residency observations into one row.
 */
interface LiveSubagent {
  readonly runId: string
  /** Durable child session id, stable across Activations. */
  readonly id: string
  readonly provider: string
  /** Snapshot of whether `SubagentRun.localAgent` was present at start. */
  readonly local: boolean
  readonly startedAt: number
}

/** Services and lifecycle observers the work projection consumes. */
export interface WorkCapabilities {
  /** The current agent owns job reads and interruption authorization. */
  readonly agent: Agent
  /** Optional generic background-job registry. */
  readonly jobs?: JobRegistry
  /** Optional generic subagent runtime. */
  readonly subagents?: SubagentRuntime
  /** Ask the scoped parent context for lifecycle starts. */
  readonly onSubagentStart?: (listener: (info: SubagentRunInfo) => void) => () => void
  /** Ask the scoped parent context for lifecycle ends. */
  readonly onSubagentEnd?: (listener: (info: SubagentRunEndInfo) => void) => () => void
  /** Redraw the live region after a capability projection changes. */
  readonly invalidate: () => void
}

/**
 * Projects optional Harness work capabilities for terminal views.
 *
 * The only retained subagent state is the open lifecycle edge. Labels, mode,
 * residency, and child presence are repeatedly read from the direct-parent
 * `listChildren()` projection, while jobs are read directly from `list()` and
 * never through the consuming `read()` API.
 */
export class HarnessWork {
  private readonly liveSubagents = new Map<string, LiveSubagent>()
  private readonly discovered = new Map<string, DiscoveredSubagent>()
  private readonly disposers: (() => void)[] = []
  private listingGeneration = 0

  constructor(private readonly capabilities: WorkCapabilities) {
    const { jobs, onSubagentStart, onSubagentEnd } = capabilities
    if (jobs !== undefined) {
      // This is the pure observation seam. Completion delivery has model-facing
      // reporting semantics, so the view must not subscribe to it just to redraw.
      this.disposers.push(jobs.onJobsChanged(owner => {
        if (owner === undefined || owner === capabilities.agent) capabilities.invalidate()
      }))
    }
    if (capabilities.subagents !== undefined) {
      if (onSubagentStart !== undefined) this.disposers.push(onSubagentStart(info => {
        this.liveSubagents.set(String(info.runId), {
          runId: String(info.runId),
          id: String(info.id),
          provider: info.provider,
          local: info.local,
          startedAt: Date.now(),
        })
        this.refreshSubagents()
        capabilities.invalidate()
      }))
      if (onSubagentEnd !== undefined) this.disposers.push(onSubagentEnd(info => {
        this.liveSubagents.delete(String(info.runId))
        this.refreshSubagents()
        capabilities.invalidate()
      }))
      this.refreshSubagents()
    }
  }

  /** Stop listening to capability changes. */
  dispose(): void {
    this.listingGeneration += 1
    for (const dispose of this.disposers.splice(0)) dispose()
  }

  /**
   * Read the current capability-owned work records.
   * @returns active jobs and observed active subagent lifecycle epochs.
   */
  snapshot(): WorkSnapshot {
    const { jobs, subagents, agent } = this.capabilities
    return {
      available: jobs !== undefined || subagents !== undefined,
      subagents: [...this.liveSubagents.values()].map(run => this.subagentItem(run)),
      jobs: jobs === undefined ? [] : this.jobItems(jobs, agent),
    }
  }

  /**
   * Interrupt work only where the owning generic seam exposes authority to do so.
   *
   * The operation is Harness `interrupt()` on a live continuable child: it
   * cancels the current turn, keeps the Activation, inbox, and descendants, and
   * is a fire-and-return signal rather than a deletion of the durable child.
   * @param item - selected work item.
   */
  interrupt(item: JobWorkItem | SubagentWorkItem): WorkInterruptResult {
    const { agent, subagents } = this.capabilities
    // Job cancellation marks a record reported, changing model-delivery
    // semantics. `/work` observes jobs but must not recreate that control path.
    if (item.source === 'job') return { kind: 'unsupported', message: 'Jobs cannot be stopped from Work.' }
    try {
      // One-shot runs have no service-level interrupt operation. Pretending they
      // do would lie about a capability that only their holder owns.
      if (subagents === undefined || !item.stoppable) {
        return { kind: 'unsupported', message: 'This subagent cannot be interrupted here.' }
      }
      subagents.interrupt(item.id as Parameters<SubagentRuntime['interrupt']>[0], {
        kind: 'user', parentSessionId: agent.session.id,
      })
      this.capabilities.invalidate()
      return { kind: 'requested', message: 'Interrupt requested.' }
    } catch (error: unknown) {
      // Authorization and producer-cancellation errors are actionable. Return
      // them to the overlay rather than letting a stale row make failure silent.
      const message = error instanceof Error ? error.message : String(error)
      this.capabilities.invalidate()
      return { kind: 'failed', message: `Interrupt failed: ${message}` }
    }
  }

  /** Read labels, mode, residency, and child presence from direct-child discovery. */
  private refreshSubagents(): void {
    const subagents = this.capabilities.subagents
    if (subagents === undefined) return
    const generation = ++this.listingGeneration
    void subagents.listChildren(this.capabilities.agent.session.id)
      .then(entries => {
        if (generation !== this.listingGeneration) return
        this.discovered.clear()
        for (const entry of entries) this.remember(entry)
        this.capabilities.invalidate()
      })
      // Discovery is optional enrichment. The lifecycle edges remain useful if a
      // profile intentionally lacks the projection or persistence services.
      .catch(() => {})
  }

  /**
   * Store only discovery facts the service explicitly returned.
   *
   * `activity` is session-store residency — a live or persisted record slot,
   * not a model turn in flight — so it is mapped to residency wording rather
   * than presented as progress.
   */
  private remember(entry: SubagentListEntry): void {
    if (entry.kind !== 'child') return
    this.discovered.set(String(entry.id), {
      mode: entry.mode,
      residency: entry.activity === 'running' ? 'resident' : 'stored',
      hasChildren: entry.hasChildren,
      ...entry.label === undefined ? {} : { label: entry.label },
    })
  }

  /** Convert non-terminal job snapshots without consuming their output cursor. */
  private jobItems(jobs: JobRegistry, agent: Agent): JobWorkItem[] {
    let snapshots: JobSnapshot[]
    try {
      snapshots = jobs.list(agent)
    } catch {
      return []
    }
    return snapshots
      .filter((snapshot): snapshot is JobSnapshot & { status: 'running' | 'stopping' } => (
        snapshot.status === 'running' || snapshot.status === 'stopping'
      ))
      .map(snapshot => ({
        id: String(snapshot.id),
        source: 'job' as const,
        kind: snapshot.kind,
        label: snapshot.label,
        state: snapshot.status,
        startedAt: snapshot.startedAt,
        ...snapshot.detail === undefined ? {} : { detail: snapshot.detail },
        // `jobs.kill()` changes model-delivery (`reported`) semantics. It is a
        // model control operation, not a human-safe Work action.
        ownership: snapshot.ownerSession === agent.session.id ? 'this-session' as const : 'unowned' as const,
        stoppable: false as const,
      }))
  }

  /** Convert a published lifecycle edge, enriching it only with discovery data. */
  private subagentItem(run: LiveSubagent): SubagentWorkItem {
    const discovered = this.discovered.get(run.id)
    return {
      id: run.id,
      source: 'subagent',
      runId: run.runId,
      provider: run.provider,
      local: run.local,
      state: 'running',
      startedAt: run.startedAt,
      stoppable: discovered?.mode === 'continuable',
      ...discovered?.label === undefined ? {} : { label: discovered.label },
      ...discovered?.mode === undefined ? {} : { mode: discovered.mode },
      ...discovered?.residency === undefined ? {} : { residency: discovered.residency },
      ...discovered?.hasChildren === undefined ? {} : { hasChildren: discovered.hasChildren },
    }
  }
}

/**
 * Connect the work projection to this runner's optional services and scoped
 * parent lifecycle events.
 * @param ctx - host context holding optional generic services.
 * @param agent - session agent whose work the view may present.
 * @param invalidate - redraw request for projection changes.
 * @returns the internal work integration.
 */
export function createHarnessWork(ctx: Context, agent: Agent, invalidate: () => void): HarnessWork {
  const jobs = ctx.get('jobs')
  const subagents = ctx.get('subagents')
  if (subagents !== undefined) {
    const lifecycle = {
      subagents,
      // Register on the parent agent's context: Harness scopes these lifecycle
      // edges by the delegating parent, so another session cannot leak into this UI.
      onSubagentStart: (listener: (info: SubagentRunInfo) => void) => agent.ctx.on('subagent/start', listener),
      onSubagentEnd: (listener: (info: SubagentRunEndInfo) => void) => agent.ctx.on('subagent/end', listener),
    }
    return jobs === undefined
      ? new HarnessWork({ agent, ...lifecycle, invalidate })
      : new HarnessWork({ agent, jobs, ...lifecycle, invalidate })
  }
  return jobs === undefined
    ? new HarnessWork({ agent, invalidate })
    : new HarnessWork({ agent, jobs, invalidate })
}
