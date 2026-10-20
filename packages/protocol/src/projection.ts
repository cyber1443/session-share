import { usageDay, verificationHolds, weightedUnits } from './domain.js'
import type {
  ChatMessage,
  DailySpend,
  DailySummary,
  Profile,
  Decomposition,
  Sprint,
  Subticket,
  Ticket,
  TicketComment,
  TicketState,
  Usage,
  HandoffRequest,
  Lease,
  MergeQueueEntry,
  Participant,
  Session,
  SessionPhase,
  SessionSnapshot,
  Task,
  ValidationReport,
} from './domain.js'
import type { EventEnvelope } from './events.js'
import type { DecompositionId, ParticipantId, TaskId, TicketId } from './ids.js'
import { pathMatchesAny } from './glob.js'

/**
 * A task still occupying its owner's attention. A task sitting in `pr` is
 * waiting on CI or the merge queue, not on a human, so it does not count
 * against the claim cap -- otherwise a dev idles while their PR queues.
 */
const ACTIVE_STATES = new Set(['claimed', 'running', 'testing', 'failed'])

/** How many active tasks one participant may hold. Keeps the frontier fair. */
export const CLAIM_CAP = 1

/** How many days of summaries a snapshot carries. */
const SNAPSHOT_SUMMARIES = 30

/**
 * A ticket with every field a newer build added filled in. The log and
 * snapshots are kept as written, so a ticket from an older build lacks them,
 * and code reading `ticket.attachments.length` must not have to know that.
 */
function completeTicket(ticket: Ticket): Ticket {
  return {
    ...ticket,
    body: ticket.body ?? '',
    members: ticket.members ?? [],
    verification: ticket.verification ?? null,
    decompositionId: ticket.decompositionId ?? null,
    prNumber: ticket.prNumber ?? null,
    mergedAt: ticket.mergedAt ?? null,
    attachments: ticket.attachments ?? [],
    needsHuman: ticket.needsHuman ?? false,
    humanCheck: ticket.humanCheck ?? null,
    subtickets: ticket.subtickets ?? [],
    sprintId: ticket.sprintId ?? null,
    dueAt: ticket.dueAt ?? null,
    startedAt: ticket.startedAt ?? null,
    followUpOf: ticket.followUpOf ?? null,
  }
}

/**
 * In-memory fold of one session's event log. Every mutation goes through the
 * log first and lands here second, so a reconnecting client replaying from
 * `fromSeq` converges on exactly this state.
 */
export class SessionState {
  session: Session | null = null
  seq = -1
  readonly participants = new Map<ParticipantId, Participant>()
  /** Insertion-ordered, which is the order the board's Plan column shows. */
  readonly tickets = new Map<TicketId, Ticket>()
  /**
   * Splits, keyed by id, in the order they were proposed.
   *
   * This was one session-wide `decomposition`, overwritten by every proposal.
   * With several tickets that meant starting ticket A seeded whichever split
   * had arrived last -- quite possibly ticket B's -- and only the newest
   * contract was ever frozen. Each ticket now points at its own split through
   * `ticket.decompositionId`, and everything that acts on one looks it up.
   */
  readonly decompositions = new Map<DecompositionId, Decomposition>()
  readonly validations = new Map<DecompositionId, ValidationReport>()
  /** The newest proposal: what an event that names no split has always meant. */
  latestDecompositionId: DecompositionId | null = null
  readonly tasks = new Map<TaskId, Task>()
  /** Keyed by task: a lease exists exactly as long as its task is held. */
  readonly leases = new Map<TaskId, Lease>()
  readonly handoffs = new Map<string, HandoffRequest>()
  readonly chat: ChatMessage[] = []
  /** Keyed by `participant|ticket`, so both totals fall out of one map. */
  readonly usage = new Map<string, Usage>()
  /** Keyed by lowercase login: one profile per person, whatever seats they hold. */
  readonly profiles = new Map<string, Profile>()
  /** What each login spent on the latest day it spent anything, in weighted units. */
  readonly spentToday = new Map<string, DailySpend>()
  /** Keyed by UTC day, in the order they were taken. */
  readonly summaries = new Map<string, DailySummary>()
  /** Insertion-ordered, which is the order a ticket shows them. */
  readonly comments = new Map<string, TicketComment>()
  readonly sprints = new Map<string, Sprint>()
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
          this.participants.set(body.participantId, {
            ...participant,
            repoPath: body.repoPath,
            machineId: body.machineId ?? participant.machineId ?? null,
          })
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

