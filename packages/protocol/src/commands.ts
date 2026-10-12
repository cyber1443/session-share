import { z } from 'zod'
import {
  Assignment,
  Attachment,
  AutopilotMode,
  ChatMessage,
  Contract,
  Ticket,
  HandoffRequest,
  Lease,
  ParticipantActivity,
  Profile,
  DailySummary,
  FollowUp,
  RepoRef,
  SessionSnapshot,
  Sprint,
  SprintState,
  Subticket,
  SubticketState,
  TICKET_BODY_MAX,
  Task,
  TaskSpec,
  TaskState,
  TestResult,
  TicketComment,
  ValidationReport,
} from './domain.js'
import { DecompositionId, MessageId, ParticipantId, SessionId, Seq, TaskId, TicketId, Timestamp } from './ids.js'

/**
 * Client -> server. Every command is request/response (an `ack` carrying the
 * result) and may additionally cause events to be broadcast to the session.
 */
export const ClientCommand = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.create'),
    slug: z.string().min(1),
    title: z.string().min(1),
    repo: RepoRef,
    issueRef: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal('session.join'),
    /** Either works; the plugin has the slug, the board has the id. */
    sessionRef: z.string().min(1),
    /**
     * Ignored. Identity always comes from the credential the caller presented;
     * kept so older clients that still send it are not rejected.
     */
    githubLogin: z.string().min(1).nullish().default(null),
    displayName: z.string().min(1).nullish().default(null),
    /**
     * The checkout being attached. Null when joining from the board with no
     * checkout. Rejected if another connected participant reports the same path.
     */
    repoPath: z.string().min(1).nullable().default(null),
    /**
     * Which machine `repoPath` is on. A checkout is a path on a machine, and
     * each checkout is its own participant -- that is what gives two clones of
     * one person separate leases.
     */
    machineId: z.string().min(1).nullable().default(null),
    /** Replay from here instead of receiving a full snapshot. */
    fromSeq: Seq.nullable().default(null),
  }),
  z.object({ type: z.literal('session.sync'), fromSeq: Seq }),

  /**
   * Anyone can open one, from the board or the terminal. The author joins it
   * automatically; everyone else is told it exists and can opt in.
   */
  z.object({
    type: z.literal('ticket.create'),
    title: z.string().min(1).max(200),
    body: z.string().max(TICKET_BODY_MAX).default(''),
    /** Straight into a sprint rather than the backlog. */
    sprintId: z.string().min(1).nullable().default(null),
    /** Files already uploaded to the session, to go with the brief. */
    attachments: z.array(Attachment).max(20).default([]),
    needsHuman: z.boolean().default(false),
  }),
  /** Adds files to a ticket: more of the brief, or screenshots from a run. */
  z.object({
    type: z.literal('ticket.attach'),
    ticketId: TicketId,
    attachments: z.array(Attachment).min(1).max(20),
  }),
  z.object({ type: z.literal('ticket.needsHuman'), ticketId: TicketId, value: z.boolean() }),
  /**
   * A person has clicked through the running thing. Passing lets it ship;
   * failing is `ticket.verified` with `passed: false`, which reopens work.
   */
  z.object({
    type: z.literal('ticket.humanCheck'),
    ticketId: TicketId,
    passed: z.boolean(),
    note: z.string().max(2000).default(''),
  }),
  /** Asks the caller's own Claude Code to start the ticket's branch locally for them to try. */
  z.object({ type: z.literal('ticket.runLocally'), ticketId: TicketId }),
  /** Opting in. This is the consent step -- there is no separate approval. */
  z.object({ type: z.literal('ticket.join'), ticketId: TicketId }),
  z.object({ type: z.literal('ticket.leave'), ticketId: TicketId }),
  /**
   * Throw the card away, whatever stage it is at. Deliberately unguarded: a
   * board you cannot delete from fills up with things nobody will admit are
   * dead, and needing permission to abandon your own idea is the ceremony this
   * is supposed to remove.
   */
  z.object({ type: z.literal('ticket.delete'), ticketId: TicketId }),
  /** Begin splitting now rather than waiting for someone else to join. */
  z.object({ type: z.literal('ticket.start'), ticketId: TicketId }),
  /**
   * Accept the proposed split and start the work. One click by any member --
   * the point is that a person sees what is about to run before it runs, not
   * that everyone votes.
   */
  z.object({ type: z.literal('ticket.approve'), ticketId: TicketId }),
  /** What running the assembled feature showed. Passing sends it to review. */
  z.object({
    type: z.literal('ticket.verified'),
    ticketId: TicketId,
    passed: z.boolean(),
    how: z.string().max(500),
    summary: z.string().max(2000),
    /** Failing: whose tasks to reopen. Empty reopens the lot. */
    broke: z.array(TaskId).default([]),
    /**
     * What the run turned up that is not this ticket's to fix: unknowns,
     * things that need checking, bugs elsewhere. Each becomes a ticket in the
     * plan column, linked back here. Never started on its own.
     */
    followUps: z.array(FollowUp).max(10).default([]),
  }),
  /** Records the pull request that finished a ticket. */
  z.object({ type: z.literal('ticket.shipped'), ticketId: TicketId, prNumber: z.number().int().nullable().default(null) }),
  /** Rewrite the title or the description. Whatever is left out stays as it is. */
  z.object({
    type: z.literal('ticket.edit'),
    ticketId: TicketId,
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(TICKET_BODY_MAX).optional(),
  }),
  z.object({ type: z.literal('ticket.setDue'), ticketId: TicketId, dueAt: Timestamp.nullable() }),
  /** Plan it into a sprint, or back to the backlog with null. */
  z.object({ type: z.literal('ticket.setSprint'), ticketId: TicketId, sprintId: z.string().min(1).nullable() }),

  z.object({ type: z.literal('subticket.add'), ticketId: TicketId, title: z.string().trim().min(1).max(200) }),
  z.object({
    type: z.literal('subticket.update'),
    ticketId: TicketId,
    subticketId: z.string().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    state: SubticketState.optional(),
  }),
  z.object({ type: z.literal('subticket.join'), ticketId: TicketId, subticketId: z.string().min(1) }),
  z.object({ type: z.literal('subticket.leave'), ticketId: TicketId, subticketId: z.string().min(1) }),
  z.object({ type: z.literal('subticket.remove'), ticketId: TicketId, subticketId: z.string().min(1) }),

  z.object({
    type: z.literal('comment.add'),
    ticketId: TicketId,
    body: z.string().trim().min(1).max(8000),
    asAgent: z.boolean().default(false),
  }),
  /** Only the author can change or remove what they said. */
  z.object({ type: z.literal('comment.edit'), commentId: z.string().min(1), body: z.string().trim().min(1).max(8000) }),
  z.object({ type: z.literal('comment.delete'), commentId: z.string().min(1) }),

  z.object({
    type: z.literal('sprint.create'),
    name: z.string().trim().min(1).max(100),
    goal: z.string().max(2000).default(''),
    startsAt: Timestamp,
    endsAt: Timestamp,
  }),
  /** Change any of it. Starting a sprint is setting its state to active. */
  z.object({
    type: z.literal('sprint.update'),
    sprintId: z.string().min(1),
    name: z.string().trim().min(1).max(100).optional(),
    goal: z.string().max(2000).optional(),
    startsAt: Timestamp.optional(),
    endsAt: Timestamp.optional(),
    state: SprintState.optional(),
  }),
  z.object({ type: z.literal('sprint.delete'), sprintId: z.string().min(1) }),

  /**
   * The caller's own profile. Only ever their own: the login comes from who is
   * asking, so nobody can set a limit on someone else's account.
   */
  z.object({
    type: z.literal('profile.update'),
    /** Weighted units per UTC day; null removes the limit. */
    dailyLimit: z.number().int().min(1_000).max(100_000_000_000).nullable(),
  }),

  /** Take a digest of a UTC day now and ask the host's Claude to write it up. Defaults to today. */
  z.object({ type: z.literal('summary.request'), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null) }),
  /** The write-up for a day, from the Claude that was asked for it. */
  z.object({
    type: z.literal('summary.post'),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    narrative: z.string().trim().min(1).max(8000),
  }),

  /**
   * Ask for a split from the board. Planning needs a repo and a model, neither
   * of which the browser has -- so this hands the brief to a participant's
   * Claude Code, which reads the repo and answers with `decomposition.propose`.
   */
  z.object({
    type: z.literal('plan.request'),
    goal: z.string().min(1).max(4000),
    issueRef: z.string().nullable().default(null),
    /** Whose agent should do it. Null means the session lead. */
    plannerId: ParticipantId.nullable().default(null),
  }),
  z.object({
    type: z.literal('decomposition.propose'),
    contract: Contract,
    tasks: z.array(TaskSpec).min(1),
    participantCount: z.number().int().min(1),
    issueRef: z.string().nullable().default(null),
    /** The ticket being split. Omitted only by the older session-wide flow. */
    ticketId: TicketId.nullable().default(null),
  }),
  /** Move a card to someone, or to nobody. Overrides the automatic split. */
  z.object({
    type: z.literal('task.assign'),
    taskId: TaskId,
    participantId: ParticipantId.nullable(),
  }),
  z.object({ type: z.literal('decomposition.approve'), decompositionId: DecompositionId }),
  z.object({
    type: z.literal('decomposition.reject'),
    decompositionId: DecompositionId,
    reason: z.string().max(500),
  }),
  z.object({
    type: z.literal('contract.committed'),
    branch: z.string().min(1),
    commitSha: z.string().min(1),
    prNumber: z.number().int().nullable().default(null),
    /**
     * Whose contract this is. Left out, the server takes the split the snapshot
     * offers as `decomposition` -- the newest one approved and not yet landed --
     * which is the one a client that does not know about tickets just wrote.
     */
    ticketId: TicketId.nullish(),
  }),

  /** Omit taskId to be handed the best ready task by affinity. */
  z.object({ type: z.literal('task.claim'), taskId: TaskId.nullable().default(null) }),
  z.object({ type: z.literal('task.release'), taskId: TaskId }),
  /**
   * Take a task back from someone who has gone. Only while the holder has not
   * been heard from for a while, and only by the lead or someone on the
   * ticket -- otherwise a laptop closing mid-task strands its files behind a
   * lease nobody can lift.
   */
  z.object({ type: z.literal('task.forceRelease'), taskId: TaskId }),
  z.object({
    type: z.literal('task.progress'),
    taskId: TaskId,
    state: TaskState.nullable().default(null),
    activityLine: z.string().max(120),
  }),
  z.object({ type: z.literal('task.testResult'), taskId: TaskId, result: TestResult }),
  z.object({
    type: z.literal('task.branch'),
    taskId: TaskId,
    branch: z.string().min(1),
    prNumber: z.number().int().nullable().default(null),
  }),
  /**
   * The task's work is in the contract branch. This is what unblocks whatever
   * was waiting on it, so it is the event that actually moves the DAG.
   */
  z.object({ type: z.literal('task.merged'), taskId: TaskId }),

  /** Called by the PreToolUse hook before every Edit/Write. Must be fast. */
  z.object({ type: z.literal('lease.check'), paths: z.array(z.string().min(1)).min(1) }),
  z.object({
    type: z.literal('handoff.request'),
    path: z.string().min(1),
    reason: z.string().max(280).default(''),
  }),
  z.object({
    type: z.literal('handoff.resolve'),
    requestId: z.string().min(1),
    granted: z.boolean(),
  }),

  z.object({
    type: z.literal('chat.post'),
    body: z.string().min(1).max(8000),
    /** Explicit ref; a `#task-id` in the body is also parsed server-side. */
    taskRef: TaskId.nullable().default(null),
    asAgent: z.boolean().default(false),
    /** Deliver this into the other participants' Claude Code sessions. */
    directive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('chat.read'),
    limit: z.number().int().min(1).max(200).default(50),
    beforeSeq: Seq.nullable().default(null),
    taskRef: TaskId.nullable().default(null),
    /**
     * Only messages posted after this one, oldest first. This is how an inbox
     * pages through the room in the server's own order, rather than comparing
     * its clock to the server's.
     */
    afterId: MessageId.nullable().default(null),
  }),

  /**
   * Tokens this participant's own account spent since the last report. Sent by
   * the Stop hook, which is handed the transcript Claude Code just wrote.
   */
  z.object({
    type: z.literal('usage.report'),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().default(0),
    cacheCreationTokens: z.number().int().nonnegative().default(0),
    turns: z.number().int().nonnegative().default(0),
  }),
  z.object({
    type: z.literal('activity.report'),
    activity: ParticipantActivity.omit({ updatedAt: true }),
  }),
  /**
   * A checkout's Claude Code saying it is open and what its autopilot will do,
   * sent on every autopilot poll. It is how a board can tell "their agent will
   * pick this up in a minute" from "it waits until they are back".
   */
  z.object({
    type: z.literal('agent.heartbeat'),
    autopilot: AutopilotMode,
    /**
     * This account has hit its usage limit, so nothing will run here until it
     * resets. Work waiting on this seat is handed to someone who can do it.
     */
    limited: z.boolean().default(false),
  }),
  /** A line for the board's "now": what this checkout's Claude just started doing. */
  z.object({
    type: z.literal('agent.doing'),
    text: z.string().max(200),
  }),
])
export type ClientCommand = z.infer<typeof ClientCommand>
export type CommandType = ClientCommand['type']

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const LeaseDenial = z.object({
  path: z.string(),
  heldBy: ParticipantId.nullable(),
  heldByTaskId: TaskId.nullable(),
  /** Rendered verbatim by the hook into Claude's deny message. */
  message: z.string(),
})
export type LeaseDenial = z.infer<typeof LeaseDenial>

