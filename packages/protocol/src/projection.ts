import type {
  ChatMessage,
  Decomposition,
  HandoffRequest,
  Lease,
  MergeQueueEntry,
  Participant,
  Session,
  SessionSnapshot,
  Task,
  ValidationReport,
} from './domain.js'
import type { EventEnvelope } from './events.js'
import type { ParticipantId, TaskId } from './ids.js'
import { pathMatchesAny } from './glob.js'

/**
 * A task still occupying its owner's attention. A task sitting in `pr` is
 * waiting on CI or the merge queue, not on a human, so it does not count
 * against the claim cap -- otherwise a dev idles while their PR queues.
 */
const ACTIVE_STATES = new Set(['claimed', 'running', 'testing', 'failed'])

/** How many active tasks one participant may hold. Keeps the frontier fair. */
export const CLAIM_CAP = 1

/**
 * In-memory fold of one session's event log. Every mutation goes through the
 * log first and lands here second, so a reconnecting client replaying from
 * `fromSeq` converges on exactly this state.
 */
export class SessionState {
  session: Session | null = null
  seq = -1
  readonly participants = new Map<ParticipantId, Participant>()
  decomposition: Decomposition | null = null
  validation: ValidationReport | null = null
  readonly tasks = new Map<TaskId, Task>()
  /** Keyed by task: a lease exists exactly as long as its task is held. */
  readonly leases = new Map<TaskId, Lease>()
  readonly handoffs = new Map<string, HandoffRequest>()
  readonly chat: ChatMessage[] = []
  mergeQueue: MergeQueueEntry[] = []

  apply(envelope: EventEnvelope): void {
    /**
     * Applying is idempotent. A client can legitimately see the same event
     * twice -- a sync backlog overlapping live delivery, two sockets in one
     * page -- and appending a chat message or a task twice because of it would
     * be a real bug. Sequence numbers make "already seen" cheap to answer.
     */
    if (envelope.seq <= this.seq) return
    this.seq = envelope.seq
    const body = envelope.body

    switch (body.type) {
      case 'session.created':
        this.session = body.session
        break
      case 'session.phase':
        if (this.session) this.session = { ...this.session, phase: body.phase }
        break
      case 'session.lead':
        if (this.session) this.session = { ...this.session, leadId: body.leadId }
        break

      case 'participant.joined':
        this.participants.set(body.participant.id, body.participant)
        break
      case 'participant.left':
        this.participants.delete(body.participantId)
        break
      case 'participant.connection': {
        const participant = this.participants.get(body.participantId)
        if (participant) {
          this.participants.set(body.participantId, {
            ...participant,
            connected: body.connected,
          })
        }
        break
      }
      case 'participant.attached': {
        const participant = this.participants.get(body.participantId)
        if (participant) {
          this.participants.set(body.participantId, { ...participant, repoPath: body.repoPath })
        }
        break
      }
      case 'participant.activity': {
        const participant = this.participants.get(body.participantId)
        if (participant) {
          this.participants.set(body.participantId, { ...participant, activity: body.activity })
        }
        break
      }

      case 'plan.requested':
        if (this.session) this.session = { ...this.session, goal: body.goal, issueRef: body.issueRef }
        break
      case 'decomposition.proposed':
        this.decomposition = body.decomposition
        this.validation = body.validation
        break
      case 'decomposition.assigned':
        if (this.decomposition) {
          this.decomposition = { ...this.decomposition, assignments: body.assignments }
        }
        break
      case 'decomposition.approval':
        if (this.decomposition) {
          this.decomposition = {
            ...this.decomposition,
            approvals: body.approvals,
            status: body.satisfied ? 'approved' : this.decomposition.status,
          }
        }
        break
      case 'decomposition.rejected':
        if (this.decomposition) this.decomposition = { ...this.decomposition, status: 'rejected' }
        break
      case 'contract.committed':
        if (this.session) this.session = { ...this.session, contractBranch: body.branch }
        break

      case 'tasks.seeded':
        for (const task of body.tasks) this.tasks.set(task.id, task)
        break
      case 'task.assigned': {
        const task = this.tasks.get(body.taskId)
        if (task) this.tasks.set(body.taskId, { ...task, assigneeId: body.assigneeId })
        break
      }
      case 'task.state': {
        const task = this.tasks.get(body.taskId)
        if (task) {
          this.tasks.set(body.taskId, { ...task, state: body.state, ownerId: body.ownerId })
        }
        break
      }
      case 'task.branch': {
        const task = this.tasks.get(body.taskId)
        if (task) {
          this.tasks.set(body.taskId, {
            ...task,
            branch: body.branch,
            prNumber: body.prNumber,
          })
        }
        break
      }
      case 'task.test': {
        const task = this.tasks.get(body.taskId)
        if (task) this.tasks.set(body.taskId, { ...task, lastTest: body.result })
        break
      }

      case 'lease.granted':
        this.leases.set(body.lease.taskId, body.lease)
        break
      case 'lease.released':
        this.leases.delete(body.taskId)
        break
      case 'lease.denied':
        break // observability only; the deny already happened client-side
      case 'handoff.requested':
        this.handoffs.set(body.request.id, body.request)
        break
      case 'handoff.resolved': {
        const request = this.handoffs.get(body.requestId)
        if (request) {
          this.handoffs.set(body.requestId, {
            ...request,
            status: body.granted ? 'granted' : 'denied',
          })
        }
        break
      }

      case 'chat.message':
        this.chat.push(body.message)
        break

      case 'merge.queue':
        this.mergeQueue = body.entries
        break
      case 'merge.conflict':
      case 'integration.pr':
        break
    }
  }

