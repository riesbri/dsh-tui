/**
 * Small, presentation-facing vocabulary for Harness work.
 *
 * These rows are snapshots of capability-owned records. Jobs, subagents, and
 * workflow runs remain a discriminated union because their identifiers,
 * lifecycle facts, and human controls come from different Harness authorities;
 * a shared shape would imply a relationship Harness never publishes.
 *
 * The ONE correlation this module accepts is the workflow member's
 * `childId` — the subagent-seam session id Harness itself publishes on
 * `workflow/agent-start` and in the durable `tool-workflow/agent-start`
 * record. Everything else stays separate.
 * @module dshline/work/model
 */

import type { WorkflowAgentOutcome, WorkflowPhase, WorkflowStopReason } from '@deepseek-ai/dsh-workflow/types'
import type { ActivityWord } from '../activity.ts'

/** Facts common to a current Work row. */
interface WorkItemBase {
  /** Stable identity inside the owning capability. */
  readonly id: string
  /** Harness-provided one-line label, when that authority supplied one. */
  readonly label?: string
  /** Epoch milliseconds when the record or observed lifecycle edge began. */
  readonly startedAt: number
}

/** A non-terminal background Job projected from `ctx.jobs`. */
export interface JobWorkItem extends WorkItemBase {
  /** The capability authority that owns this record. */
  readonly source: 'job'
  /** Producer-defined opaque Job kind. */
  readonly kind: string
  /** Harness requires a one-line label for every Job record. */
  readonly label: string
  /** Current Job lifecycle state. */
  readonly state: 'running' | 'stopping'
  /** Producer-defined active detail, when the Job supplied it. */
  readonly detail?: string
  /** Whether the listing proves this Job belongs to this session or is unowned. */
  readonly ownership: 'this-session' | 'unowned'
  /** Jobs have no human Work interrupt: `jobs.kill()` changes delivery semantics. */
  readonly interruptible: false
}

/** A currently open subagent lifecycle epoch projected from `ctx.subagents`. */
export interface SubagentWorkItem extends WorkItemBase {
  /** The capability authority that owns this record. */
  readonly source: 'subagent'
  /** Lifecycle identity for this run or continuable Activation epoch. */
  readonly runId: string
  /** Provider recorded by Harness when this lifecycle epoch started. */
  readonly provider: string
  /**
   * Snapshot of whether `SubagentRun.localAgent` was present when the run
   * started: whether the child was published as an in-process agent. It says
   * nothing about where the provider's model traffic goes.
   */
  readonly local: boolean
  /** An open lifecycle edge is Work's authoritative active-row source. */
  readonly state: 'running'
  /** Durable descriptor mode, when direct-child discovery has resolved it. */
  readonly mode?: 'one-shot' | 'continuable'
  /**
   * Durable session-store residency from direct-child discovery, when available.
   * `resident` is deliberately not a claim that a model turn is executing.
   */
  readonly residency?: 'resident' | 'stored'
  /** Whether direct-child discovery reported any durable subagent children. */
  readonly hasChildren?: boolean
  /**
   * The live child's semantic activity, folded from its own session events and
   * tool presentations. Absent when no in-process child Agent is observable —
   * a remote one-shot run exposes no granular state here.
   */
  readonly activityWord?: ActivityWord
  /**
   * The newest pending tool call's presentation title, present only when the
   * declaring tool supplied one in its `presentCall` view.
   */
  readonly activityTitle?: string
  /** Whether the live child Agent is running, driving the row's spinner. */
  readonly busy?: boolean
  /** The live child Agent's published status, for the detail stage. */
  readonly agentStatus?: 'idle' | 'running'
  /** Continuable children alone expose Harness's human interrupt authority. */
  readonly interruptible: boolean
}

/**
 * One published `agent()` call of an owned workflow run.
 *
 * Every field is a durable `tool-workflow/agent-start` / `agent-end` fact.
 * A call the provider never published emits no record at all, so this list is
 * never padded with invented pending members.
 */
