import { randomUUID } from 'node:crypto'
import {
  type ActivityFrame,
  type ChatMessage,
  type ClientCommand,
  type CommandResultMap,
  type DecompositionId,
  type ErrorCode,
  type EventBody,
  type EventEnvelope,
  type LeaseDenial,
  type MessageId,
  type Participant,
  type ParticipantId,
  type Session,
  type SessionId,
  type Task,
  type TaskId,
  analyzeDag,
  globsIntersect,
  parseMentions,
  parseTaskRefs,
  validateDecomposition,
} from '@session-share/protocol'
import { Store } from './db.js'
import { CLAIM_CAP, SessionState } from './projection.js'

export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}

/** Who is speaking. Set on the connection by `session.join` / `session.create`. */
export interface CommandContext {
  sessionId: SessionId | null
  participantId: ParticipantId | null
  /**
   * The authenticated account, when the caller carried a cookie, a ws ticket or
   * a participant token. Its identity always wins over anything the client
   * claims about itself.
   */
  user?: AuthenticatedUser | null
}

export interface AuthenticatedUser {
  id: string
  githubLogin: string
  displayName: string
  avatarUrl: string | null
}

export type Broadcast = (sessionId: SessionId, envelope: EventEnvelope) => void
export type FrameRelay = (
  sessionId: SessionId,
  from: ParticipantId,
  frame: ActivityFrame,
) => void

const PALETTE_SIZE = 8

/**
 * Unanimous approval does not scale past a handful of people, so the rule
 * shifts: small sessions need everyone, larger ones need the lead (whoever ran
 * /ss:plan) with everyone else free to object in chat before the contract lands.
 */
const UNANIMOUS_UP_TO = 3

export class SessionService {
  private readonly states = new Map<SessionId, SessionState>()

  constructor(
    private readonly store: Store,
    private readonly broadcast: Broadcast,
    private readonly relayFrame: FrameRelay,
  ) {}

  // -- state access --------------------------------------------------------

  /** Folds the log on first touch; afterwards the map is the live projection. */
  state(sessionId: SessionId): SessionState {
    const existing = this.states.get(sessionId)
    if (existing) return existing

    const state = new SessionState()
    for (const envelope of this.store.readEvents(sessionId, 0)) state.apply(envelope)
    this.states.set(sessionId, state)
    return state
  }

  private emit(
    sessionId: SessionId,
    actorId: ParticipantId | null,
    body: EventBody,
  ): EventEnvelope {
    const envelope = this.store.append(sessionId, actorId, body)
    this.state(sessionId).apply(envelope)
    this.broadcast(sessionId, envelope)
    return envelope
  }

  readEvents(sessionId: SessionId, fromSeq: number, limit?: number): EventEnvelope[] {
    return this.store.readEvents(sessionId, fromSeq, limit)
  }

  // -- entry point ---------------------------------------------------------

  handle<T extends ClientCommand['type']>(
    command: Extract<ClientCommand, { type: T }>,
    ctx: CommandContext,
  ): CommandResultMap[T]
  handle(command: ClientCommand, ctx: CommandContext): unknown {
    switch (command.type) {
      case 'session.create':
        return this.createSession(command)
      case 'session.join':
        return this.join(command, ctx)
      case 'session.sync':
        return { upToSeq: this.store.maxSeq(this.requireSession(ctx)) }
      case 'decomposition.propose':
        return this.propose(command, ctx)
      case 'decomposition.approve':
        return this.approve(command, ctx)
      case 'decomposition.reject':
        return this.reject(command, ctx)
      case 'contract.committed':
        return this.contractCommitted(command, ctx)
      case 'task.claim':
        return this.claim(command, ctx)
      case 'task.release':
        return this.release(command, ctx)
      case 'task.progress':
        return this.progress(command, ctx)
      case 'task.testResult':
        return this.testResult(command, ctx)
      case 'task.branch':
        return this.setBranch(command, ctx)
      case 'task.merged':
        return this.markMerged(command, ctx)
      case 'lease.check':
        return this.checkLease(command, ctx)
      case 'handoff.request':
        return this.requestHandoff(command, ctx)
      case 'handoff.resolve':
        return this.resolveHandoff(command, ctx)
      case 'chat.post':
        return this.postChat(command, ctx)
      case 'chat.read':
        return this.readChat(command, ctx)
      case 'activity.report':
        return this.reportActivity(command, ctx)
    }
  }

