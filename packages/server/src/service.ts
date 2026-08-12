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
  type Ticket,
  type TicketId,
  type TicketState,
  analyzeDag,
  autoAssign,
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

/**
 * How long a participant counts as present after their last command.
 *
 * Presence was a flag flipped by a websocket, which meant anyone who only ever
 * spoke over HTTP -- every attached checkout -- stayed "connected" forever, and
 * sessions filled up with people who had long since walked away.
 */
const PRESENT_FOR_MS = 10 * 60 * 1000

export class SessionService {
  private readonly states = new Map<SessionId, SessionState>()
  /** Public so a test can age someone out without waiting ten minutes. */
  readonly lastSeen = new Map<ParticipantId, number>()

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

  /** Marks someone present now -- used when a socket opens. */
  seen(participantId: ParticipantId): void {
    this.lastSeen.set(participantId, Date.now())
  }

  /**
   * The snapshot everyone actually reads, with presence resolved from when each
   * participant was last heard from rather than from a flag nobody clears.
   */
  snapshotOf(sessionId: SessionId) {
    const snapshot = this.state(sessionId).snapshot()
    const now = Date.now()
    return {
      ...snapshot,
      participants: snapshot.participants.map((participant) => ({
        ...participant,
        connected:
          participant.connected &&
          now - (this.lastSeen.get(participant.id) ?? participant.joinedAt) < PRESENT_FOR_MS,
      })),
    }
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
    if (ctx.participantId) this.lastSeen.set(ctx.participantId, Date.now())
    switch (command.type) {
      case 'session.create':
        return this.createSession(command)
      case 'session.join':
        return this.join(command, ctx)
      case 'session.sync':
        return { upToSeq: this.store.maxSeq(this.requireSession(ctx)) }
      case 'ticket.create':
        return this.createTicket(command, ctx)
      case 'ticket.join':
        return this.joinTicket(command, ctx)
      case 'ticket.leave':
        return this.leaveTicket(command, ctx)
      case 'ticket.delete':
        return this.deleteTicket(command, ctx)
      case 'ticket.start':
        return this.startTicket(command, ctx)
      case 'ticket.approve':
        return this.approveTicket(command, ctx)
      case 'ticket.verified':
        return this.recordVerification(command, ctx)
      case 'ticket.shipped':
        return this.shipTicket(command, ctx)
      case 'plan.request':
        return this.requestPlan(command, ctx)
      case 'decomposition.propose':
        return this.propose(command, ctx)
      case 'task.assign':
        return this.assign(command, ctx)
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
      case 'usage.report':
        return this.recordUsage(command, ctx)
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
      goal: null,
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
      snapshot: command.fromSeq === null ? this.snapshotOf(sessionId) : null,
    }
  }

  // -- decomposition -------------------------------------------------------

  // -- tickets ---------------------------------------------------------------

  private requireTicket(state: SessionState, ticketId: TicketId): Ticket {
    const ticket = state.tickets.get(ticketId)
    if (!ticket) throw new ServiceError('not_found', `No ticket "${ticketId}".`)
    return ticket
  }

  /**
   * Anyone can open a ticket. The author is in it from the start, and everyone
   * else is told it exists -- as a message, not a directive, because joining is
   * a person's decision and hijacking their agent to make it is not an offer.
   */
  private createTicket(
    command: Extract<ClientCommand, { type: 'ticket.create' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)

    const ticket: Ticket = {
      id: randomUUID() as TicketId,
      sessionId,
      title: command.title,
      body: command.body,
      authorId: participantId,
      members: [participantId],
      state: 'plan',
      verification: null,
      decompositionId: null,
      prNumber: null,
      createdAt: Date.now(),
    }
    this.emit(sessionId, participantId, { type: 'ticket.created', ticket })

    let plannerId: ParticipantId | null = null
    const others = [...state.participants.values()].filter((p) => p.id !== participantId)
    const author = state.participants.get(participantId)?.displayName ?? 'Someone'
    if (others.length > 0) {
      this.systemMessage(
        sessionId,
        participantId,
        others.map((p) => p.id),
        `${author} opened "${ticket.title}". Join it on the board if you want in -- joining is all it takes, there is nothing to approve.`,
      )
    } else {
      // Nobody to wait for. Start splitting it immediately.
      plannerId = this.beginSplit(sessionId, participantId, state, ticket)
    }

    return { ticket: state.tickets.get(ticket.id)!, plannerId }
  }