export interface WorkflowMemberItem {
  /** 1-based sequence number of the `agent()` call inside its run. */
  readonly seq: number
  /** The member's display label, verbatim from the record. */
  readonly label: string
  /**
   * The phase the member belongs to, exactly as recorded. Absent and empty are
   * DIFFERENT groups: the record omits the field for an unphased call, and an
   * empty title is a phase the script actually named that way.
   */
  readonly phase?: string
  /** The child agent's id on the subagent seam — Harness's own correlation. */
  readonly childId: string
  /** How the call settled; absent while it is still open. */
  readonly outcome?: WorkflowAgentOutcome
  /**
   * The live subagent row this member's `childId` resolves to, when an open
   * lifecycle epoch for that exact child session exists right now. This is the
   * only place Work joins two authorities, and only on a Harness-published id.
   */
  readonly subagent?: SubagentWorkItem
}

/** One workflow run owned by the attached session, from its durable records. */
export interface WorkflowWorkItem extends WorkItemBase {
  /** The capability authority that owns this record. */
  readonly source: 'workflow'
  /** The run id; also this row's identity. */
  readonly id: string
  /** The workflow's `meta.name`, recorded durably when the run opened. */
  readonly label: string
  /** `meta.description`, available only from live `workflow/*` enrichment. */
  readonly description?: string
  /** `meta.phases`, available only from live `workflow/*` enrichment. */
  readonly declaredPhases?: readonly WorkflowPhase[]
  /** The newest `phase(title)` narration, from live enrichment. */
  readonly phase?: string
  /** The newest `log(message)` narration, from live enrichment. */
  readonly log?: string
  /**
   * `running` until the engine reports a stop reason. A settled run keeps its
   * row only until its durable `tool-workflow/run-end` closes the record, so
   * the terminal state is visible without any timer owning it.
   */
  readonly state: 'running' | WorkflowStopReason
  /** The run's published members, in record order. */
  readonly members: readonly WorkflowMemberItem[]
  /** `agentsStarted` from the live `workflow/end` payload, once it settled. */
  readonly agentsStarted?: number
  /** The engine publishes no run handle to a UI, so Work exposes no control. */
  readonly interruptible: false
}

/** A unit of active work the terminal can present. */
export type WorkItem = JobWorkItem | SubagentWorkItem | WorkflowWorkItem

/** The current projection of the optional work capabilities. */
export interface WorkSnapshot {
  /** Whether either optional work capability is available. */
  readonly available: boolean
  /** Workflow runs this session's own durable records prove it owns. */
  readonly workflows: readonly WorkflowWorkItem[]
  /**
   * Every active subagent lifecycle epoch, workflow members included. The
   * projection reports each authority in full; grouping a member under its
   * workflow is a presentation decision, made where the rows are drawn.
   */
  readonly subagents: readonly SubagentWorkItem[]
  /** Current job-registry snapshots that have not settled. */
  readonly jobs: readonly JobWorkItem[]
}

/** The outcome of asking Harness to interrupt one selected Work row. */
export interface WorkInterruptResult {
  /** Whether Harness accepted, rejected, or cannot interrupt the request. */
  readonly kind: 'requested' | 'unsupported' | 'failed'
  /** A short, user-facing account of the request outcome. */
  readonly message: string
}

/**
 * What a Work mark claims, before any glyph is chosen.
 *
 * The rule the whole view obeys: `executing` — the only animated mark — means
 * dshline holds EVIDENCE of running computation, which today means a live
 * in-process child Agent whose status is `running`. `active` means a lifecycle
 * exists while its internals are not observable, and `record` means a
 * background registry record exists, which is weaker still. Terminal marks
 * report a settlement Harness published.
 */
export type WorkMark =
  | 'executing'
  | 'active'
  | 'record'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * Whether an open workflow member is observably executing right now.
 * @param member - one published workflow member.
 * @returns true only with a joined live child Agent that Harness says is running.
 */
function memberExecuting(member: WorkflowMemberItem): boolean {
  return member.outcome === undefined && member.subagent?.busy === true
}

/**
 * Classify one workflow member's mark.
 * @param member - one published workflow member.
 * @returns the mark its recorded outcome and joined child justify.
 */