  // -- sessions ------------------------------------------------------------

  private createSession(command: Extract<ClientCommand, { type: 'session.create' }>) {
    if (this.store.findSessionIdByRef(command.slug)) {
      throw new ServiceError('conflict', `Session slug "${command.slug}" is taken.`)
    }

    const sessionId = randomUUID() as SessionId
    const createdAt = Date.now()
    this.store.createSession(sessionId, command.slug, createdAt)

    const session: Session = {
      id: sessionId,
      slug: command.slug,
      title: command.title,
      repo: command.repo,
      issueRef: command.issueRef,
      phase: 'plan',
      leadId: null,
      contractBranch: null,
      createdAt,
    }
    this.emit(sessionId, null, { type: 'session.created', session })
    return { sessionId, slug: command.slug }
  }

  private join(command: Extract<ClientCommand, { type: 'session.join' }>, ctx: CommandContext) {
    const sessionId = this.store.findSessionIdByRef(command.sessionRef)
    if (!sessionId) throw new ServiceError('not_found', `No session "${command.sessionRef}".`)

    const state = this.state(sessionId)

    // An authenticated identity always wins over what the client says it is.
    const githubLogin = ctx.user?.githubLogin ?? command.githubLogin
    if (!githubLogin) {
      throw new ServiceError('unauthorized', 'Sign in, or attach this checkout with /ss:join <code>.')
    }

    const identity = {
      userId: ctx.user?.id ?? null,
      githubLogin,
      displayName: ctx.user?.displayName ?? command.displayName ?? githubLogin,
      avatarUrl: ctx.user?.avatarUrl ?? null,
    }

    /**
     * Two Claude Codes in one working tree corrupt each other's edits, and no
     * lease can prevent it because both are the same filesystem. Rejecting the
     * join is the only place this can be caught.
     */
    const clash = command.repoPath
      ? [...state.participants.values()].find(
          (p) =>
            p.connected &&
            p.repoPath === command.repoPath &&
            p.githubLogin !== identity.githubLogin,
        )
      : undefined
    if (clash) {
      throw new ServiceError(
        'conflict',
        `${clash.displayName} is already working in ${command.repoPath}. Use a separate clone or git worktree -- two agents in one checkout will corrupt each other.`,
      )
    }

    const returning = [...state.participants.values()].find((p) =>
      identity.userId ? p.userId === identity.userId : p.githubLogin === identity.githubLogin,
    )

    let participantId: ParticipantId
    if (returning) {
      participantId = returning.id
      this.emit(sessionId, participantId, {
        type: 'participant.connection',
        participantId,
        connected: true,
      })
      // Someone who was watching from the board has now paired a checkout.
      if (command.repoPath && command.repoPath !== returning.repoPath) {
        this.emit(sessionId, participantId, {
          type: 'participant.attached',
          participantId,
          repoPath: command.repoPath,
        })
      }
    } else {
      participantId = randomUUID() as ParticipantId
      const participant: Participant = {
        id: participantId,
        sessionId,
        userId: identity.userId,
        githubLogin: identity.githubLogin,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        colorIndex: state.participants.size % PALETTE_SIZE,
        repoPath: command.repoPath,
        connected: true,
        activity: { state: 'idle', detail: 'joined', taskId: null, updatedAt: Date.now() },
        joinedAt: Date.now(),
      }
      this.emit(sessionId, participantId, { type: 'participant.joined', participant })
    }

    // First one in leads, so /ss:plan always has an owner.
    if (state.session && state.session.leadId === null) {
      this.emit(sessionId, participantId, { type: 'session.lead', leadId: participantId })
    }

    ctx.sessionId = sessionId
    ctx.participantId = participantId

    return {
      participantId,
      sessionId,
      snapshot: command.fromSeq === null ? state.snapshot() : null,
    }
  }

  // -- decomposition -------------------------------------------------------