      case 'ticket.created':
        // The log is stored as written, so a ticket from before a field existed lacks it.
        this.tickets.set(body.ticket.id, completeTicket(body.ticket))
        break
      case 'ticket.members': {
        const ticket = this.tickets.get(body.ticketId)
        if (ticket) this.tickets.set(body.ticketId, { ...ticket, members: body.members })
        break
      }
      case 'ticket.state': {
        const ticket = this.tickets.get(body.ticketId)
        if (ticket) {
          // The first time it leaves plan is when work started, whatever happens after.
          const startedAt = ticket.startedAt ?? (body.state === 'plan' ? null : envelope.ts)
          this.tickets.set(body.ticketId, { ...ticket, state: body.state, startedAt })
        }
        break
      }
      case 'ticket.verified': {
        const ticket = this.tickets.get(body.ticketId)
        // A new run is new evidence: any earlier human look was at something else.
        if (ticket) this.tickets.set(body.ticketId, { ...ticket, verification: body.verification, humanCheck: null })
        break
      }
      case 'ticket.attached': {
        const ticket = this.tickets.get(body.ticketId)
        if (ticket) {
          const known = new Set(ticket.attachments.map((a) => a.id))
          this.tickets.set(body.ticketId, {
            ...ticket,
            attachments: [...ticket.attachments, ...body.attachments.filter((a) => !known.has(a.id))],
          })
        }
        break
      }
      case 'ticket.needsHuman': {
        const ticket = this.tickets.get(body.ticketId)
        if (ticket) this.tickets.set(body.ticketId, { ...ticket, needsHuman: body.value })
        break
      }
      case 'ticket.humanCheck': {
        const ticket = this.tickets.get(body.ticketId)
        if (ticket) this.tickets.set(body.ticketId, { ...ticket, humanCheck: body.check })
        break
      }
      case 'ticket.merged': {
        const ticket = this.tickets.get(body.ticketId)
        if (ticket) {
          this.tickets.set(body.ticketId, { ...ticket, prNumber: body.prNumber, mergedAt: envelope.ts, state: 'done' })
        }
        break
      }
      case 'ticket.shipped': {
        const ticket = this.tickets.get(body.ticketId)
        // The PR is the end of the board, not a step before it: a ticket sits
        // in review with its number on it until a person merges the thing.
        if (ticket) this.tickets.set(body.ticketId, { ...ticket, prNumber: body.prNumber })
        break
      }
      case 'ticket.edited': {
        const ticket = this.tickets.get(body.ticketId)
        if (ticket) this.tickets.set(body.ticketId, { ...ticket, title: body.title, body: body.body })
        break
      }
      case 'ticket.due': {
        const ticket = this.tickets.get(body.ticketId)
        if (ticket) this.tickets.set(body.ticketId, { ...ticket, dueAt: body.dueAt })
        break
      }
      case 'ticket.sprint': {
        const ticket = this.tickets.get(body.ticketId)
        if (ticket) this.tickets.set(body.ticketId, { ...ticket, sprintId: body.sprintId })
        break
      }

      case 'subticket.added': {
        const ticket = this.tickets.get(body.ticketId)
        if (ticket && !ticket.subtickets.some((s) => s.id === body.subticket.id)) {
          this.tickets.set(body.ticketId, { ...ticket, subtickets: [...ticket.subtickets, body.subticket] })
        }
        break
      }
      case 'subticket.updated':
        this.updateSubticket(body.ticketId, body.subticketId, (s) => ({ ...s, title: body.title, state: body.state }))
        break
      case 'subticket.members':
        this.updateSubticket(body.ticketId, body.subticketId, (s) => ({ ...s, members: body.members }))
        break
      case 'subticket.removed': {
        const ticket = this.tickets.get(body.ticketId)
        if (ticket) {
          this.tickets.set(body.ticketId, {
            ...ticket,
            subtickets: ticket.subtickets.filter((s) => s.id !== body.subticketId),
          })
        }
        break
      }