export function memberMark(member: WorkflowMemberItem): WorkMark {
  switch (member.outcome) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return memberExecuting(member) ? 'executing' : 'active'
  }
}

/**
 * Classify one Work row's mark from the authority that owns it.
 *
 * A Job in `running` is deliberately NOT animated: the registry record says a
 * producer holds the job, not that computation is being observed. A workflow
 * animates only while one of its own members does, because the engine publishes
 * no execution signal of its own between `agent()` calls.
 * @param item - the row to classify.
 * @returns the mark the row's authoritative facts justify.
 */
export function workMark(item: WorkItem): WorkMark {
  if (item.source === 'job') return item.state === 'stopping' ? 'stopping' : 'record'
  if (item.source === 'subagent') return item.busy === true ? 'executing' : 'active'
  switch (item.state) {
    case 'completed':
      return 'completed'
    case 'error':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return item.members.some(memberExecuting) ? 'executing' : 'active'
  }
}

/**
 * Members of an owned, still-running workflow whose child is live right now.
 *
 * Presentation uses this to show a workflow's own subagents under the workflow
 * instead of a second time in the flat Subagents section. It is a join on
 * Harness's `childId`, so the two rows are provably the same child; a settled
 * member releases its claim, and so does a settled run.
 * @param workflows - the owned workflow rows.
 * @returns child session ids currently presented by a workflow.
 */
export function workflowClaimedChildren(workflows: readonly WorkflowWorkItem[]): ReadonlySet<string> {
  const claimed = new Set<string>()
  for (const workflow of workflows) {
    if (workflow.state !== 'running') continue
    for (const member of workflow.members) {
      if (member.outcome === undefined && member.subagent !== undefined) claimed.add(member.childId)
    }
  }
  return claimed
}

/**
 * Build the optional work summary without abbreviating its counts.
 * @param snapshot - current work projection.
 * @returns a whole-segment status label, or undefined when there is no work.
 */
export function workSummary(snapshot: WorkSnapshot): string | undefined {
  const workflows = snapshot.workflows.length
  const subagents = snapshot.subagents.length
  const jobs = snapshot.jobs.length
  if (workflows === 0 && subagents === 0 && jobs === 0) return undefined
  const parts: string[] = []
  if (workflows > 0) parts.push(`${String(workflows)} ${workflows === 1 ? 'workflow' : 'workflows'}`)
  if (subagents > 0) parts.push(`${String(subagents)} ${subagents === 1 ? 'subagent' : 'subagents'}`)
  if (jobs > 0) parts.push(`${String(jobs)} ${jobs === 1 ? 'job' : 'jobs'}`)
  return parts.join(' · ')
}

/**
 * How many work items are attached to a session.
 *
 * Counted across the two capabilities that own real execution, without merging
 * them: the sum answers one question — is anything still running under this
 * agent — which is what a lifecycle decision such as retiring the agent needs,
 * and it needs no correlation between a job and a subagent to be true. Workflow
 * runs are deliberately NOT added: a run's work is its members, and those are
 * already counted as subagents, so adding the run would count it twice.
 * @param snapshot - current work projection.
 * @returns the number of active jobs and subagents.
 */
export function activeWorkCount(snapshot: WorkSnapshot): number {
  return snapshot.subagents.length + snapshot.jobs.length
}

/**
 * Stable selection identity for a Work row.
 *
 * A continuable child may later acquire another lifecycle epoch with the same
 * durable session id, so its run id is part of the identity while the overlay
 * is open.
 * @param item - row whose identity the overlay retains.
 * @returns capability-scoped selection key.
 */
export function workItemKey(item: WorkItem): string {
  if (item.source === 'subagent') return `subagent:${item.runId}`
  if (item.source === 'workflow') return `workflow:${item.id}`
  return `job:${item.id}`
}

/**
 * Stable selection identity for one workflow member row.
 * @param workflow - the run the member belongs to.
 * @param member - the published member.
 * @returns a run-scoped member key, stable across live updates.
 */
export function workflowMemberKey(workflow: WorkflowWorkItem, member: WorkflowMemberItem): string {
  return `member:${workflow.id}:${String(member.seq)}`
}