  private propose(
    command: Extract<ClientCommand, { type: 'decomposition.propose' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    if (state.session?.phase !== 'plan') {
      throw new ServiceError('not_ready', 'Decomposition can only be proposed during the plan phase.')
    }

    const validation = validateDecomposition({
      contract: command.contract,
      tasks: command.tasks,
      participantCount: Math.max(command.participantCount, state.participants.size),
    })

    const decompositionId = randomUUID() as DecompositionId
    /**
     * A failing proposal is still recorded. The board needs to show what was
     * wrong for the planner's repair round, and "what did it try" is worth
     * keeping in the log.
     */
    this.emit(sessionId, participantId, {
      type: 'decomposition.proposed',
      decomposition: {
        id: decompositionId,
        sessionId,
        issueRef: command.issueRef,
        contract: command.contract,
        tasks: command.tasks,
        participantCount: command.participantCount,
        proposedBy: participantId,
        status: 'proposed',
        approvals: [],
        createdAt: Date.now(),
      },
      validation,
    })

    return { decompositionId, validation }
  }

  private approve(
    command: Extract<ClientCommand, { type: 'decomposition.approve' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const decomposition = state.decomposition
    if (!decomposition || decomposition.id !== command.decompositionId) {
      throw new ServiceError('conflict', 'That decomposition is no longer the current proposal.')
    }
    if (decomposition.status !== 'proposed') {
      throw new ServiceError('not_ready', `Decomposition is already ${decomposition.status}.`)
    }
    if (!state.validation?.ok) {
      throw new ServiceError(
        'not_ready',
        'Decomposition has blocking validation errors; the planner must repair it first.',
      )
    }

    const approvals = decomposition.approvals.includes(participantId)
      ? decomposition.approvals
      : [...decomposition.approvals, participantId]

    const satisfied = this.approvalSatisfied(state, approvals, participantId)
    this.emit(sessionId, participantId, {
      type: 'decomposition.approval',
      participantId,
      approvals,
      satisfied,
    })

    if (satisfied) this.seedTasks(sessionId, participantId, state)
    return { approvals, satisfied }
  }

  private approvalSatisfied(
    state: SessionState,
    approvals: ParticipantId[],
    approver: ParticipantId,
  ): boolean {
    const voters = [...state.participants.values()].filter((p) => p.connected)
    if (voters.length > UNANIMOUS_UP_TO) return state.session?.leadId === approver
    return voters.every((p) => approvals.includes(p.id))
  }

  /**
   * Turns approved specs into live tasks. Depth comes from the DAG so the board
   * can lay out left-to-right, and anything with an unmerged dependency starts
   * blocked rather than claimable.
   */
  private seedTasks(sessionId: SessionId, actorId: ParticipantId, state: SessionState): void {
    const specs = state.decomposition?.tasks ?? []
    const { depthByTask } = analyzeDag(specs)

    const tasks: Task[] = specs.map((spec) => ({
      ...spec,
      sessionId,
      state: spec.dependsOn.length === 0 ? 'ready' : 'blocked',
      ownerId: null,
      branch: null,
      prNumber: null,
      lastTest: null,
      activityLine: null,
      depth: depthByTask.get(spec.id) ?? 0,
    }))

    this.emit(sessionId, actorId, { type: 'tasks.seeded', tasks })
  }

  private reject(
    command: Extract<ClientCommand, { type: 'decomposition.reject' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    if (state.decomposition?.id !== command.decompositionId) {
      throw new ServiceError('conflict', 'That decomposition is no longer the current proposal.')
    }
    this.emit(sessionId, participantId, {
      type: 'decomposition.rejected',
      participantId,
      reason: command.reason,
    })
    return { ok: true as const }
  }

  private contractCommitted(
    command: Extract<ClientCommand, { type: 'contract.committed' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    if (state.decomposition?.status !== 'approved') {
      throw new ServiceError('not_ready', 'The contract cannot land before the split is approved.')
    }
    this.emit(sessionId, participantId, {
      type: 'contract.committed',
      branch: command.branch,
      commitSha: command.commitSha,
      prNumber: command.prNumber,
    })
    // Only now is the seam real, so only now can tasks be claimed.
    this.emit(sessionId, participantId, { type: 'session.phase', phase: 'build' })
    return { ok: true as const }
  }

  // -- tasks and leases ----------------------------------------------------

  private claim(command: Extract<ClientCommand, { type: 'task.claim' }>, ctx: CommandContext) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    if (state.session?.phase !== 'build') {
      throw new ServiceError('not_ready', 'Tasks become claimable once the contract has landed.')
    }

    if (state.activeTaskCount(participantId) >= CLAIM_CAP) {
      return {
        task: null,
        lease: null,
        reason: `You already hold ${CLAIM_CAP} active task(s). Finish or release before claiming another.`,
      }
    }

    const task = command.taskId
      ? (state.tasks.get(command.taskId) ?? null)
      : state.pickTaskFor(participantId)

    if (!task) {
      return {
        task: null,
        lease: null,
        reason: command.taskId
          ? `No task "${command.taskId}" in this session.`
          : 'Nothing is ready right now -- every remaining task is waiting on a dependency.',
      }
    }
    if (!state.isReady(task)) {
      const blockers = task.dependsOn.filter((d) => state.tasks.get(d)?.state !== 'merged')
      throw new ServiceError(
        'conflict',
        task.ownerId
          ? `"${task.id}" is already held by ${state.participants.get(task.ownerId)?.displayName ?? 'someone'}.`
          : `"${task.id}" is blocked on ${blockers.join(', ')}.`,
      )
    }

    // Defensive: validation should have made this impossible for ready tasks.
    for (const lease of state.leases.values()) {
      const collision = task.ownedPaths.find((glob) =>
        lease.paths.some((held) => globsIntersect(glob, held)),
      )
      if (collision) {
        throw new ServiceError(
          'conflict',
          `"${task.id}" owns ${collision}, which is already leased by "${lease.taskId}".`,
        )
      }
    }

    const lease = {
      taskId: task.id,
      sessionId,
      holderId: participantId,
      paths: task.ownedPaths,
      grantedAt: Date.now(),
    }
    this.emit(sessionId, participantId, { type: 'lease.granted', lease })
    this.emit(sessionId, participantId, {
      type: 'task.state',
      taskId: task.id,
      state: 'claimed',
      ownerId: participantId,
    })

    return { task: state.tasks.get(task.id) ?? task, lease, reason: null }
  }

  private release(command: Extract<ClientCommand, { type: 'task.release' }>, ctx: CommandContext) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const task = this.requireOwnedTask(state, command.taskId, participantId)

    this.emit(sessionId, participantId, {
      type: 'lease.released',
      taskId: task.id,
      holderId: participantId,
    })
    this.emit(sessionId, participantId, {
      type: 'task.state',
      taskId: task.id,
      state: task.dependsOn.length === 0 ? 'ready' : 'blocked',
      ownerId: null,
    })
    this.refreshBlockedStates(sessionId, participantId, state)
    return { ok: true as const }
  }

  private progress(
    command: Extract<ClientCommand, { type: 'task.progress' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const task = this.requireOwnedTask(state, command.taskId, participantId)

    if (command.state && command.state !== task.state) {
      this.emit(sessionId, participantId, {
        type: 'task.state',
        taskId: task.id,
        state: command.state,
        ownerId: participantId,
      })
    }

    /**
     * The activity line is deliberately not an event: it changes every few
     * seconds and is meaningless once stale, so it rides the activity channel
     * and is simply lost on reconnect.
     */
    if (command.activityLine) {
      const current = state.tasks.get(task.id)
      if (current) state.tasks.set(task.id, { ...current, activityLine: command.activityLine })
      this.relayFrame(sessionId, participantId, {
        type: 'agent.line',
        from: participantId,
        taskId: task.id,
        text: command.activityLine,
        ts: Date.now(),
      })
    }

    return { ok: true as const }
  }

  private testResult(
    command: Extract<ClientCommand, { type: 'task.testResult' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const task = this.requireOwnedTask(state, command.taskId, participantId)

    this.emit(sessionId, participantId, {
      type: 'task.test',
      taskId: task.id,
      result: command.result,
    })
    this.emit(sessionId, participantId, {
      type: 'task.state',
      taskId: task.id,
      state: command.result.passed ? 'pr' : 'failed',
      ownerId: participantId,
    })
    return { ok: true as const }
  }

  private setBranch(
    command: Extract<ClientCommand, { type: 'task.branch' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const task = this.requireOwnedTask(state, command.taskId, participantId)
    this.emit(sessionId, participantId, {
      type: 'task.branch',
      taskId: task.id,
      branch: command.branch,
      prNumber: command.prNumber,
    })
    return { ok: true as const }
  }

  /**
   * The task's work has landed in the contract branch. This releases its lease
   * and re-evaluates everything that was waiting on it, which is the only way
   * a blocked task ever becomes claimable.
   */
  private markMerged(command: Extract<ClientCommand, { type: 'task.merged' }>, ctx: CommandContext) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const task = state.tasks.get(command.taskId)
    if (!task) throw new ServiceError('not_found', `No task "${command.taskId}".`)
    if (task.state === 'merged') return { unblocked: [] }

    // The holder merges their own work; the lead can also land a stalled task.
    const isLead = state.session?.leadId === participantId
    if (task.ownerId !== participantId && !isLead) {
      throw new ServiceError('forbidden', `"${command.taskId}" is held by someone else.`)
    }

    if (state.leases.has(task.id)) {
      this.emit(sessionId, participantId, {
        type: 'lease.released',
        taskId: task.id,
        holderId: task.ownerId ?? participantId,
      })
    }
    this.emit(sessionId, participantId, {
      type: 'task.state',
      taskId: task.id,
      state: 'merged',
      ownerId: task.ownerId,
    })

    const blockedBefore = [...state.tasks.values()].filter((t) => t.state === 'blocked')
    this.refreshBlockedStates(sessionId, participantId, state)
    const unblocked = blockedBefore
      .filter((t) => state.tasks.get(t.id)?.state === 'ready')
      .map((t) => t.id)

    // Everything merged means the build phase is over.
    const remaining = [...state.tasks.values()].filter((t) => t.state !== 'merged')
    if (remaining.length === 0 && state.session?.phase === 'build') {
      this.emit(sessionId, participantId, { type: 'session.phase', phase: 'integrate' })
    }

    return { unblocked }
  }

  /**
   * The lease gate. Called by the PreToolUse hook before every single edit, so
   * it must stay a pure in-memory lookup -- no disk, no git, no network.
   */
  private checkLease(
    command: Extract<ClientCommand, { type: 'lease.check' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const denials: LeaseDenial[] = []
    const granted = this.grantedPaths(state, participantId)

    for (const path of command.paths) {
      if (granted.has(path)) continue

      // The contract is frozen once committed: every task was planned against
      // it, so changing it under them is how a clean split silently rots.
      const contractFile = state.decomposition?.contract.files.find((f) => f.path === path)
      if (contractFile && state.session?.phase === 'build') {
        denials.push({
          path,
          heldBy: null,
          heldByTaskId: null,
          message: `${path} is a contract file and is frozen for the build phase. Raise it in chat -- changing the seam mid-flight breaks every task planned against it.`,
        })
        continue
      }

      const lease = state.findLeaseForPath(path)
      if (!lease || lease.holderId === participantId) continue

      const holder = state.participants.get(lease.holderId)
      denials.push({
        path,
        heldBy: lease.holderId,
        heldByTaskId: lease.taskId,
        message: `${path} is owned by ${holder?.displayName ?? 'another participant'} on task "${lease.taskId}". Run /ss:request ${path} to ask for it.`,
      })
    }

    if (denials.length > 0) {
      for (const denial of denials) {
        this.emit(sessionId, participantId, {
          type: 'lease.denied',
          participantId,
          path: denial.path,
          heldBy: denial.heldBy,
          heldByTaskId: denial.heldByTaskId,
        })
      }
    }

    return { allowed: denials.length === 0, denials }
  }

  /** Paths another participant has explicitly handed over, path by path. */
  private grantedPaths(state: SessionState, participantId: ParticipantId): Set<string> {
    const granted = new Set<string>()
    for (const handoff of state.handoffs.values()) {
      if (handoff.status === 'granted' && handoff.requesterId === participantId) {
        granted.add(handoff.path)
      }
    }
    return granted
  }

  private requestHandoff(
    command: Extract<ClientCommand, { type: 'handoff.request' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const lease = state.findLeaseForPath(command.path)
    if (!lease) {
      throw new ServiceError('not_found', `Nobody holds ${command.path}; you can edit it already.`)
    }
    if (lease.holderId === participantId) {
      throw new ServiceError('bad_request', `You already hold ${command.path}.`)
    }

    const request = {
      id: randomUUID(),
      sessionId,
      path: command.path,
      requesterId: participantId,
      holderId: lease.holderId,
      heldByTaskId: lease.taskId,
      reason: command.reason,
      status: 'pending' as const,
      createdAt: Date.now(),
    }
    this.emit(sessionId, participantId, { type: 'handoff.requested', request })
    return { request }
  }

  private resolveHandoff(
    command: Extract<ClientCommand, { type: 'handoff.resolve' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const request = state.handoffs.get(command.requestId)
    if (!request) throw new ServiceError('not_found', 'No such handoff request.')
    if (request.holderId !== participantId) {
      throw new ServiceError('forbidden', 'Only the current holder can resolve this request.')
    }
    if (request.status !== 'pending') {
      throw new ServiceError('conflict', `Request is already ${request.status}.`)
    }

    this.emit(sessionId, participantId, {
      type: 'handoff.resolved',
      requestId: command.requestId,
      granted: command.granted,
      resolvedBy: participantId,
    })
    return { ok: true as const }
  }

  // -- chat ----------------------------------------------------------------

  private postChat(command: Extract<ClientCommand, { type: 'chat.post' }>, ctx: CommandContext) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)

    const loginToId = new Map(
      [...state.participants.values()].map((p) => [p.githubLogin, p.id as string]),
    )
    const refs = parseTaskRefs(command.body, [...state.tasks.keys()])

    const message: ChatMessage = {
      id: randomUUID() as MessageId,
      sessionId,
      authorId: participantId,
      authorKind: command.asAgent ? 'agent' : 'human',
      body: command.body,
      taskRef: command.taskRef ?? refs[0] ?? null,
      mentions: parseMentions(command.body, loginToId) as ParticipantId[],
      createdAt: Date.now(),
    }
    this.emit(sessionId, participantId, { type: 'chat.message', message })
    return { message }
  }

  private readChat(command: Extract<ClientCommand, { type: 'chat.read' }>, ctx: CommandContext) {
    const { state } = this.requireParticipant(ctx)
    const filtered = command.taskRef
      ? state.chat.filter((m) => m.taskRef === command.taskRef)
      : state.chat
    return { messages: filtered.slice(-command.limit) }
  }

  private reportActivity(
    command: Extract<ClientCommand, { type: 'activity.report' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId } = this.requireParticipant(ctx)
    this.emit(sessionId, participantId, {
      type: 'participant.activity',
      participantId,
      activity: { ...command.activity, updatedAt: Date.now() },
    })
    return { ok: true as const }
  }

  // -- connection lifecycle ------------------------------------------------

  markDisconnected(sessionId: SessionId, participantId: ParticipantId): void {
    const state = this.state(sessionId)
    if (state.participants.get(participantId)?.connected !== true) return
    this.emit(sessionId, participantId, {
      type: 'participant.connection',
      participantId,
      connected: false,
    })
  }

  /** After a merge, whatever it unblocked becomes claimable. */
  refreshBlockedStates(
    sessionId: SessionId,
    actorId: ParticipantId | null,
    state: SessionState,
  ): void {
    for (const task of state.staleStateTasks()) {
      this.emit(sessionId, actorId, {
        type: 'task.state',
        taskId: task.id,
        state: state.isReady(task) ? 'ready' : 'blocked',
        ownerId: null,
      })
    }
  }

  // -- guards --------------------------------------------------------------

  private requireSession(ctx: CommandContext): SessionId {
    if (!ctx.sessionId) throw new ServiceError('unauthorized', 'Join a session first.')
    return ctx.sessionId
  }

  private requireParticipant(ctx: CommandContext): {
    sessionId: SessionId
    participantId: ParticipantId
    state: SessionState
  } {
    const sessionId = this.requireSession(ctx)
    if (!ctx.participantId) throw new ServiceError('unauthorized', 'Join a session first.')
    return { sessionId, participantId: ctx.participantId, state: this.state(sessionId) }
  }

  private requireOwnedTask(
    state: SessionState,
    taskId: TaskId,
    participantId: ParticipantId,
  ): Task {
    const task = state.tasks.get(taskId)
    if (!task) throw new ServiceError('not_found', `No task "${taskId}".`)
    if (task.ownerId !== participantId) {
      throw new ServiceError('forbidden', `You do not hold "${taskId}".`)
    }
    return task
  }
}

