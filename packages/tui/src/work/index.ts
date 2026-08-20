/**
 * Optional adapters for the Harness jobs and subagents seams.
 *
 * The class retains only lifecycle edges that Harness publishes and re-reads
 * snapshots/discovery from the services. It is intentionally not a second job
 * or subagent runtime.
 * @module @riesbri/dsh-tui/work
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobRegistry, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type {
  SubagentDescendantListEntry,
  SubagentRunEndInfo,
  SubagentRunInfo,
  SubagentRuntime,
} from '@deepseek-ai/dsh-subagent'
import type { WorkItem, WorkSnapshot } from './model.ts'

interface DiscoveredSubagent {
  readonly label?: string
  readonly mode: 'one-shot' | 'continuable'
}

interface LiveSubagent {
  readonly id: string
  readonly provider: string
  readonly startedAt: number
}

/** Services and lifecycle observers the work projection consumes. */
export interface WorkCapabilities {
  /** The current agent owns job reads and cancellation authorization. */
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
 * The only retained subagent state is the open lifecycle edge. Labels and
 * continuable mode are repeatedly read from `listDescendants()`, while jobs
 * are read directly from `list()` and never through the consuming `read()` API.
 */
export class HarnessWork {
  private readonly liveSubagents = new Map<string, LiveSubagent>()
  private readonly discovered = new Map<string, DiscoveredSubagent>()
  private readonly disposers: (() => void)[] = []
  private listingGeneration = 0

  constructor(private readonly capabilities: WorkCapabilities) {
    const { jobs, onSubagentStart, onSubagentEnd } = capabilities
    if (jobs !== undefined) {
      this.disposers.push(jobs.onJobsChanged(owner => {
        if (owner === undefined || owner === capabilities.agent) capabilities.invalidate()
      }))
      this.disposers.push(jobs.onJobDone((_snapshot, owner) => {
        if (owner === undefined || owner === capabilities.agent) capabilities.invalidate()
      }))
    }
    if (capabilities.subagents !== undefined) {
      if (onSubagentStart !== undefined) this.disposers.push(onSubagentStart(info => {
        this.liveSubagents.set(String(info.runId), {
          id: String(info.id), provider: info.provider, startedAt: Date.now(),
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
   * Stop work only where the owning generic seam exposes authority to do so.
   * @param item - selected work item.
   */
  stop(item: WorkItem): void {
    const { agent, jobs, subagents } = this.capabilities
    try {
      if (item.source === 'job' && jobs !== undefined && item.stoppable) {
        jobs.kill(item.id as Parameters<JobRegistry['kill']>[0], agent, 'stopped from dsh-tui')
        return
      }
      // One-shot runs have no service-level interrupt operation. Pretending they
      // do would lie about a capability that only their holder owns.
      if (item.source === 'subagent' && subagents !== undefined && item.stoppable) {
        subagents.interrupt(item.id as Parameters<SubagentRuntime['interrupt']>[0], {
          kind: 'user', parentSessionId: agent.session.id,
        })
      }
    } catch {
      // Capability races (a settled job or released activation) are reflected by
      // the next authoritative listener/list refresh, not by stale local state.
    }
  }

  /** Read labels and continuable mode from the service's discovery projection. */
  private refreshSubagents(): void {
    const subagents = this.capabilities.subagents
    if (subagents === undefined) return
    const generation = ++this.listingGeneration
    void subagents.listDescendants(this.capabilities.agent.session.id)
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

  /** Store only discovery facts the service explicitly returned. */
  private remember(entry: SubagentDescendantListEntry): void {
    if (entry.kind !== 'child') return
    this.discovered.set(String(entry.id), {
      mode: entry.mode,
      ...entry.label === undefined ? {} : { label: entry.label },
    })
  }

  /** Convert non-terminal job snapshots without consuming their output cursor. */
  private jobItems(jobs: JobRegistry, agent: Agent): WorkItem[] {
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
        provider: snapshot.kind,
        label: snapshot.label,
        state: snapshot.status,
        startedAt: snapshot.startedAt,
        stoppable: snapshot.status === 'running',
      }))
  }

  /** Convert a published lifecycle edge, enriching it only with discovery data. */
  private subagentItem(run: LiveSubagent): WorkItem {
    const discovered = this.discovered.get(run.id)
    return {
      id: run.id,
      source: 'subagent',
      provider: run.provider,
      ...discovered?.label === undefined ? {} : { label: discovered.label },
      state: 'running',
      startedAt: run.startedAt,
      stoppable: discovered?.mode === 'continuable',
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