      case 'comment.added':
        this.comments.set(body.comment.id, body.comment)
        break
      case 'comment.edited': {
        const comment = this.comments.get(body.commentId)
        if (comment) this.comments.set(comment.id, { ...comment, body: body.body, editedAt: envelope.ts })
        break
      }
      case 'comment.deleted':
        this.comments.delete(body.commentId)
        break

      case 'sprint.created':
      case 'sprint.updated':
        this.sprints.set(body.sprint.id, body.sprint)
        break
      case 'sprint.deleted': {
        // Like a deleted ticket's tasks, the cascade is in the fold so a replay agrees.
        this.sprints.delete(body.sprintId)
        for (const ticket of this.tickets.values()) {
          if (ticket.sprintId === body.sprintId) this.tickets.set(ticket.id, { ...ticket, sprintId: null })
        }
        break
      }

      case 'ticket.deleted': {
        /**
         * The cascade lives here rather than only in the server, so a client
         * replaying the log lands on the same state. A task left behind by its
         * ticket is worse than no task at all: it stays claimable, and its
         * lease goes on denying edits for work that no longer exists.
         */
        this.tickets.delete(body.ticketId)
        for (const comment of [...this.comments.values()]) {
          if (comment.ticketId === body.ticketId) this.comments.delete(comment.id)
        }
        for (const task of [...this.tasks.values()]) {
          if (task.ticketId !== body.ticketId) continue
          this.tasks.delete(task.id)
          this.leases.delete(task.id)
          this.expireHandoffs(task.id)
        }
        for (const split of [...this.decompositions.values()]) {
          if (split.ticketId !== body.ticketId) continue
          this.decompositions.delete(split.id)
          this.validations.delete(split.id)
          if (this.latestDecompositionId === split.id) this.latestDecompositionId = null
        }
        break
      }

      case 'plan.requested':
        if (this.session) this.session = { ...this.session, goal: body.goal, issueRef: body.issueRef }
        break
      case 'decomposition.proposed': {
        const split: Decomposition = {
          ...body.decomposition,
          contractCommit: body.decomposition.contractCommit ?? null,
        }
        this.decompositions.set(split.id, split)
        this.validations.set(split.id, body.validation)
        this.latestDecompositionId = split.id

        const ticket = split.ticketId ? this.tickets.get(split.ticketId) : null
        /**
         * Only a split that passed validation becomes the ticket's split, and
         * only while nothing has been seeded from an earlier one. A failed
         * proposal pointing the ticket at itself made the card read "proposed"
         * with nothing startable on it; a re-proposal over running work cut the
         * ticket loose from the contract its tasks were planned against.
         */
        if (ticket && this.tasksOfTicket(ticket.id).length === 0) {
          this.tickets.set(ticket.id, {
            ...ticket,
            decompositionId: body.validation.ok ? split.id : null,
          })
        }

        /**
         * Older proposals for the same ticket are dropped once superseded, so
         * the snapshot does not carry every repair round forever. An approved
         * one stays: its contract is, or is about to be, frozen on the branch.
         */
        const current = split.ticketId ? this.tickets.get(split.ticketId)?.decompositionId : null
        for (const older of [...this.decompositions.values()]) {
          if (older.id === split.id || older.id === current) continue
          if (older.ticketId !== split.ticketId || older.status === 'approved') continue
          this.decompositions.delete(older.id)
          this.validations.delete(older.id)
        }
        break
      }
      case 'decomposition.assigned':
        this.updateSplit(body.decompositionId, (split) => ({
          ...split,
          assignments: body.assignments,
        }))
        break
      case 'decomposition.approval':
        this.updateSplit(body.decompositionId, (split) => ({
          ...split,
          approvals: body.approvals,
          status: body.satisfied ? 'approved' : split.status,
        }))
        break
      case 'decomposition.rejected':
        this.updateSplit(body.decompositionId, (split) => ({ ...split, status: 'rejected' }))
        break
      case 'contract.committed': {
        if (this.session) this.session = { ...this.session, contractBranch: body.branch }
        const named = body.decompositionId ?? null
        for (const split of [...this.decompositions.values()]) {
          /**
           * A landing that names no split comes from a log written when one
           * landing made every task claimable. Folding it onto every approved
           * split keeps those sessions working exactly as they did.
           */
          const lands = named
            ? split.id === named
            : split.status === 'approved' && split.contractCommit === null
          if (lands) {
            this.decompositions.set(split.id, { ...split, contractCommit: body.commitSha })
            if (split.ticketId) this.staleVerification(split.ticketId)
          }
        }
        break
      }

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
          /**
           * Work that comes back out of the contract is going to change, so the
           * test that let it land last time says nothing about what lands next.
           * `pr` and `failed` arrive with a result of their own, folded just before.
           */
          const reopened = task.state === 'merged' && !['merged', 'pr', 'failed'].includes(body.state)
          this.tasks.set(body.taskId, {
            ...task,
            state: body.state,
            ownerId: body.ownerId,
            lastTest: reopened ? null : task.lastTest,
          })
          // Anything a ticket's task does after its run is something the run did not see.
          if (task.ticketId && task.state !== body.state) this.staleVerification(task.ticketId)
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
        this.expireHandoffs(body.taskId)
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