export const LeaseCheckResult = z.object({
  allowed: z.boolean(),
  denials: z.array(LeaseDenial),
})
export type LeaseCheckResult = z.infer<typeof LeaseCheckResult>

export const JoinResult = z.object({
  participantId: ParticipantId,
  sessionId: SessionId,
  /** Present on a cold join; omitted when resuming from `fromSeq`. */
  snapshot: SessionSnapshot.nullable(),
})
export type JoinResult = z.infer<typeof JoinResult>

export const ProposeResult = z.object({
  decompositionId: DecompositionId,
  validation: ValidationReport,
})
export type ProposeResult = z.infer<typeof ProposeResult>

export const ClaimResult = z.object({
  task: Task.nullable(),
  lease: Lease.nullable(),
  /** Why nothing was handed over: everything blocked, or the claim cap is hit. */
  reason: z.string().nullable(),
})
export type ClaimResult = z.infer<typeof ClaimResult>

/** Typed result per command; `ack.data` is validated against this. */
export interface CommandResultMap {
  'session.create': { sessionId: SessionId; slug: string }
  'session.join': JoinResult
  'session.sync': { upToSeq: Seq }
  /** `plannerId` names whoever was asked to split it, when that just happened. */
  'ticket.create': { ticket: Ticket; plannerId: ParticipantId | null }
  'ticket.join': { ticket: Ticket; plannerId: ParticipantId | null }
  'ticket.leave': { ticket: Ticket }
  'ticket.delete': { ticketId: TicketId; tasksRemoved: number }
  'ticket.start': { ticket: Ticket; plannerId: ParticipantId | null }
  'ticket.approve': { ticket: Ticket }
  'ticket.verified': { ticket: Ticket; followUps: Ticket[] }
  'ticket.shipped': { ticket: Ticket }
  'ticket.attach': { ticket: Ticket }
  'ticket.needsHuman': { ticket: Ticket }
  'ticket.humanCheck': { ticket: Ticket }
  'ticket.runLocally': { asked: ParticipantId | null }
  'ticket.edit': { ticket: Ticket }
  'ticket.setDue': { ticket: Ticket }
  'ticket.setSprint': { ticket: Ticket }
  'subticket.add': { subticket: Subticket }
  'subticket.update': { subticket: Subticket }
  'subticket.join': { subticket: Subticket }
  'subticket.leave': { subticket: Subticket }
  'subticket.remove': { ok: true }
  'comment.add': { comment: TicketComment }
  'comment.edit': { comment: TicketComment }
  'comment.delete': { ok: true }
  'sprint.create': { sprint: Sprint }
  'sprint.update': { sprint: Sprint }
  'sprint.delete': { ticketsMoved: number }
  'profile.update': { profile: Profile }
  'summary.request': { summary: DailySummary }
  'summary.post': { summary: DailySummary }
  'plan.request': { plannerId: ParticipantId; goal: string }
  'decomposition.propose': ProposeResult
  'task.assign': { assignments: Assignment[] }
  'decomposition.approve': { approvals: ParticipantId[]; satisfied: boolean }
  'decomposition.reject': { ok: true }
  'contract.committed': { ok: true }
  'task.claim': ClaimResult
  'task.release': { ok: true }
  'task.forceRelease': { ok: true; holderId: ParticipantId }
  'task.progress': { ok: true }
  'task.testResult': { ok: true }
  'task.branch': { ok: true }
  'task.merged': { unblocked: TaskId[] }
  'lease.check': LeaseCheckResult
  'handoff.request': { request: HandoffRequest }
  'handoff.resolve': { ok: true }
  'chat.post': { message: ChatMessage }
  /**
   * `latestId` is the newest message in the room regardless of filters, so a
   * reader can draw a line at "now" in the server's terms.
   */
  'chat.read': { messages: ChatMessage[]; latestId: MessageId | null; cursorFound: boolean }
  /** `overLimit`: this person is past their daily limit, so take on nothing new. */
  'usage.report': { ok: true; overLimit?: boolean }
  'activity.report': { ok: true }
  'agent.heartbeat': { ok: true; overLimit?: boolean }
  'agent.doing': { ok: true }
}

export type CommandResult<T extends CommandType> = CommandResultMap[T]