  // -- derived -------------------------------------------------------------

  /**
   * Which lease, if any, covers this file. This is the whole lease gate: the
   * PreToolUse hook asks, and a hit from another participant is a hard deny.
   */
  findLeaseForPath(path: string): Lease | null {
    for (const lease of this.leases.values()) {
      if (pathMatchesAny(path, lease.paths)) return lease
    }
    return null
  }

  activeTaskCount(participantId: ParticipantId): number {
    let count = 0
    for (const task of this.tasks.values()) {
      if (task.ownerId === participantId && ACTIVE_STATES.has(task.state)) count++
    }
    return count
  }

  /** A task is claimable once every dependency has merged into the contract. */
  isReady(task: Task): boolean {
    if (task.ownerId !== null || task.state === 'merged') return false
    return task.dependsOn.every((dep) => this.tasks.get(dep)?.state === 'merged')
  }

  readyTasks(): Task[] {
    return [...this.tasks.values()].filter((task) => this.isReady(task))
  }

  /**
   * Pick the best ready task for a participant. Affinity keeps a dev in code
   * they already have loaded, and the longest task goes first so the critical
   * path starts early rather than being discovered at the end.
   */
  pickTaskFor(participantId: ParticipantId): Task | null {
    const touched = new Set<string>()
    for (const task of this.tasks.values()) {
      if (task.ownerId !== participantId) continue
      for (const glob of task.ownedPaths) touched.add(topLevel(glob))
    }

    /**
     * An assignment made during planning has to survive into `/ss:next`, or it
     * was decoration. Your own tasks come first, then anything nobody was given;
     * someone else's assignment is a last resort, taken only when the
     * alternative is sitting idle -- their agent will be handed something else.
     */
    const rank = (task: Task) =>
      task.assigneeId === participantId ? 0 : task.assigneeId === null ? 1 : 2

    const scored = this.readyTasks().map((task) => {
      const affinity = task.ownedPaths.some((glob) => touched.has(topLevel(glob))) ? 1 : 0
      const unblocks = [...this.tasks.values()].filter((t) =>
        t.dependsOn.includes(task.id),
      ).length
      return { task, affinity, unblocks, rank: rank(task) }
    })

    scored.sort(
      (a, b) =>
        a.rank - b.rank ||
        b.unblocks - a.unblocks ||
        b.affinity - a.affinity ||
        b.task.estimateMinutes - a.task.estimateMinutes ||
        a.task.id.localeCompare(b.task.id),
    )
    return scored[0]?.task ?? null
  }

  /** Tasks whose blocked/ready state no longer matches their dependencies. */
  staleStateTasks(): Task[] {
    return [...this.tasks.values()].filter((task) => {
      if (task.ownerId !== null || task.state === 'merged') return false
      const shouldBe = this.isReady(task) ? 'ready' : 'blocked'
      return task.state !== shouldBe
    })
  }

  /**
   * Adopts a cold-join snapshot. A fresh client is handed state rather than the
   * whole log, then applies live events on top from `seq` onward.
   */
  hydrate(snapshot: SessionSnapshot): void {
    this.session = snapshot.session
    this.participants.clear()
    for (const participant of snapshot.participants) {
      this.participants.set(participant.id, participant)
    }
    this.decomposition = snapshot.decomposition
    this.validation = snapshot.validation
    this.tasks.clear()
    for (const task of snapshot.tasks) this.tasks.set(task.id, task)
    this.leases.clear()
    for (const lease of snapshot.leases) this.leases.set(lease.taskId, lease)
    this.handoffs.clear()
    for (const handoff of snapshot.handoffs) this.handoffs.set(handoff.id, handoff)
    this.chat.length = 0
    this.chat.push(...snapshot.chat)
    this.mergeQueue = snapshot.mergeQueue
    this.seq = snapshot.seq
  }

  snapshot(): SessionSnapshot {
    if (!this.session) throw new Error('snapshot before session.created')
    return {
      session: this.session,
      participants: [...this.participants.values()],
      decomposition: this.decomposition,
      validation: this.validation,
      tasks: [...this.tasks.values()],
      leases: [...this.leases.values()],
      handoffs: [...this.handoffs.values()],
      chat: this.chat,
      mergeQueue: this.mergeQueue,
      seq: this.seq,
    }
  }
}

/** `src/theme/**` -> `src`. Coarse on purpose; affinity is a tiebreak, not a rule. */
function topLevel(glob: string): string {
  return glob.split('/')[0] ?? glob
}