      case 'usage.recorded': {
        const key = `${body.participantId}|${body.ticketId ?? ''}`
        const at = this.usage.get(key) ?? {
          participantId: body.participantId,
          ticketId: body.ticketId,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          turns: 0,
        }
        this.usage.set(key, {
          ...at,
          inputTokens: at.inputTokens + body.inputTokens,
          outputTokens: at.outputTokens + body.outputTokens,
          cacheReadTokens: at.cacheReadTokens + body.cacheReadTokens,
          cacheCreationTokens: at.cacheCreationTokens + body.cacheCreationTokens,
          turns: at.turns + body.turns,
        })
        const login = this.participants.get(body.participantId)?.githubLogin.toLowerCase()
        if (login) {
          const day = usageDay(envelope.ts)
          const was = this.spentToday.get(login)
          const before = was?.day === day ? was.units : 0
          this.spentToday.set(login, { login, day, units: before + weightedUnits(body) })
        }
        break
      }

      case 'profile.updated':
        this.profiles.set(body.profile.login, body.profile)
        break
      case 'summary.requested':
        // Asked again: the fresh digest replaces the old one, a write-up already in stays until a new one lands.
        this.summaries.delete(body.summary.day)
        this.summaries.set(body.summary.day, body.summary)
        break
      case 'summary.posted': {
        const summary = this.summaries.get(body.day)
        if (summary) this.summaries.set(body.day, { ...summary, narrative: body.narrative, postedAt: envelope.ts })
        break
      }