  /**
   * Opting in. This is the consent step: no approval follows, so joining has to
   * mean "I accept whatever split this produces for me".
   */
  private joinTicket(
    command: Extract<ClientCommand, { type: 'ticket.join' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const ticket = this.requireTicket(state, command.ticketId)

    if (!ticket.members.includes(participantId)) {
      this.emit(sessionId, participantId, {
        type: 'ticket.members',
        ticketId: ticket.id,
        members: [...ticket.members, participantId],
      })
    }

    let plannerId: ParticipantId | null = null
    const joined = this.requireTicket(state, command.ticketId)
    if (joined.state === 'plan') {
      // Somebody wants in, so there is now something to split.
      plannerId = this.beginSplit(sessionId, participantId, state, joined)
    } else if (joined.decompositionId) {
      // Late to a ticket already being built: fold them into the assignment.
      this.rebalanceTicket(sessionId, participantId, state, joined)
    }

    return { ticket: this.requireTicket(state, command.ticketId), plannerId }
  }

  private leaveTicket(
    command: Extract<ClientCommand, { type: 'ticket.leave' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const ticket = this.requireTicket(state, command.ticketId)

    const held = state
      .tasksOfTicket(ticket.id)
      .find((task) => task.ownerId === participantId && task.state !== 'merged')
    if (held) {
      throw new ServiceError(
        'conflict',
        `You are holding ${held.id}. Release or finish it before leaving the ticket.`,
      )
    }

    this.emit(sessionId, participantId, {
      type: 'ticket.members',
      ticketId: ticket.id,
      members: ticket.members.filter((id) => id !== participantId),
    })
    const left = this.requireTicket(state, command.ticketId)
    if (left.decompositionId) this.rebalanceTicket(sessionId, participantId, state, left)
    return { ticket: left }
  }

  /**
   * Throwing a card away, at any stage.
   *
   * Unguarded on purpose: no owner check, no members-only rule, nothing that
   * has to be finished first. A board you cannot delete from silts up with
   * tickets nobody will admit are dead, and asking permission to abandon an
   * idea is exactly the ceremony this is meant to remove.
   *
   * What it does not do is touch git. Branches, commits and anything already
   * merged are untouched -- this removes a card, and saying so plainly is
   * better than a delete that quietly means something narrower than it looks.
   */
  private deleteTicket(
    command: Extract<ClientCommand, { type: 'ticket.delete' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const ticket = this.requireTicket(state, command.ticketId)
    const tasks = state.tasksOfTicket(ticket.id)

    /**
     * Released before the ticket goes, so the log shows the files coming free
     * rather than a lease that simply stops existing. A lease outliving its
     * task would keep denying edits for work nobody can see any more.
     */
    for (const task of tasks) {
      const lease = state.leases.get(task.id)
      if (lease) {
        this.emit(sessionId, participantId, {
          type: 'lease.released',
          taskId: task.id,
          holderId: lease.holderId,
        })
      }
    }

    this.emit(sessionId, participantId, { type: 'ticket.deleted', ticketId: ticket.id })

    const by = state.participants.get(participantId)?.displayName ?? 'Someone'
    const landed = tasks.filter((task) => task.state === 'merged').length
    this.systemMessage(
      sessionId,
      participantId,
      [],
      [
        `${by} deleted "${ticket.title}".`,
        tasks.length > 0
          ? ` ${tasks.length} task(s) went with it${landed > 0 ? `, ${landed} of which had already landed -- that work is still on the branch, it just has no card any more` : ''}.`
          : '',
      ].join(''),
    )

    /**
     * Whoever was working on it finds out from their own agent rather than by
     * noticing the card is gone. Stopping is the whole message; there is no
     * task left to release.
     */
    const working = ticket.members.filter(
      (id) => id !== participantId && state.participants.get(id)?.repoPath,
    )
    if (working.length > 0 && tasks.length > 0) {
      this.systemDirective(
        sessionId,
        participantId,
        working,
        `${by} deleted "${ticket.title}" and its tasks are gone. Stop working on it. Anything you already landed is still on the branch; anything half-done is yours to keep or throw away.`,
      )
    }

    return { ticketId: ticket.id, tasksRemoved: tasks.length }
  }

  private startTicket(
    command: Extract<ClientCommand, { type: 'ticket.start' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const ticket = this.requireTicket(state, command.ticketId)
    /**
     * Pressing this while it is already "splitting" used to do nothing at all,
     * which is the worst possible answer: the card says an agent is reading the
     * repository, the button appears to work, and no work exists. Asking again
     * re-sends the request, which is what someone pressing it means.
     */
    if (ticket.decompositionId) return { ticket, plannerId: null }
    const plannerId = this.beginSplit(sessionId, participantId, state, ticket)
    return { ticket: this.requireTicket(state, command.ticketId), plannerId }
  }

  /**
   * Accepting the split. This is where the work actually begins: tasks are
   * seeded with the arrangement on screen, and every member's agent is told to
   * get on with its own.
   */
  private approveTicket(
    command: Extract<ClientCommand, { type: 'ticket.approve' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const ticket = this.requireTicket(state, command.ticketId)

    if (state.tasksOfTicket(ticket.id).length > 0) return { ticket }
    if (!ticket.decompositionId) {
      throw new ServiceError('not_ready', 'There is no split to start yet.')
    }
    if (!ticket.members.includes(participantId)) {
      throw new ServiceError(
        'forbidden',
        'Join the ticket before starting it -- whoever starts it is agreeing to run it.',
      )
    }

    this.emit(sessionId, participantId, {
      type: 'decomposition.approval',
      participantId,
      approvals: ticket.members,
      satisfied: true,
    })
    this.seedTasks(sessionId, participantId, state)
    this.refreshTicketStates(sessionId, participantId)
    return { ticket: this.requireTicket(state, command.ticketId) }
  }

  /** Who runs the assembled thing: the author if they can, else any member with a checkout. */
  private verifier(state: SessionState, ticket: Ticket): ParticipantId | null {
    if (state.participants.get(ticket.authorId)?.repoPath) return ticket.authorId
    return ticket.members.find((id) => state.participants.get(id)?.repoPath) ?? null
  }

  /**
   * The step between "all the tests pass" and "it works".
   *
   * Each task proved itself in isolation, which is exactly the guarantee a
   * contract-first split is designed to give -- and exactly the one that says
   * nothing about the parts fitting together. So somebody assembles it and
   * drives it the way a person would, in whatever this project actually runs
   * in.
   */
  private askForVerification(
    sessionId: SessionId,
    actorId: ParticipantId,
    state: SessionState,
    ticket: Ticket,
  ): void {
    const who = this.verifier(state, ticket)
    if (!who) return

    const again = ticket.verification && !ticket.verification.passed

    this.systemDirective(
      sessionId,
      actorId,
      [who],
      [
        again
          ? `The fixes for "${ticket.title}" have landed. Last time it was run it failed: ${ticket.verification?.summary}`
          : `Every task on "${ticket.title}" has landed on ${state.session?.contractBranch ?? 'the contract branch'}.`,
        again
          ? 'Run it again, the same way, and check that specific failure is gone:'
          : 'Nobody has run the whole thing yet. Do that now, before it goes anywhere near a PR:',
        '',
        '1. ss_sync, so you have everyone\'s work together.',
        '2. Work out how this project actually runs -- package.json scripts, a dev server, a',
        '   Playwright or Cypress config, docker compose, an Xcode or Android target, a CLI.',
        '   Read the repo rather than assuming; the answer is in there.',
        '3. Start it and exercise the feature end to end, the way a person would. If it is a',
        '   web app, drive the browser. If it is an app, use the simulator or emulator. If it',
        '   is a library or CLI, run the real commands against real input.',
        '4. Look at the seams specifically: each task passed its own tests in isolation, so the',
        '   interesting failures are where the pieces meet.',
        '',
        'Then report with ss_ticket_verified: passed true or false, `how` you exercised it, and',
        'what you saw. Passing sends it to review. Failing reopens work, so it needs `broke`:',
        'the ids of the tasks the failure is on. Leave `broke` out only if you truly cannot tell',
        '-- every task reopens then, and everyone re-does work that was probably fine.',
      ].join('\n'),
    )
  }

  private recordVerification(
    command: Extract<ClientCommand, { type: 'ticket.verified' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const ticket = this.requireTicket(state, command.ticketId)
    const ticketTasks = state.tasksOfTicket(ticket.id)

    /**
     * A failure names tasks or it means all of them. Either way something has
     * to reopen: every task of a ticket in verify is already merged, so with
     * nothing put back the report lands on a board where there is nothing left
     * to claim and nothing to fix -- which is how a broken ticket used to sit
     * in verify forever with a good description of the bug attached to it.
     */
    const named = new Set(command.broke)
    const reopened = command.passed
      ? []
      : ticketTasks.filter((task) => named.size === 0 || named.has(task.id))

    this.emit(sessionId, participantId, {
      type: 'ticket.verified',
      ticketId: ticket.id,
      verification: {
        passed: command.passed,
        how: command.how,
        summary: command.summary,
        broke: reopened.map((task) => task.id),
        by: participantId,
        at: Date.now(),
      },
    })

    for (const task of reopened) {
      this.emit(sessionId, participantId, {
        type: 'task.state',
        taskId: task.id,
        // Unowned rather than handed back to whoever had it: the person who
        // wrote the broken part may not be the one at the keyboard now.
        state: 'ready',
        ownerId: null,
      })
    }
    this.refreshTicketStates(sessionId, participantId)

    const by = state.participants.get(participantId)?.displayName ?? 'Someone'
    if (command.passed) {
      const shipper = this.verifier(state, ticket)
      if (shipper) {
        this.systemDirective(
          sessionId,
          participantId,
          [shipper],
          `"${ticket.title}" was verified by ${by} (${command.how}). Open the pull request with ss_ship, then record its number with ss_ticket_shipped. Leave it open -- merging is not yours to decide.`,
        )
      }
    } else {
      /**
       * A failure goes to everyone who built it, not just whoever found it --
       * the person who ran it rarely owns the file that broke.
       */
      const others = ticket.members.filter((id) => state.participants.get(id)?.repoPath)
      if (others.length > 0) {
        this.systemDirective(
          sessionId,
          participantId,
          others,
          [
            `"${ticket.title}" does not work assembled. ${by} ran it (${command.how}) and saw:`,
            '',
            command.summary,
            '',
            `Reopened, and claimable again: ${reopened.map((task) => task.id).join(', ')}.`,
            named.size === 0
              ? 'The run did not say which task broke it, so all of them are back -- claim yours,'
              : 'Claim yours and fix it:',
            named.size === 0
              ? 'and if it turns out yours is fine, land it straight back with ss_done.'
              : '',
            '  ss_claim -> fix it -> run the acceptance command -> ss_done',
            'Do it now, without waiting to be asked again. When the last one lands, whoever ran',
            'it is asked to run the whole thing again -- that is the loop, and it repeats until',
            'it actually works.',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        )
      }
    }

    return { ticket: this.requireTicket(state, command.ticketId) }
  }

  private shipTicket(
    command: Extract<ClientCommand, { type: 'ticket.shipped' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    const ticket = this.requireTicket(state, command.ticketId)
    this.emit(sessionId, participantId, {
      type: 'ticket.shipped',
      ticketId: ticket.id,
      prNumber: command.prNumber,
    })
    return { ticket: this.requireTicket(state, command.ticketId) }
  }

  /** Hands the ticket to a member's agent to split, and moves the card. */
  private beginSplit(
    sessionId: SessionId,
    actorId: ParticipantId,
    state: SessionState,
    ticket: Ticket,
  ): ParticipantId | null {
    const planner = ticket.members
      .map((id) => state.participants.get(id))
      .find((p) => p?.repoPath && p.connected)

    if (!planner) {
      // Nobody in it can read the repo, so it stays where it is rather than
      // moving to a column where nothing is happening.
      this.systemMessage(
        sessionId,
        actorId,
        ticket.members,
        `"${ticket.title}" cannot be split yet: nobody in it has a checkout attached. Run /ss:join in a clone.`,
      )
      return null
    }

    this.setTicketState(sessionId, actorId, ticket.id, 'splitting')
    this.systemDirective(
      sessionId,
      actorId,
      [planner.id],
      [
        `Split the ticket "${ticket.title}" for ${ticket.members.length} person(s).`,
        ticket.body ? `\n${ticket.body}` : '',
        '',
        'Read the repository, then call ss_propose with:',
        `  ticketId: ${ticket.id}`,
        'a contract of the shared types and stubs every task will import, plus tasks that own',
        'disjoint file globs and are each proved by one command.',
        '',
        'The validator checks it and then it goes on the board for one of them to start,',
        'so propose what you would be willing to have run.',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    )
    return planner.id
  }

  private setTicketState(
    sessionId: SessionId,
    actorId: ParticipantId | null,
    ticketId: TicketId,
    state: TicketState,
  ): void {
    const current = this.state(sessionId).tickets.get(ticketId)
    if (!current || current.state === state) return
    this.emit(sessionId, actorId, { type: 'ticket.state', ticketId, state })
  }

  /** Re-derives every ticket's column from what its tasks are actually doing. */
  private refreshTicketStates(sessionId: SessionId, actorId: ParticipantId | null): void {
    const state = this.state(sessionId)
    for (const ticket of [...state.tickets.values()]) {
      const derived = state.ticketStateFor(ticket.id)
      if (derived !== ticket.state) {
        this.emit(sessionId, actorId, { type: 'ticket.state', ticketId: ticket.id, state: derived })
      }
    }
  }

  /** Assignment across a ticket's members, rather than the whole session. */
  private rebalanceTicket(
    sessionId: SessionId,
    actorId: ParticipantId,
    state: SessionState,
    ticket: Ticket,
  ): void {
    const tasks = state.tasksOfTicket(ticket.id)
    if (tasks.length === 0) return

    const members = ticket.members
      .map((id) => state.participants.get(id))
      .filter((p): p is Participant => Boolean(p?.repoPath))
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => p.id)
    if (members.length === 0) return

    // Anything already being worked on stays where it is.
    const pinned = tasks
      .filter((task) => task.ownerId)
      .map((task) => ({ taskId: task.id, participantId: task.ownerId! }))

    const assignments = autoAssign({ tasks, participants: members, pinned })
    for (const { taskId, participantId } of assignments) {
      const task = state.tasks.get(taskId)
      if (!task || task.assigneeId === participantId || task.state === 'merged') continue
      this.emit(sessionId, actorId, { type: 'task.assigned', taskId, assigneeId: participantId })
    }
  }

  /** A message from the session itself, shown in the room but not acted on. */
  private systemMessage(
    sessionId: SessionId,
    actorId: ParticipantId | null,
    mentions: ParticipantId[],
    body: string,
  ): void {
    const message: ChatMessage = {
      id: randomUUID() as MessageId,
      sessionId,
      authorId: null,
      authorKind: 'system',
      body,
      taskRef: null,
      mentions,
      directive: false,
      createdAt: Date.now(),
    }
    this.emit(sessionId, actorId, { type: 'chat.message', message })
  }

  /**
   * The board's half of planning. It cannot read a repo or run a model, so it
   * does the part it is good at -- capturing the brief and choosing whose agent
   * does the work -- and hands the rest over as a directive, which is the same
   * mechanism the room already uses to drive an agent.
   */
  private requestPlan(
    command: Extract<ClientCommand, { type: 'plan.request' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)

    /**
     * Planning needs a checkout to read. Someone watching from the board with
     * no repo attached cannot do it, and silently picking them would look like
     * the request vanished.
     */
    const candidates = [...state.participants.values()].filter((p) => p.repoPath && p.connected)
    const requested = command.plannerId ? state.participants.get(command.plannerId) : null
    if (command.plannerId && !requested) {
      throw new ServiceError('not_found', 'That participant is not in this session.')
    }
    if (requested && !requested.repoPath) {
      throw new ServiceError(
        'not_ready',
        `${requested.displayName} is watching from the board with no checkout attached, so their Claude Code cannot read the repo. Ask them to run /ss:join in their clone.`,
      )
    }

    const planner =
      requested ??
      candidates.find((p) => p.id === state.session?.leadId) ??
      candidates.find((p) => p.id === participantId) ??
      candidates[0]

    if (!planner) {
      throw new ServiceError(
        'not_ready',
        'Nobody here has a checkout attached, so there is no repo to plan against. Run /ss:host or /ss:join in a clone first.',
      )
    }

    this.emit(sessionId, participantId, {
      type: 'plan.requested',
      goal: command.goal,
      issueRef: command.issueRef,
      plannerId: planner.id,
    })

    const asker = state.participants.get(participantId)?.displayName ?? 'Someone'
    this.systemDirective(
      sessionId,
      participantId,
      [planner.id],
      [
        `${asker} asked for a split of this session, from the board:`,
        '',
        command.goal,
        command.issueRef ? `\nIssue: ${command.issueRef}` : '',
        '',
        'Read the repository, then propose the split with ss_propose: a contract of the shared',
        'types and stubs every task will import, plus tasks that own disjoint file globs and are',
        'each proved by one command. The server validates it and the team approves on the board.',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    )

    return { plannerId: planner.id, goal: command.goal }
  }

  /**
   * A message from the session itself rather than from a person, delivered into
   * the named participants' Claude Code the same way a human directive is.
   */
  private systemDirective(
    sessionId: SessionId,
    actorId: ParticipantId | null,
    mentions: ParticipantId[],
    body: string,
  ): void {
    const message: ChatMessage = {
      id: randomUUID() as MessageId,
      sessionId,
      authorId: null,
      authorKind: 'system',
      body,
      taskRef: null,
      mentions,
      directive: true,
      createdAt: Date.now(),
    }
    this.emit(sessionId, actorId, { type: 'chat.message', message })
  }

  private propose(
    command: Extract<ClientCommand, { type: 'decomposition.propose' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)

    /**
     * No phase gate here. A session hosts tickets for as long as the repo is
     * worked on, and each one plans, builds and ships on its own clock -- so
     * there is no session-wide moment after which planning is over. Whether a
     * particular split is sound is the validator's question, and whether two of
     * them collide is `crossTicketOverlaps`; neither needs a phase.
     */
    const validation = validateDecomposition({
      contract: command.contract,
      tasks: command.tasks,
      participantCount: Math.max(command.participantCount, state.participants.size),
    })

    /**
     * The validator only sees one split at a time, but several tickets run at
     * once -- so two of them can each be internally sound and still send two
     * agents at the same file. The lease gate would catch it, but not until
     * someone tried to claim, by which point the split has been agreed and the
     * work handed out. Cheaper to say so now, while it is still a proposal.
     */
    for (const issue of this.crossTicketOverlaps(state, command.tasks, command.ticketId)) {
      validation.issues.push(issue)
      validation.ok = false
    }

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
        ticketId: command.ticketId,
        issueRef: command.issueRef,
        contract: command.contract,
        tasks: command.tasks,
        participantCount: command.participantCount,
        proposedBy: participantId,
        status: 'proposed',
        approvals: [],
        assignments: [],
        createdAt: Date.now(),
      },
      validation,
    })

    /**
     * Balance it immediately rather than waiting to be asked. An unassigned
     * split leaves the team to negotiate who does what, which is exactly the
     * coordination this is supposed to remove -- and the arrangement is a
     * proposal like everything else here, so it can be dragged around before
     * anyone approves.
     */
    if (!validation.ok) return { decompositionId, validation }

    /**
     * A ticket's split needs no approval: joining the ticket was the consent,
     * so the work starts here. The validator still runs -- whether two agents
     * are about to edit the same file is not a matter of opinion, and no amount
     * of enthusiasm makes an overlap safe.
     */
    const ticketId = command.ticketId
    if (ticketId) {
      const ticket = this.requireTicket(state, ticketId)
      const members = ticket.members
        .map((id) => state.participants.get(id))
        .filter((p): p is Participant => Boolean(p?.repoPath))
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => p.id)

      this.emit(sessionId, participantId, {
        type: 'decomposition.assigned',
        assignments: autoAssign({ tasks: command.tasks, participants: members }),
      })
      /**
       * The split is shown before it runs. Joining agreed to the work, not to
       * whatever shape an agent decided on a minute ago -- and one look at
       * "who ends up with what" is cheap next to two agents rewriting the wrong
       * files. It is one button, pressed by whoever is looking.
       */
      this.setTicketState(sessionId, participantId, ticket.id, 'proposed')
      /**
       * Addressed to the members rather than merely announced, so a session
       * that is running itself can carry on: joining the ticket was the
       * agreement, and waiting for a second one from the same person is the
       * ceremony this is supposed to remove. It is still on the board, and
       * still one click, for anyone who would rather look first.
       */
      this.systemDirective(
        sessionId,
        participantId,
        ticket.members,
        [
          `The split for "${ticket.title}" is ready: ${command.tasks.length} task(s).`,
          'Look it over, change who does what if you disagree, then start it with',
          `ss_ticket_approve (ticketId: ${ticket.id}). Starting it hands everyone their tasks.`,
        ].join('\n'),
      )
      return { decompositionId, validation }
    }

    this.rebalance(sessionId, participantId, state, [])
    return { decompositionId, validation }
  }

  /** Paths already spoken for by another ticket's unfinished work. */
  private crossTicketOverlaps(
    state: SessionState,
    proposed: Array<{ id: TaskId; ownedPaths: string[] }>,
    ticketId: TicketId | null,
  ) {
    const issues = []
    const live = [...state.tasks.values()].filter(
      (task) => task.state !== 'merged' && task.ticketId && task.ticketId !== ticketId,
    )

    for (const spec of proposed) {
      for (const held of live) {
        const collision = spec.ownedPaths.find((glob) =>
          held.ownedPaths.some((other) => globsIntersect(glob, other)),
        )
        if (!collision) continue

        const ticket = held.ticketId ? state.tickets.get(held.ticketId) : null
        issues.push({
          code: 'overlaps_other_ticket' as const,
          severity: 'error' as const,
          message: `"${spec.id}" owns ${collision}, which "${held.id}" already owns on the ticket "${ticket?.title ?? held.ticketId}".`,
          taskIds: [spec.id],
          repairHint: `Scope this ticket away from ${collision}, or wait for "${ticket?.title ?? 'that ticket'}" to land. Two tickets editing one file is the collision the whole split exists to prevent.`,
        })
        break
      }
    }
    return issues
  }

  /** Recomputes the automatic part of the assignment around whatever is pinned. */
  private rebalance(
    sessionId: SessionId,
    actorId: ParticipantId,
    state: SessionState,
    pinned: Array<{ taskId: TaskId; participantId: ParticipantId }>,
  ) {
    /**
     * A ticket's work is shared among the people who joined *it*, not everyone
     * in the session -- otherwise moving one card hands work to someone who
     * never opted in.
     */
    const ticketId = state.decomposition?.ticketId ?? null
    const ticket = ticketId ? state.tickets.get(ticketId) : null
    const eligible = ticket
      ? ticket.members.map((id) => state.participants.get(id))
      : [...state.participants.values()]

    const assignments = autoAssign({
      tasks: state.decomposition?.tasks ?? [],
      // Board-only watchers are left out: work goes to people with a checkout.
      participants: eligible
        .filter((p): p is Participant => Boolean(p?.repoPath))
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => p.id),
      pinned,
    })
    this.emit(sessionId, actorId, { type: 'decomposition.assigned', assignments })
    return assignments
  }

  /**
   * Moving a card. During planning this edits the proposed arrangement; once
   * tasks are live it re-points an unclaimed one, which is how you hand work
   * over without anyone having to release a lease.
   */
  private assign(command: Extract<ClientCommand, { type: 'task.assign' }>, ctx: CommandContext) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)

    if (command.participantId && !state.participants.has(command.participantId)) {
      throw new ServiceError('not_found', 'That participant is not in this session.')
    }

    const live = state.tasks.get(command.taskId)
    if (live) {
      if (live.ownerId && live.ownerId !== command.participantId) {
        throw new ServiceError(
          'conflict',
          `"${live.id}" is already being worked on by ${state.participants.get(live.ownerId)?.displayName ?? 'someone'}. They have to release it first.`,
        )
      }
      this.emit(sessionId, participantId, {
        type: 'task.assigned',
        taskId: command.taskId,
        assigneeId: command.participantId,
      })
      return {
        assignments: [...state.tasks.values()]
          .filter((task) => task.assigneeId)
          .map((task) => ({ taskId: task.id, participantId: task.assigneeId! })),
      }
    }

    const decomposition = state.decomposition
    if (!decomposition?.tasks.some((task) => task.id === command.taskId)) {
      throw new ServiceError('not_found', `No task "${command.taskId}" in this session.`)
    }

    /**
     * Only choices people made are pinned. Everything the balancer decided is
     * recomputed around them, so moving one card redistributes the rest instead
     * of leaving the previous arrangement frozen with one hole in it.
     */
    const pinned = decomposition.assignments
      .filter((a) => a.manual && a.taskId !== command.taskId)
      .concat(
        command.participantId
          ? [{ taskId: command.taskId, participantId: command.participantId, manual: true }]
          : [],
      )

    return { assignments: this.rebalance(sessionId, participantId, state, pinned) }
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
    const assignedTo = new Map(
      (state.decomposition?.assignments ?? []).map((a) => [a.taskId, a.participantId]),
    )

    const tasks: Task[] = specs.map((spec) => ({
      ...spec,
      sessionId,
      ticketId: state.decomposition?.ticketId ?? null,
      state: spec.dependsOn.length === 0 ? 'ready' : 'blocked',
      assigneeId: assignedTo.get(spec.id) ?? null,
      ownerId: null,
      branch: null,
      prNumber: null,
      lastTest: null,
      activityLine: null,
      depth: depthByTask.get(spec.id) ?? 0,
    }))

    this.emit(sessionId, actorId, { type: 'tasks.seeded', tasks })
    this.dispatch(sessionId, actorId, tasks, state)
  }

  /**
   * Approval is the moment the plan becomes work, so it is the moment each
   * person's agent should hear about it. Without this the board would show a
   * finished plan that nobody had been told about, and someone would have to
   * walk over and say "we approved it, run /ss:next".
   */
  private dispatch(
    sessionId: SessionId,
    actorId: ParticipantId,
    tasks: Task[],
    state: SessionState,
  ): void {
    const byAssignee = new Map<ParticipantId, Task[]>()
    for (const task of tasks) {
      if (!task.assigneeId) continue
      byAssignee.set(task.assigneeId, [...(byAssignee.get(task.assigneeId) ?? []), task])
    }

    const contractLanded = Boolean(state.session?.contractBranch)
    for (const [assignee, theirs] of byAssignee) {
      const listed = theirs
        .map((task) => `  ${task.id} -- ${task.title} (${task.estimateMinutes}m)${task.state === 'blocked' ? `, waiting on ${task.dependsOn.join(', ')}` : ''}`)
        .join('\n')

      /**
       * A ticket runs itself. Nobody approved anything and nobody is going to
       * type /ss:next, so the instruction is the whole loop rather than the
       * next step -- otherwise "automatic" means "automatic until the first
       * time someone has to be told to carry on".
       */
      const ticketId = theirs[0]?.ticketId ?? null
      /**
       * Once per ticket rather than once per session: the second ticket brings
       * its own seam, and skipping the landing because an earlier ticket
       * already made the branch leaves everyone importing files that are not
       * there. Landing again is a no-op when nothing changed.
       */
      const lands = Boolean(ticketId) && assignee === actorId

      this.systemDirective(
        sessionId,
        actorId,
        [assignee],
        [
          ticketId
            ? `The split for this ticket is live. ${theirs.length} task(s) are yours:`
            : `The split was approved. ${theirs.length} task(s) are yours:`,
          '',
          listed,
          '',
          ...(ticketId
            ? [
                lands
                  ? 'You started it, so land this ticket\'s contract first: ss_land_contract.'
                  : '',
                lands
                  ? 'Then work them, one at a time and without waiting to be asked:'
                  : 'When the contract lands you will be told. Then work them, one at a time:',
                '  ss_claim -> do the work -> run the acceptance command -> ss_done',
                'Repeat until ss_claim says there is nothing left for you. Post in the room with',
                'ss_chat_post if you get stuck or need a file someone else owns.',
              ]
            : [
                contractLanded
                  ? 'Run ss_next to claim the first one and start.'
                  : 'Nothing is claimable until the contract lands. If you are the lead, run ss_land_contract; otherwise wait for it and then run ss_next.',
              ]),
        ]
          .filter((line) => line !== '')
          .join('\n'),
      )
    }
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
    /**
     * The people who were told to wait are the people who now need to know they
     * can stop waiting. Whoever landed the contract already knows.
     */
    for (const [assignee, theirs] of this.tasksByAssignee(state)) {
      if (assignee === participantId) continue
      const ready = theirs.filter((task) => task.state === 'ready')
      if (ready.length === 0) continue
      this.systemDirective(
        sessionId,
        participantId,
        [assignee],
        `The contract landed on ${command.branch}. Your ${ready.length === 1 ? 'task is' : 'tasks are'} claimable now: ${ready
          .map((task) => task.id)
          .join(', ')}. Run ss_sync then ss_next to start.`,
      )
    }
    return { ok: true as const }
  }

  private tasksByAssignee(state: SessionState): Map<ParticipantId, Task[]> {
    const byAssignee = new Map<ParticipantId, Task[]>()
    for (const task of state.tasks.values()) {
      if (!task.assigneeId) continue
      byAssignee.set(task.assigneeId, [...(byAssignee.get(task.assigneeId) ?? []), task])
    }
    return byAssignee
  }

  // -- tasks and leases ----------------------------------------------------

  private claim(command: Extract<ClientCommand, { type: 'task.claim' }>, ctx: CommandContext) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    if (!state.session?.contractBranch) {
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

    /**
     * Landing work is what wakes up whoever was waiting on it. Telling them is
     * the difference between a DAG that flows and one where each person has to
     * keep checking whether their turn has come.
     */
    const waking = new Map<ParticipantId, TaskId[]>()
    for (const taskId of unblocked) {
      const assignee = state.tasks.get(taskId)?.assigneeId
      if (!assignee || assignee === participantId) continue
      waking.set(assignee, [...(waking.get(assignee) ?? []), taskId])
    }
    for (const [assignee, taskIds] of waking) {
      this.systemDirective(
        sessionId,
        participantId,
        [assignee],
        `${task.id} landed, which unblocks ${taskIds.join(', ')} -- yours. Run ss_sync then ss_next.`,
      )
    }

    /**
     * The cards move because the work moved. This is the whole reason no column
     * is draggable: a board you have to maintain by hand drifts from the truth
     * the moment anyone is busy.
     */
    this.refreshTicketStates(sessionId, participantId)

    const ticketId = task.ticketId
    const ticket = ticketId ? state.tickets.get(ticketId) : null
    /**
     * Asked again every time the ticket comes back to verify, not only the
     * first time. A ticket that failed and was fixed has a verification on it
     * already -- guarding on its mere existence is what made the second lap
     * silent, so a fixed ticket sat there with nobody running it.
     */
    if (
      ticket &&
      state.ticketStateFor(ticket.id) === 'verify' &&
      !ticket.verification?.passed
    ) {
      this.askForVerification(sessionId, participantId, state, ticket)
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
      if (contractFile && state.session?.contractBranch) {
        denials.push({
          path,
          heldBy: null,
          heldByTaskId: null,
          message: `${path} is a contract file and is frozen now that the contract has landed. Raise it in chat -- changing the seam mid-flight breaks every task planned against it.`,
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
      directive: command.directive,
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

  /**
   * Attributed to whatever they are holding, so cost lands on the ticket that
   * caused it rather than in one undifferentiated pile.
   */
  private recordUsage(
    command: Extract<ClientCommand, { type: 'usage.report' }>,
    ctx: CommandContext,
  ) {
    const { sessionId, participantId, state } = this.requireParticipant(ctx)
    if (command.inputTokens + command.outputTokens === 0) return { ok: true as const }

    const held = [...state.tasks.values()].find(
      (task) => task.ownerId === participantId && task.state !== 'merged',
    )
    this.emit(sessionId, participantId, {
      type: 'usage.recorded',
      participantId,
      ticketId: held?.ticketId ?? null,
      inputTokens: command.inputTokens,
      outputTokens: command.outputTokens,
      cacheReadTokens: command.cacheReadTokens,
      cacheCreationTokens: command.cacheCreationTokens,
      turns: command.turns,
    })
    return { ok: true as const }
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