      case 'merge.queue':
        this.mergeQueue = body.entries
        break
      case 'merge.conflict':
      case 'integration.pr':
        break
    }
  }

  /** Applies a change to the split an event names, or the newest one if it names none. */
  private updateSplit(
    id: DecompositionId | null | undefined,
    change: (split: Decomposition) => Decomposition,
  ): void {
    const key = id ?? this.latestDecompositionId
    const split = key ? this.decompositions.get(key) : undefined
    if (split) this.decompositions.set(split.id, change(split))
  }

  /**
   * Marks a ticket's run as no longer about what is on the branch -- and a
   * person's look with it, which was a look at that same build.
   */
  private staleVerification(ticketId: TicketId): void {
    const ticket = this.tickets.get(ticketId)
    if (ticket?.verification && !ticket.verification.stale) {
      this.tickets.set(ticketId, { ...ticket, verification: { ...ticket.verification, stale: true }, humanCheck: null })
    } else if (ticket?.humanCheck) {
      this.tickets.set(ticketId, { ...ticket, humanCheck: null })
    }
  }

  private updateSubticket(ticketId: TicketId, subticketId: string, change: (s: Subticket) => Subticket): void {
    const ticket = this.tickets.get(ticketId)
    if (!ticket) return
    this.tickets.set(ticketId, {
      ...ticket,
      subtickets: ticket.subtickets.map((s) => (s.id === subticketId ? change(s) : s)),
    })
  }

  /**
   * A handoff opens a path for one piece of work. When the lease it was carved
   * out of goes, or the requester's own task does, the grant goes with it --
   * otherwise a yes given for one afternoon's fix is a key that never expires.
   */
  private expireHandoffs(taskId: TaskId): void {
    for (const request of this.handoffs.values()) {
      if (request.status !== 'pending' && request.status !== 'granted') continue
      if (request.heldByTaskId !== taskId && request.requesterTaskId !== taskId) continue
      this.handoffs.set(request.id, { ...request, status: 'expired' })
    }
  }

  // -- derived -------------------------------------------------------------

  /**
   * The one split a client that predates tickets should see. The newest split
   * that has been approved and not yet landed comes first, because that is the
   * one somebody is about to write onto the branch; otherwise the newest
   * proposal, which is what this field always meant.
   */
  get decomposition(): Decomposition | null {
    const awaiting = [...this.decompositions.values()].filter(
      (split) => split.status === 'approved' && split.contractCommit === null,
    )
    const latest = this.latestDecompositionId
      ? this.decompositions.get(this.latestDecompositionId)
      : undefined
    return awaiting.at(-1) ?? latest ?? null
  }

  get validation(): ValidationReport | null {
    const split = this.decomposition
    return split ? (this.validations.get(split.id) ?? null) : null
  }

  /** The split a ticket is running, or is about to. */
  splitOfTicket(ticketId: TicketId): Decomposition | null {
    const id = this.tickets.get(ticketId)?.decompositionId
    return id ? (this.decompositions.get(id) ?? null) : null
  }

  /** The split a live task was seeded from. */
  splitOfTask(task: Task): Decomposition | null {
    if (task.ticketId) return this.splitOfTicket(task.ticketId)
    // A task from before tickets came from the session's one split.
    const legacy = [...this.decompositions.values()].filter((split) => split.ticketId === null)
    return legacy.findLast((split) => split.tasks.some((spec) => spec.id === task.id)) ?? null
  }

  /**
   * Whether the seam this task was planned against is on the branch yet. Per
   * task rather than per session: one ticket landing its contract says nothing
   * about the files another ticket's tasks are going to import.
   */
  contractLanded(task: Task): boolean {
    const split = this.splitOfTask(task)
    if (split) return split.contractCommit !== null
    return Boolean(this.session?.contractBranch)
  }

  /** Every contract file that has landed. All of them stay frozen, not just the newest. */
  frozenContractPaths(): string[] {
    const paths: string[] = []
    for (const split of this.decompositions.values()) {
      if (split.contractCommit === null) continue
      for (const file of split.contract.files) paths.push(file.path)
    }
    return paths
  }

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
  /**
   * `available` says whether a seat can do its own work right now -- its
   * Claude Code is open and its account is not out of usage. Someone else's
   * task is only taken when its assignee is not; otherwise two agents race for
   * it and the faster one does the other's work on its own account.
   */
  pickTaskFor(participantId: ParticipantId, available?: (id: ParticipantId) => boolean): Task | null {
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

    const claimable = this.readyTasks()
      .filter((task) => this.contractLanded(task))
      .filter(
        (task) =>
          !available ||
          !task.assigneeId ||
          task.assigneeId === participantId ||
          !available(task.assigneeId),
      )
    const scored = claimable.map((task) => {
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

  tasksOfTicket(ticketId: TicketId): Task[] {
    return [...this.tasks.values()].filter((task) => task.ticketId === ticketId)
  }

  /**
   * Where a ticket belongs on the board, derived from what has actually
   * happened to its tasks rather than from anyone dragging a card.
   */
  ticketStateFor(ticketId: TicketId): TicketState {
    const ticket = this.tickets.get(ticketId)
    if (!ticket) return 'plan'
    /**
     * A ticket with a pull request sits in review while its run still holds.
     * Nothing here merges anything -- that is a decision with a human on the
     * end of it -- so a `done` column would only ever mean "we opened a PR",
     * which is what the review column already says.
     */
    // Merged is the end of the line, whoever pressed the button and wherever.
    if (ticket.mergedAt) return 'done'

    const tasks = this.tasksOfTicket(ticketId)
    if (tasks.length > 0) {
      // Work reopened under an open PR is being built again, whatever the PR says.
      if (!tasks.every((task) => task.state === 'merged')) return 'building'
      /**
       * Every piece passing its own test is not the same as the pieces working
       * together -- and a split makes that failure more likely, not less. So
       * the assembled thing gets run before anyone calls it done, and run
       * again whenever what was run is no longer what is there: a pass that
       * is stale, or never said which commit it ran, holds nothing back.
       */
      if (!verificationHolds(ticket.verification)) return 'verify'
      /**
       * Asked for a person's look as well: it waits here until someone has
       * had one -- an open PR included. A new run clears the last look, so a
       * PR opened earlier is no way round looking at what is there now.
       */
      return !ticket.needsHuman || ticket.humanCheck?.passed ? 'review' : 'verify'
    }
    if (ticket.prNumber !== null) return 'review'
    // A split exists but nothing has been seeded: it is waiting to be accepted.
    if (ticket.decompositionId) return 'proposed'
    return ticket.state === 'splitting' ? 'splitting' : 'plan'
  }

  /**
   * The session's phase, worked out from the tickets rather than latched.
   *
   * This used to be a stored field moved by events, from `plan` to `build` when
   * the contract landed and to `integrate` when the last task merged -- one
   * decomposition per session, one way, no way back. Tickets made that wrong:
   * several run at once, each with its own lifecycle, and a session that
   * finished one ticket would sit in `integrate` forever, refusing to plan
   * anything ever again. Derived, it cannot latch, and it cannot be stale.
   */
  phaseNow(): SessionPhase {
    const tickets = [...this.tickets.values()]
    if (tickets.length > 0) {
      const states = tickets.map((ticket) => this.ticketStateFor(ticket.id))
      if (states.every((state) => state === 'review')) return 'integrate'
      if (states.some((state) => state === 'building' || state === 'verify')) return 'build'
      return 'plan'
    }

    // A session from before tickets: the tasks say the same thing about it.
    const tasks = [...this.tasks.values()]
    if (tasks.length === 0) return 'plan'
    return tasks.every((task) => task.state === 'merged') ? 'integrate' : 'build'
  }

  /** Weighted units a login has spent on the session so far today (UTC). */
  spentOn(login: string, now = Date.now()): number {
    const spend = this.spentToday.get(login.toLowerCase())
    return spend && spend.day === usageDay(now) ? spend.units : 0
  }

  /** Whether a login has reached the daily limit it set for itself. */
  overDailyLimit(login: string, now = Date.now()): boolean {
    const limit = this.profiles.get(login.toLowerCase())?.dailyLimit ?? null
    return limit !== null && this.spentOn(login, now) >= limit
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
    this.tickets.clear()
    // Snapshots cross version boundaries -- an older server has no tickets at
    // all -- and hydrating is the one place a client cannot afford to throw.
    for (const ticket of snapshot.tickets ?? []) {
      // A snapshot from an older server has none of the newer fields.
      this.tickets.set(ticket.id, completeTicket(ticket))
    }
    this.decompositions.clear()
    this.validations.clear()
    /**
     * An older server sends only the one split. Taking it as the whole map is
     * what that server meant by it.
     */
    const splits = { ...(snapshot.decompositions ?? {}) }
    const reports = { ...(snapshot.validations ?? {}) }
    const legacy = snapshot.decomposition
    if (Object.keys(splits).length === 0 && legacy) {
      // Back then a landed branch meant this split had landed.
      const landed = legacy.status === 'approved' && snapshot.session.contractBranch
      splits[legacy.id] = { ...legacy, contractCommit: legacy.contractCommit ?? (landed ? 'landed' : null) }
      if (snapshot.validation) reports[legacy.id] = snapshot.validation
    }
    for (const [id, split] of Object.entries(splits)) {
      this.decompositions.set(id as DecompositionId, {
        ...split,
        contractCommit: split.contractCommit ?? null,
      })
    }
    for (const [id, report] of Object.entries(reports)) {
      this.validations.set(id as DecompositionId, report)
    }
    /**
     * Carried by the snapshot rather than guessed from it. Folding the log can
     * leave the newest proposal unset -- its ticket was deleted -- while older
     * splits are still in the map, and guessing "the last one" then made a
     * hydrated client and a replayed one disagree about which split was live.
     * Only a snapshot from before the field existed is left to the guess.
     */
    this.latestDecompositionId =
      snapshot.latestDecompositionId !== undefined
        ? snapshot.latestDecompositionId
        : ([...this.decompositions.keys()].at(-1) ?? null)
    this.tasks.clear()
    for (const task of snapshot.tasks) this.tasks.set(task.id, task)
    this.leases.clear()
    for (const lease of snapshot.leases) this.leases.set(lease.taskId, lease)
    this.handoffs.clear()
    for (const handoff of snapshot.handoffs) this.handoffs.set(handoff.id, handoff)
    this.chat.length = 0
    this.chat.push(...snapshot.chat)
    this.usage.clear()
    for (const entry of snapshot.usage ?? []) {
      this.usage.set(`${entry.participantId}|${entry.ticketId ?? ''}`, entry)
    }
    this.comments.clear()
    for (const comment of snapshot.comments ?? []) this.comments.set(comment.id, comment)
    this.profiles.clear()
    for (const profile of snapshot.profiles ?? []) this.profiles.set(profile.login, profile)
    this.spentToday.clear()
    for (const spend of snapshot.spentToday ?? []) this.spentToday.set(spend.login, spend)
    this.summaries.clear()
    for (const summary of snapshot.summaries ?? []) this.summaries.set(summary.day, summary)
    this.sprints.clear()
    for (const sprint of snapshot.sprints ?? []) this.sprints.set(sprint.id, sprint)
    this.mergeQueue = snapshot.mergeQueue
    this.seq = snapshot.seq
  }

  snapshot(): SessionSnapshot {
    if (!this.session) throw new Error('snapshot before session.created')
    return {
      session: { ...this.session, phase: this.phaseNow() },
      participants: [...this.participants.values()],
      /**
       * Served with the state the work says they are in, not the last one
       * anybody wrote down. The stored field is only ever an echo of this, and
       * an echo can lag -- a card sitting in Splitting with a claimed task
       * under it is the board lying about the one thing it exists to show.
       */
      tickets: [...this.tickets.values()].map((ticket) => ({
        ...ticket,
        state: this.ticketStateFor(ticket.id),
      })),
      decomposition: this.decomposition,
      validation: this.validation,
      decompositions: Object.fromEntries(this.decompositions),
      validations: Object.fromEntries(this.validations),
      latestDecompositionId: this.latestDecompositionId,
      tasks: [...this.tasks.values()],
      leases: [...this.leases.values()],
      handoffs: [...this.handoffs.values()],
      // A copy: the fold appends in place, and a board memoized on this array never saw a new message.
      chat: [...this.chat],
      usage: [...this.usage.values()],
      profiles: [...this.profiles.values()],
      spentToday: [...this.spentToday.values()],
      summaries: [...this.summaries.values()].slice(-SNAPSHOT_SUMMARIES),
      comments: [...this.comments.values()],
      sprints: [...this.sprints.values()],
      mergeQueue: this.mergeQueue,
      seq: this.seq,
    }
  }
}

/** `src/theme/**` -> `src`. Coarse on purpose; affinity is a tiebreak, not a rule. */
function topLevel(glob: string): string {
  return glob.split('/')[0] ?? glob
}
